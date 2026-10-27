const Customer = require("../models/customer.model");
const ContextSession = require("../models/contextSession.model");
const Quote = require("../models/quote.model");
const OverrideRequest = require("../models/overrideRequest.model");
const AgentCart = require("../models/agentCart.model");
const AgentPin = require("../models/agentPin.model");
const ShoppingList = require("../models/shoppingList.model");
const PaymentLink = require("../models/paymentLink.model");
const AgentScopeGrant = require("../models/agentScopeGrant.model");
const { isAgentRole } = require("./agentAccess.service");
const { notify } = require("./notification.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");

// A customer account is merged into another (spec §12 "customer merged"). It
// is a controlled move, done by the merchant on purpose: the old account stops
// being orderable and points at the surviving one; what can safely move does
// (saved lists, pins, the agents' access), what must not (a cart or a sent quote
// belongs to one customer and can't be moved to another) is closed, and the
// agents who had it are told to start again on the surviving account.

const OPEN_QUOTE = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "ACCEPTED", "CHANGES_REQUESTED"];
const LIVE_OVERRIDES = ["PENDING_APPROVAL", "APPROVED", "AUTO_APPROVED"];

class MergeError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function mergeCustomer({ shop, fromId, intoId, user }) {
  const from = await Customer.findOne({ _id: fromId, shop });
  const into = await Customer.findOne({ _id: intoId, shop });
  if (!from || !into) throw new MergeError("NOT_FOUND", "Customer not found", 404);
  if (String(from._id) === String(into._id)) throw new MergeError("SAME_CUSTOMER", "Choose a different account to merge into");
  if (isAgentRole(from.role) || isAgentRole(into.role)) throw new MergeError("AGENT_ACCOUNT", "Sales agents can't be merged this way");
  if (from.accountStatus === "merged") throw new MergeError("ALREADY_MERGED", "This account was already merged");
  if (into.accountStatus && into.accountStatus !== "active") throw new MergeError("TARGET_NOT_ACTIVE", "The account to keep must be active");
  if (into.erasedAt) throw new MergeError("TARGET_ERASED", "The account to keep was erased");

  const now = new Date();
  const toTell = new Map(); // agent id -> what they had

  const tell = (agentId, key) => {
    const row = toTell.get(String(agentId)) || { quotes: 0, exceptions: 0, carts: 0, links: 0 };
    row[key] += 1;
    toTell.set(String(agentId), row);
  };

  // Anyone ordering for the old account is taken out of it.
  await ContextSession.updateMany({ shop, customer: from._id, revokedAt: null, expiresAt: { $gt: now } }, { $set: { revokedAt: now, revokedReason: "ACCOUNT_MERGED" } });

  // A sent link, an open quote or a waiting exception is for the old account
  // only: closed, with the reason.
  const links = await PaymentLink.find({ shop, customer: from._id, status: "ACTIVE" });
  for (const link of links) {
    link.status = "REVOKED";
    link.revokedAt = now;
    link.activity.push({ at: now, type: "revoked", comment: "ACCOUNT_MERGED" });
    await link.save();
    tell(link.agent, "links");
  }

  const quotes = await Quote.find({ shop, customer: from._id, status: { $in: OPEN_QUOTE } });
  for (const quote of quotes) {
    quote.status = "WITHDRAWN";
    quote.activity.push({ at: now, type: "withdrawn", byKind: "merchant_user", byName: user ? user.name : "Administrator", comment: `The account was merged into ${into.name}. Make a new quote there.` });
    await quote.save();
    tell(quote.ownerAgent, "quotes");
  }

  const exceptions = await OverrideRequest.find({ shop, customer: from._id, status: { $in: LIVE_OVERRIDES } });
  for (const request of exceptions) {
    request.status = "CANCELLED";
    await request.save();
    tell(request.agent, "exceptions");
  }

  const carts = await AgentCart.find({ shop, customer: from._id });
  for (const cart of carts) tell(cart.agent, "carts");
  await AgentCart.deleteMany({ shop, customer: from._id });

  // Saved lists and pins carry nothing customer-specific, so they follow.
  const lists = (await ShoppingList.updateMany({ shop, customer: from._id }, { $set: { customer: into._id } })).modifiedCount;
  let pinsMoved = 0;
  for (const pin of await AgentPin.find({ shop, customer: from._id })) {
    const clash = await AgentPin.findOne({ shop, agent: pin.agent, customer: into._id });
    if (clash) await AgentPin.deleteOne({ _id: pin._id });
    else {
      pin.customer = into._id;
      await pin.save();
      pinsMoved += 1;
    }
  }

  // Agents who could act for the old account can act for the one that stays.
  let grantsCopied = 0;
  for (const grant of await AgentScopeGrant.find({ shop, scopeType: "customer", scopeId: String(from._id) })) {
    const exists = await AgentScopeGrant.findOne({ shop, agent: grant.agent, scopeType: "customer", scopeId: String(into._id), effect: grant.effect });
    if (exists) continue;
    await AgentScopeGrant.create({ shop, agent: grant.agent, scopeType: "customer", scopeId: String(into._id), effect: grant.effect, validFrom: grant.validFrom, validTo: grant.validTo, createdBy: user ? user._id : undefined });
    grantsCopied += 1;
  }

  // What the team knew about the old account is kept with the one that stays.
  if (from.internalNotes) {
    const merged = `${into.internalNotes ? into.internalNotes + "\n" : ""}From ${from.name}: ${from.internalNotes}`;
    into.internalNotes = merged.slice(0, 2000);
    await into.save();
  }

  from.accountStatus = "merged";
  from.mergedInto = into._id;
  await from.save();

  const summary = {
    mergedInto: String(into._id),
    quotesWithdrawn: quotes.length,
    exceptionsCancelled: exceptions.length,
    cartsClosed: carts.length,
    paymentLinksWithdrawn: links.length,
    listsMoved: lists,
    pinsMoved,
    accessCopied: grantsCopied,
  };

  await recordAudit({
    shop,
    actorType: "merchant_user",
    actor: user ? user._id : undefined,
    customer: from._id,
    action: AUDIT_ACTIONS.CUSTOMER_MERGED,
    objectType: "customer",
    objectId: String(from._id),
    metadata: summary,
  });

  for (const [agentId, had] of toTell) {
    const parts = [];
    if (had.quotes) parts.push(`${had.quotes} quote(s)`);
    if (had.exceptions) parts.push(`${had.exceptions} exception(s)`);
    if (had.carts) parts.push(`${had.carts} saved cart(s)`);
    if (had.links) parts.push(`${had.links} payment link(s)`);
    await notify({
      shop,
      recipient: agentId,
      type: "customer.merged",
      title: `${from.company || from.name} was merged into ${into.company || into.name}`,
      body: `Closed: ${parts.join(", ")}. Start again on ${into.company || into.name}.`,
      link: "/account",
      dedupeKey: `merge:${from._id}:${agentId}`,
    });
  }

  return summary;
}

module.exports = { MergeError, mergeCustomer };
