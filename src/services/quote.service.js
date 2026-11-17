const Quote = require("../models/quote.model");
const QuoteVersion = require("../models/quoteVersion.model");
const AgentSettings = require("../models/agentSettings.model");
const Customer = require("../models/customer.model");
const { authorizeAgent } = require("./agentAccess.service");
const { getSettings } = require("./override.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");
const { EVENT_TYPES, emitEvent } = require("./outbox.service");
const { sendQuoteSentEmail, sendQuoteRespondedEmail } = require("./email.service");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 200;
const EDITABLE_AFTER_APPROVAL = "APPROVED";

class QuoteError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.statusCode = status;
  }
}

function personName(person) {
  return person ? person.name || person.email || String(person._id) : undefined;
}

function note(quote, entry) {
  quote.activity.push({ at: new Date(), ...entry });
}

function agentEntry(agent, type, extra = {}) {
  return { type, byKind: "agent", by: agent._id, byName: personName(agent), ...extra };
}

// ---- building a version

function cleanItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new QuoteError("NO_ITEMS", "A quote needs at least one item");
  if (raw.length > MAX_ITEMS) throw new QuoteError("TOO_MANY_ITEMS", `A quote can have at most ${MAX_ITEMS} items`);

  return raw.map((item) => {
    const variantId = String((item && item.variantId) || "").trim();
    const quantity = Number(item && item.quantity);
    const baselineUnit = Number(item && item.baselineUnit);
    const unitPrice = Number(item && item.unitPrice);

    if (!variantId || !Number.isInteger(quantity) || quantity < 1) {
      throw new QuoteError("INVALID_ITEM", "Each item needs a variant and a whole quantity of at least 1");
    }
    if (![baselineUnit, unitPrice].every((n) => Number.isInteger(n) && n >= 0)) {
      throw new QuoteError("INVALID_AMOUNT", "Prices must be whole numbers of minor units");
    }

    return {
      variantId,
      title: String(item.title || "").slice(0, 200),
      sku: String(item.sku || "").slice(0, 100),
      quantity,
      baselineUnit,
      unitPrice,
      overrideId: item.overrideId || undefined,
      lineTotal: quantity * unitPrice,
    };
  });
}

function totalsFor(items) {
  return {
    subtotal: items.reduce((sum, i) => sum + i.lineTotal, 0),
    savings: items.reduce((sum, i) => sum + Math.max(0, (i.baselineUnit - i.unitPrice) * i.quantity), 0),
  };
}

function cleanTerms(input, settings, previous = {}) {
  const validDays =
    input.validDays !== undefined ? Number(input.validDays) : previous.validDays || settings.quoteValidDays;
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) {
    throw new QuoteError("INVALID_TERMS", "validDays must be between 1 and 365");
  }

  return {
    validDays,
    notes: input.notes !== undefined ? String(input.notes).slice(0, 2000) : previous.notes || "",
    internalNotes: input.internalNotes !== undefined ? String(input.internalNotes).slice(0, 2000) : previous.internalNotes || "",
  };
}

async function nextNumber(shop) {
  const settings = await AgentSettings.findOneAndUpdate(
    { shop },
    { $inc: { quoteSeq: 1 }, $setOnInsert: { shop } },
    { new: true, upsert: true }
  );
  return `Q-${String(settings.quoteSeq).padStart(4, "0")}`;
}

async function currentVersion(quote) {
  return QuoteVersion.findOne({ quote: quote._id, version: quote.currentVersion });
}

function needsApproval(version, settings) {
  return settings.quoteApprovalAbove !== null && settings.quoteApprovalAbove !== undefined && version.totals.subtotal >= settings.quoteApprovalAbove;
}

// ---- creating and editing

async function createQuote({ shop, agent, customer, input }) {
  const auth = await authorizeAgent(shop, agent, "quote.create");
  if (!auth.allowed) throw new QuoteError("PERMISSION_DENIED", "Your role can't create quotes", 403);
  if (!customer || !customer.shopifyCustomerId) throw new QuoteError("ACCOUNT_NOT_ELIGIBLE", "This account can't be quoted");

  const settings = await getSettings(shop);
  // Everything is checked before anything is written, so a bad request can't
  // leave half a quote behind.
  const items = cleanItems(input.items);
  const currency = String(input.currency || "").toUpperCase();
  if (!currency) throw new QuoteError("INVALID_CURRENCY", "A currency is required");
  const terms = cleanTerms(input, settings);

  const quote = await Quote.create({
    shop,
    number: await nextNumber(shop),
    customer: customer._id,
    ownerAgent: agent._id,
  });

  const version = await QuoteVersion.create({
    shop,
    quote: quote._id,
    version: 1,
    currency,
    items,
    totals: totalsFor(items),
    terms,
    createdBy: agent._id,
  });

  note(quote, agentEntry(agent, "created", { version: 1 }));
  await quote.save();

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
    customer: customer._id,
    action: AUDIT_ACTIONS.QUOTE_CREATED,
    objectType: "quote",
    objectId: String(quote._id),
    metadata: { number: quote.number, subtotal: version.totals.subtotal, currency },
  });

  return { quote, version };
}

function assertOwner(quote, agent) {
  if (String(quote.ownerAgent) !== String(agent._id)) throw new QuoteError("NOT_FOUND", "Quote not found", 404);
}

function assertMove(quote, to) {
  const { TRANSITIONS } = Quote;
  if (!TRANSITIONS[quote.status].includes(to)) {
    throw new QuoteError(
      "INVALID_TRANSITION",
      `A ${quote.status.toLowerCase().split("_").join(" ")} quote can't become ${to.toLowerCase().split("_").join(" ")}`,
      409
    );
  }
}

// Changing what is quoted. A draft is edited in place; an approved quote is
// not edited — any change starts a new version that needs approval again
// (spec §9.2). A locked version is never changed.
async function editQuote({ shop, quote, agent, input }) {
  assertOwner(quote, agent);

  if (quote.status !== "DRAFT" && quote.status !== EDITABLE_AFTER_APPROVAL) {
    throw new QuoteError("NOT_EDITABLE", "This quote can't be edited. Make a revision instead.", 409);
  }

  const settings = await getSettings(shop);
  let version = await currentVersion(quote);

  if (quote.status === EDITABLE_AFTER_APPROVAL || version.lockedAt) {
    // A new version, carrying over what wasn't changed.
    const next = quote.currentVersion + 1;
    const items = input.items !== undefined ? cleanItems(input.items) : version.items.map((i) => i.toObject());

    version = await QuoteVersion.create({
      shop,
      quote: quote._id,
      version: next,
      currency: version.currency,
      items,
      totals: totalsFor(items),
      terms: cleanTerms(input, settings, version.terms),
      createdBy: agent._id,
    });
    quote.currentVersion = next;
    quote.status = "DRAFT";
    quote.approvalState = "NONE";
    note(quote, agentEntry(agent, "revised", { version: next, comment: "Edited after approval, so it needs approval again" }));
  } else {
    if (input.items !== undefined) {
      version.items = cleanItems(input.items);
      version.totals = totalsFor(version.items);
    }
    version.terms = cleanTerms(input, settings, version.terms);
    await version.save();
    note(quote, agentEntry(agent, "edited", { version: version.version }));
  }

  await quote.save();
  return { quote, version };
}

// A new version of a quote that came back (changes requested, declined,
// rejected, expired). The earlier versions stay as they were.
async function reviseQuote({ shop, quote, agent }) {
  assertOwner(quote, agent);
  assertMove(quote, "DRAFT");

  const version = await currentVersion(quote);
  const next = quote.currentVersion + 1;
  const created = await QuoteVersion.create({
    shop,
    quote: quote._id,
    version: next,
    currency: version.currency,
    items: version.items.map((i) => i.toObject()),
    totals: version.totals,
    terms: version.terms.toObject ? version.terms.toObject() : version.terms,
    createdBy: agent._id,
  });

  quote.currentVersion = next;
  quote.status = "DRAFT";
  quote.approvalState = "NONE";
  quote.expiresAt = undefined;
  note(quote, agentEntry(agent, "revised", { version: next }));
  await quote.save();

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
    customer: quote.customer,
    action: AUDIT_ACTIONS.QUOTE_REVISED,
    objectType: "quote",
    objectId: String(quote._id),
    metadata: { number: quote.number, version: next },
  });

  return { quote, version: created };
}

async function duplicateQuote({ shop, quote, agent }) {
  assertOwner(quote, agent);

  const version = await currentVersion(quote);
  const customer = await Customer.findById(quote.customer);

  return createQuote({
    shop,
    agent,
    customer,
    input: {
      items: version.items.map((i) => i.toObject()),
      currency: version.currency,
      validDays: version.terms.validDays,
      notes: version.terms.notes,
      internalNotes: version.terms.internalNotes,
    },
  });
}

// ---- approval

async function lockVersion(quote) {
  await QuoteVersion.updateOne(
    { quote: quote._id, version: quote.currentVersion, lockedAt: { $exists: false } },
    { $set: { lockedAt: new Date() } }
  );
}

async function submitForApproval({ shop, quote, agent }) {
  assertOwner(quote, agent);
  assertMove(quote, "PENDING_APPROVAL");

  const settings = await getSettings(shop);
  const version = await currentVersion(quote);
  if (!needsApproval(version, settings)) {
    throw new QuoteError("APPROVAL_NOT_REQUIRED", "This quote doesn't need approval. You can send it.", 409);
  }

  await lockVersion(quote);
  quote.status = "PENDING_APPROVAL";
  quote.approvalState = "PENDING";
  note(quote, agentEntry(agent, "submitted", { version: quote.currentVersion }));
  await quote.save();

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
    customer: quote.customer,
    action: AUDIT_ACTIONS.QUOTE_SUBMITTED,
    objectType: "quote",
    objectId: String(quote._id),
    metadata: { number: quote.number, version: quote.currentVersion, subtotal: version.totals.subtotal },
  });

  return quote;
}

// Whether `approver` may decide this quote; a reason code when they may not.
async function approvalBlock({ shop, quote, approver }) {
  approver.actingFor = null;
  approver.delegation = null;

  const direct = await directQuoteBlock({ shop, quote, approver });
  if (direct === null || approver.kind !== "agent" || !approver.agent || approver.noDelegation) return direct;

  // Through a delegation (Phase 4), never for their own quote.
  if (String(approver.agent._id) === String(quote.ownerAgent)) return direct;

  const via = await require("./delegation.service").authorityFor({
    shop,
    delegate: approver.agent,
    memo: (approver.delegationMemo = approver.delegationMemo || {}),
    scope: "quote",
    check: (delegator) => directQuoteBlock({ shop, quote, approver: { kind: "agent", agent: delegator } }),
  });
  if (via.delegation) {
    approver.actingFor = via.delegator;
    approver.delegation = via.delegation;
    return null;
  }
  return via.block === "STEP_UP_REQUIRED" ? via.block : direct;
}

async function directQuoteBlock({ shop, quote, approver }) {
  if (approver.kind === "merchant_user") return null;

  const agent = approver.agent;
  if (!agent) return "NOT_AN_APPROVER";

  const auth = await authorizeAgent(shop, agent, "approval.decide");
  if (!auth.allowed) return auth.stepUpRequired ? "STEP_UP_REQUIRED" : "NOT_AN_APPROVER";

  // Separation of duties (spec §2.4).
  if (String(agent._id) === String(quote.ownerAgent)) return "SELF_APPROVAL_NOT_ALLOWED";

  return null;
}

async function decideQuote({ shop, quoteId, approver, decision, comment }) {
  const quote = await Quote.findOne({ _id: quoteId, shop });
  if (!quote) throw new QuoteError("NOT_FOUND", "Quote not found", 404);
  if (!["approve", "reject"].includes(decision)) throw new QuoteError("INVALID_DECISION", "Decision must be approve or reject");
  assertMove(quote, decision === "approve" ? "APPROVED" : "REJECTED");

  const block = await approvalBlock({ shop, quote, approver });
  if (block) throw new QuoteError(block, "You can't decide this quote", 403);

  const text = String(comment || "").trim();
  if (decision === "reject" && !text) throw new QuoteError("COMMENT_REQUIRED", "A comment is required to reject");

  const isAgent = approver.kind === "agent";
  quote.status = decision === "approve" ? "APPROVED" : "REJECTED";
  quote.approvalState = decision === "approve" ? "APPROVED" : "REJECTED";
  note(quote, {
    type: decision === "approve" ? "approved" : "rejected",
    byKind: approver.kind,
    by: isAgent ? approver.agent._id : approver.user._id,
    byName: isAgent ? personName(approver.agent) : approver.user.name,
    version: quote.currentVersion,
    comment: approver.actingFor ? ((text ? text + " " : "") + "(on behalf of " + personName(approver.actingFor) + ")") : text || undefined,
  });
  await quote.save();

  await recordAudit({
    shop,
    actorType: isAgent ? "sales_agent" : "merchant_user",
    actor: isAgent ? approver.agent._id : approver.user._id,
    actorShopifyCustomerId: isAgent ? approver.agent.shopifyCustomerId : undefined,
    customer: quote.customer,
    action: AUDIT_ACTIONS.QUOTE_DECIDED,
    reasonCode: quote.status,
    objectType: "quote",
    objectId: String(quote._id),
    metadata: {
      number: quote.number,
      version: quote.currentVersion,
      comment: text || undefined,
      onBehalfOf: approver.actingFor ? String(approver.actingFor._id) : undefined,
      delegation: approver.delegation ? String(approver.delegation._id) : undefined,
    },
  });
  if (approver.delegation) await require("./delegation.service").recordUse(approver.delegation);

  return quote;
}

// ---- sending and the buyer's answer

async function sendQuote({ shop, quote, agent }) {
  assertOwner(quote, agent);
  assertMove(quote, "SENT");

  const settings = await getSettings(shop);
  const version = await currentVersion(quote);

  // A quote over the approval line can't skip approval.
  if (quote.status === "DRAFT" && needsApproval(version, settings)) {
    throw new QuoteError("APPROVAL_REQUIRED", "This quote needs a manager's approval before it can be sent", 422);
  }

  await lockVersion(quote);
  const now = new Date();
  quote.status = "SENT";
  quote.sentAt = now;
  // To the end of that day where the merchant does business, when a time zone is set.
  const zone = settings.businessTimezone && settings.businessTimezone !== "UTC" ? settings.businessTimezone : null;
  quote.expiresAt = zone
    ? require("./businessTime").endOfBusinessDay(now, version.terms.validDays, zone)
    : new Date(now.getTime() + version.terms.validDays * DAY_MS);
  note(quote, agentEntry(agent, "sent", { version: quote.currentVersion }));
  await quote.save();

  const customer = await Customer.findById(quote.customer);

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
    customer: quote.customer,
    action: AUDIT_ACTIONS.QUOTE_SENT,
    objectType: "quote",
    objectId: String(quote._id),
    metadata: { number: quote.number, version: quote.currentVersion, expiresAt: quote.expiresAt },
  });
  await emitEvent(shop, EVENT_TYPES.QUOTE_SENT, {
    quote_id: String(quote._id),
    version: quote.currentVersion,
    customer_id: String(quote.customer),
    owner_agent_id: String(quote.ownerAgent),
    expires_at: quote.expiresAt.toISOString(),
  });

  sendQuoteSentEmail({ shop, quote, version, customer, agent }).catch((err) =>
    console.error("[email] quote email failed", err)
  );

  return quote;
}

async function withdrawQuote({ shop, quote, agent }) {
  assertOwner(quote, agent);
  assertMove(quote, "WITHDRAWN");

  quote.status = "WITHDRAWN";
  note(quote, agentEntry(agent, "withdrawn", { version: quote.currentVersion }));
  await quote.save();

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
    customer: quote.customer,
    action: AUDIT_ACTIONS.QUOTE_WITHDRAWN,
    objectType: "quote",
    objectId: String(quote._id),
    metadata: { number: quote.number },
  });

  return quote;
}

const RESPONSES = {
  accept: { to: "ACCEPTED", type: "accepted" },
  decline: { to: "DECLINED", type: "declined" },
  changes: { to: "CHANGES_REQUESTED", type: "changes_requested" },
};

// The buyer answers a sent quote. Acceptance is checked against the expiry in
// the same database step that records it, so a quote that has just expired
// can never be accepted (spec §12 "reject acceptance atomically").
async function respondToQuote({ shop, quoteId, buyerShopifyCustomerId, action, comment }) {
  const response = RESPONSES[action];
  if (!response) throw new QuoteError("INVALID_ACTION", "Choose accept, decline or request changes");

  const quote = await Quote.findOne({ _id: quoteId, shop });
  const customer = quote ? await Customer.findById(quote.customer) : null;
  // Someone else's quote looks the same as a missing one.
  if (!quote || !customer || !buyerShopifyCustomerId || customer.shopifyCustomerId !== String(buyerShopifyCustomerId)) {
    throw new QuoteError("NOT_FOUND", "Quote not found", 404);
  }

  const text = String(comment || "").trim();
  if (action === "changes" && !text) throw new QuoteError("COMMENT_REQUIRED", "Say what you would like changed");

  const settings = await getSettings(shop);
  const now = new Date();
  const set = { status: response.to };
  if (action === "accept") {
    set.acceptedAt = now;
    set.convertBy = new Date(now.getTime() + settings.quoteConvertDays * DAY_MS);
  }

  const updated = await Quote.findOneAndUpdate(
    { _id: quote._id, status: "SENT", expiresAt: { $gt: now } },
    {
      $set: set,
      $push: {
        activity: {
          at: now,
          type: response.type,
          byKind: "buyer",
          by: customer._id,
          byName: personName(customer),
          version: quote.currentVersion,
          comment: text || undefined,
        },
      },
    },
    { new: true }
  );

  if (!updated) {
    if (quote.status === "SENT" && quote.expiresAt && quote.expiresAt <= now) {
      await expireDue(shop, now);
      throw new QuoteError("QUOTE_EXPIRED", "This quote has expired. Ask your sales contact for a new one.", 409);
    }
    throw new QuoteError("NOT_OPEN", "This quote is no longer open for a response", 409);
  }

  await recordAudit({
    shop,
    actorType: "buyer",
    actor: customer._id,
    actorShopifyCustomerId: customer.shopifyCustomerId,
    customer: customer._id,
    action: AUDIT_ACTIONS.QUOTE_RESPONDED,
    reasonCode: response.to,
    objectType: "quote",
    objectId: String(quote._id),
    metadata: { number: quote.number, version: quote.currentVersion, response: action, comment: text || undefined },
  });
  await emitEvent(shop, EVENT_TYPES.QUOTE_RESPONDED, {
    quote_id: String(quote._id),
    version: quote.currentVersion,
    response: action,
    buyer_actor_id: String(customer._id),
    occurred_at: now.toISOString(),
  });

  const owner = await Customer.findById(quote.ownerAgent);
  if (owner) {
    require("./notification.service")
      .notify({
        shop,
        recipient: owner,
        type: "quote.responded",
        title: `${customer.name} ${action === "accept" ? "accepted" : action === "decline" ? "declined" : "asked for changes on"} quote ${quote.number}`,
        body: text || undefined,
        link: "/account",
        dedupeKey: `quote-resp:${quote._id}:${quote.currentVersion}:${action}`,
        email: false,
      })
      .catch(() => {});
    sendQuoteRespondedEmail({ shop, quote: updated, owner, customer, response: action, comment: text }).catch((err) =>
      console.error("[email] quote response email failed", err)
    );
  }

  return updated;
}

// ---- becoming an order

// Called once the order exists. Only an accepted quote still inside its
// conversion window can be converted, and only once.
async function markConverted({ shop, quote, agent, orderId }) {
  assertOwner(quote, agent);
  await expireDue(shop);

  const fresh = await Quote.findById(quote._id);
  assertMove(fresh, "CONVERTED");

  const updated = await Quote.findOneAndUpdate(
    { _id: quote._id, status: "ACCEPTED" },
    {
      $set: { status: "CONVERTED", convertedOrderId: String(orderId) },
      $push: { activity: { at: new Date(), type: "converted", byKind: "agent", by: agent._id, byName: personName(agent), version: quote.currentVersion, comment: String(orderId) } },
    },
    { new: true }
  );
  if (!updated) throw new QuoteError("INVALID_TRANSITION", "This quote can't be converted", 409);

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
    customer: quote.customer,
    action: AUDIT_ACTIONS.QUOTE_CONVERTED,
    objectType: "quote",
    objectId: String(quote._id),
    metadata: { number: quote.number, orderId: String(orderId) },
  });

  return updated;
}

// Moves overdue quotes to EXPIRED: a sent one nobody answered, an accepted
// one that was never turned into an order.
async function expireDue(shop, now = new Date()) {
  const overdue = await Quote.find({
    shop,
    $or: [
      { status: "SENT", expiresAt: { $lte: now } },
      { status: "ACCEPTED", convertBy: { $lte: now } },
    ],
  });

  for (const quote of overdue) {
    const updated = await Quote.findOneAndUpdate(
      { _id: quote._id, status: quote.status },
      {
        $set: { status: "EXPIRED" },
        $push: { activity: { at: now, type: "expired", byKind: "system", version: quote.currentVersion } },
      }
    );
    if (updated) {
      await recordAudit({
        shop,
        actorType: "system",
        customer: quote.customer,
        action: AUDIT_ACTIONS.QUOTE_EXPIRED,
        objectType: "quote",
        objectId: String(quote._id),
        metadata: { number: quote.number, was: quote.status },
      });
    }
  }
}

// ---- reading

async function withVersions(quotes) {
  const versions = await QuoteVersion.find({
    $or: quotes.map((q) => ({ quote: q._id, version: q.currentVersion })),
  });
  const byQuote = new Map(versions.map((v) => [String(v.quote), v]));
  return quotes.map((q) => ({ quote: q, version: byQuote.get(String(q._id)) }));
}

async function listOwned(shop, agent) {
  await expireDue(shop);
  const quotes = await Quote.find({ shop, ownerAgent: agent._id }).sort({ updatedAt: -1 }).limit(100);
  return quotes.length ? withVersions(quotes) : [];
}

async function listForBuyer(shop, buyerShopifyCustomerId) {
  await expireDue(shop);
  const customer = await Customer.findOne({ shop, shopifyCustomerId: String(buyerShopifyCustomerId) });
  if (!customer) return [];

  // The buyer never sees drafts or anything still being approved.
  const quotes = await Quote.find({
    shop,
    customer: customer._id,
    status: { $in: ["SENT", "ACCEPTED", "DECLINED", "CHANGES_REQUESTED", "EXPIRED", "CONVERTED"] },
  })
    .sort({ updatedAt: -1 })
    .limit(100);

  return quotes.length ? withVersions(quotes) : [];
}

async function listPendingApproval(shop, approver) {
  await expireDue(shop);
  const quotes = await Quote.find({ shop, status: "PENDING_APPROVAL" }).sort({ updatedAt: -1 }).limit(100);

  const allowed = [];
  let needsStepUp = false;
  for (const quote of quotes) {
    const block = await approvalBlock({ shop, quote, approver });
    if (block === null) allowed.push(quote);
    else if (block === "STEP_UP_REQUIRED") needsStepUp = true;
  }

  return { items: allowed.length ? await withVersions(allowed) : [], needsStepUp };
}

// What a person is allowed to see of a quote. A buyer never sees internal
// notes, baseline prices or the approval history.
function present({ quote, version }, { forBuyer = false } = {}) {
  const q = quote.toObject();
  const v = version ? version.toObject() : null;

  const out = {
    id: q._id,
    number: q.number,
    status: q.status,
    currentVersion: q.currentVersion,
    approvalState: forBuyer ? undefined : q.approvalState,
    expiresAt: q.expiresAt || null,
    sentAt: q.sentAt || null,
    acceptedAt: q.acceptedAt || null,
    convertBy: forBuyer ? undefined : q.convertBy || null,
    convertedOrderId: forBuyer ? undefined : q.convertedOrderId || null,
    customerId: forBuyer ? undefined : q.customer,
    updatedAt: q.updatedAt,
    createdAt: q.createdAt,
  };

  if (v) {
    out.currency = v.currency;
    out.items = v.items.map((i) => ({
      variantId: i.variantId,
      title: i.title,
      sku: i.sku,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
      ...(forBuyer ? {} : { baselineUnit: i.baselineUnit, overrideId: i.overrideId }),
    }));
    out.totals = forBuyer ? { subtotal: v.totals.subtotal } : v.totals;
    out.terms = forBuyer ? { notes: v.terms.notes, validDays: v.terms.validDays } : v.terms;
    out.locked = !!v.lockedAt;
  }

  out.activity = (q.activity || [])
    .filter((a) => !forBuyer || ["sent", "accepted", "declined", "changes_requested", "expired", "converted"].includes(a.type))
    .map((a) => ({ at: a.at, type: a.type, by: a.byName || null, byKind: a.byKind, version: a.version, comment: forBuyer && a.byKind !== "buyer" ? undefined : a.comment }));

  return out;
}

module.exports = {
  QuoteError,
  createQuote,
  editQuote,
  reviseQuote,
  duplicateQuote,
  submitForApproval,
  decideQuote,
  sendQuote,
  withdrawQuote,
  respondToQuote,
  markConverted,
  expireDue,
  listOwned,
  listForBuyer,
  listPendingApproval,
  currentVersion,
  withVersions,
  present,
  needsApproval,
};
