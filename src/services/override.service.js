const crypto = require("crypto");

const OverrideRequest = require("../models/overrideRequest.model");
const ApprovalPolicy = require("../models/approvalPolicy.model");
const AgentSettings = require("../models/agentSettings.model");
const AgentCart = require("../models/agentCart.model");
const Customer = require("../models/customer.model");
const Order = require("../models/order.model");
const { authorizeAgent, isAgentRole } = require("./agentAccess.service");
const { describe: describeMfa } = require("./mfa.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");
const { EVENT_TYPES, emitEvent } = require("./outbox.service");

// Which role permission governs each kind of exception (spec §8.2), and the
// field of that permission that holds the size an agent may apply alone.
const TYPE_PERMISSION = {
  UNIT_PRICE: "price.override",
  ORDER_DISCOUNT: "discount.override",
  QUANTITY_RULE: "quantity_rule.override",
  SHIPPING_PRICE: "shipping.override",
  CUSTOM_LINE: "custom_line.create",
  ADDRESS: "address.override",
  CREDIT_LIMIT: "credit.override",
  // The whole order waits for a manager before it can be placed (spec §2.2
  // "approval-first"). Its permission is the one that places orders.
  ORDER_APPROVAL: "order.submit",
};
const THRESHOLD_FIELD = { "price.override": "maxDeltaPercent", "discount.override": "maxPercent", "credit.override": "maxOverPercent" };

// Types that are measured against a baseline amount (a reduction in percent).
const PERCENT_TYPES = ["UNIT_PRICE", "ORDER_DISCOUNT", "SHIPPING_PRICE", "QUANTITY_RULE"];
// Types that apply to one cart line.
const LINE_TYPES = ["UNIT_PRICE", "QUANTITY_RULE"];

const REASON_CODES = [
  "VOLUME_COMMITMENT",
  "COMPETITOR_MATCH",
  "LOYALTY",
  "CONTRACT_TERMS",
  "DAMAGED_OR_CLOSEOUT",
  "SERVICE_RECOVERY",
  "OTHER",
];

const HOUR_MS = 60 * 60 * 1000;
const LIVE_STATUSES = ["PENDING_APPROVAL", "APPROVED", "AUTO_APPROVED"];

class OverrideError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.statusCode = status;
  }
}

async function getSettings(shop) {
  return AgentSettings.findOneAndUpdate({ shop }, { $setOnInsert: { shop } }, { new: true, upsert: true });
}

// A fingerprint of what is in the cart, for exceptions that apply to the
// whole order (discount, shipping): any change to the lines makes them stale.
function cartHash(items) {
  const lines = (items || [])
    .map((i) => `${i.variantId}:${i.quantity}`)
    .sort()
    .join("|");
  return crypto.createHash("sha256").update(lines).digest("hex");
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Percent below the baseline (positive = a reduction), or null when there is
// nothing to compare with.
function computeDelta(type, baseline, proposed) {
  // Credit: how far over the available credit the order goes.
  if (type === "CREDIT_LIMIT") {
    return baseline.amount > 0 ? round2(((proposed.amount - baseline.amount) / baseline.amount) * 100) : null;
  }
  if (!PERCENT_TYPES.includes(type)) return null;
  if (!(baseline.amount > 0)) return null;
  return round2(((baseline.amount - proposed.amount) / baseline.amount) * 100);
}

// ---- deciding a request

// Returns the outcome for an exception: { status, denyReason?, route? }.
// Follows spec §8.3: no permission -> DENY; within the agent's own authority
// and no hard rule broken -> AUTO_APPROVE; an approval route exists ->
// PENDING_APPROVAL; otherwise DENY.
async function evaluate({ shop, agent, customer, type, baseline, proposed, delta, settings }) {
  const permission = TYPE_PERMISSION[type];
  // Step-up is decided below, from the size of the exception.
  const auth = await authorizeAgent(shop, agent, permission, { valueBasedStepUp: true });

  if (!auth.allowed) {
    return { status: "DENIED", denyReason: auth.stepUpRequired ? "STEP_UP_REQUIRED" : "PERMISSION_DENIED", auth };
  }

  if (type === "ORDER_APPROVAL") {
    const mode = auth.constraints && auth.constraints.mode;
    if (mode !== "approval_first") return { status: "DENIED", denyReason: "NOT_NEEDED", auth };
    return {
      status: "PENDING_APPROVAL",
      auth,
      route: { policyName: "Order approval", approverRoles: [], slaHours: 24, selfApprovalAllowed: false, selfApprovalMaxPercent: null, commentRequiredAbovePercent: null },
    };
  }

  // Hard rules: no approval can override these.
  if (!customer || !customer.shopifyCustomerId) return { status: "DENIED", denyReason: "ACCOUNT_NOT_ELIGIBLE", auth };
  if (type !== "QUANTITY_RULE" && baseline.currency !== proposed.currency) {
    return { status: "DENIED", denyReason: "CURRENCY_MISMATCH", auth };
  }
  if (["UNIT_PRICE", "ORDER_DISCOUNT"].includes(type) && !(baseline.amount > 0)) {
    return { status: "DENIED", denyReason: "INVALID_BASELINE", auth };
  }
  // A credit exception is for an order that really goes past the credit left.
  if (type === "CREDIT_LIMIT" && !(proposed.amount > baseline.amount)) {
    return { status: "DENIED", denyReason: "NOT_NEEDED", auth };
  }
  if (
    ["UNIT_PRICE", "ORDER_DISCOUNT"].includes(type) &&
    settings.hardFloorPercent != null &&
    proposed.amount < (baseline.amount * settings.hardFloorPercent) / 100
  ) {
    return { status: "DENIED", denyReason: "BELOW_FLOOR", auth };
  }

  // High-value exceptions on a role that uses MFA need a fresh authenticator
  // check (spec §11.1). Small ones don't; ones with no baseline to measure
  // (a custom line) always do. Checked after the hard rules, so a request
  // that would be refused anyway never asks for a code.
  if (auth.role && auth.role.requireMfa && !describeMfa(agent).stepUpValid) {
    const threshold = settings.stepUpAbovePercent;
    const highValue = threshold === null || threshold === undefined || delta === null || delta >= threshold;
    if (highValue) return { status: "DENIED", denyReason: "STEP_UP_REQUIRED", auth };
  }

  const limit = auth.constraints ? auth.constraints[THRESHOLD_FIELD[permission]] : undefined;
  const within = delta === null || limit === undefined || limit === null || delta <= limit;
  if (within) return { status: "AUTO_APPROVED", auth };

  // Over the agent's own authority: find an approval route.
  const policies = await ApprovalPolicy.find({
    shop,
    active: true,
    overrideType: { $in: [type, "ANY"] },
  }).sort({ priority: 1, createdAt: 1 });

  if (policies.length === 0) {
    // No rules configured: anyone allowed to approve whose limit covers it.
    return {
      status: "PENDING_APPROVAL",
      auth,
      route: {
        policyName: "Default",
        approverRoles: [],
        slaHours: 24,
        selfApprovalAllowed: false,
        selfApprovalMaxPercent: null,
        commentRequiredAbovePercent: null,
      },
    };
  }

  const fit = policies.find((p) => p.maxDeltaPercent === null || delta === null || delta <= p.maxDeltaPercent);
  if (!fit) return { status: "DENIED", denyReason: "NO_APPROVAL_ROUTE", auth };
  if (fit.effect === "deny") return { status: "DENIED", denyReason: "POLICY_DENY", auth };

  return {
    status: "PENDING_APPROVAL",
    auth,
    route: {
      policyId: fit._id,
      policyName: fit.name,
      approverRoles: fit.approverRoles,
      slaHours: fit.slaHours,
      selfApprovalAllowed: fit.selfApprovalAllowed,
      selfApprovalMaxPercent: fit.selfApprovalMaxPercent,
      commentRequiredAbovePercent: fit.commentRequiredAbovePercent,
    },
  };
}

function validateInput(input) {
  const { type, baseline, proposed, reasonCode, reasonText } = input;

  if (!TYPE_PERMISSION[type]) throw new OverrideError("INVALID_TYPE", "Unknown exception type");

  for (const [name, money] of [["baseline", baseline], ["proposed", proposed]]) {
    if (!money || !Number.isInteger(money.amount) || money.amount < 0 || !money.currency) {
      throw new OverrideError("INVALID_AMOUNT", `${name} needs a whole number of minor units and a currency`);
    }
  }

  if (!REASON_CODES.includes(reasonCode)) throw new OverrideError("INVALID_REASON", "Choose a reason");
  if (!String(reasonText || "").trim()) throw new OverrideError("REASON_REQUIRED", "A written reason is required");
}

// Creates an exception request and decides it straight away where policy
// allows. The baseline must come from the server-side price resolution, never
// from the browser.
async function requestOverride({ shop, agent, customer, context, input }) {
  validateInput(input);

  const settings = await getSettings(shop);
  const cart = await AgentCart.findOne({ shop, agent: agent._id, customer: customer._id });

  let lineVariantId;
  let snapshot = {};
  let custom;

  let rule;
  let address;

  if (input.type === "CUSTOM_LINE") {
    // Not tied to a cart line: a described item with a quantity and a price.
    const title = String((input.custom && input.custom.title) || "").trim();
    const quantity = Number(input.custom && input.custom.quantity);
    if (!title || title.length > 120) throw new OverrideError("INVALID_CUSTOM_LINE", "Describe the item (up to 120 characters)");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      throw new OverrideError("INVALID_CUSTOM_LINE", "Quantity must be a whole number from 1 to 9999");
    }

    // Spec §2.2: a custom line needs its tax treatment. Taxable items need a
    // tax code; the accounting code is optional.
    const taxable = !(input.custom && input.custom.taxable === false);
    const taxCode = String((input.custom && input.custom.taxCode) || "").trim();
    const accountingCode = String((input.custom && input.custom.accountingCode) || "").trim();
    if (taxable && !taxCode) throw new OverrideError("TAX_CODE_REQUIRED", "A taxable custom line needs a tax code");
    if (taxCode.length > 40 || accountingCode.length > 40) throw new OverrideError("INVALID_CUSTOM_LINE", "Codes can be up to 40 characters");

    if (!cart || cart.items.length === 0) throw new OverrideError("CART_EMPTY", "The customer's cart is empty");
    custom = { title, quantity, taxable, taxCode: taxCode || undefined, accountingCode: accountingCode || undefined };
    snapshot = { quantity };
  } else if (input.type === "ADDRESS") {
    // A delivery address used for this order only. It is never added to the
    // customer's address book.
    const a = input.address || {};
    const clean = (v, max) => String(v ?? "").trim().slice(0, max);
    address = {
      company: clean(a.company, 80),
      address1: clean(a.address1, 120),
      address2: clean(a.address2, 120),
      city: clean(a.city, 80),
      provinceCode: clean(a.provinceCode, 10).toUpperCase(),
      zip: clean(a.zip, 20),
      countryCode: clean(a.countryCode, 10).toUpperCase(),
      phone: clean(a.phone, 30),
    };
    if (!address.address1 || !address.city || !address.zip || !/^[A-Z]{2}$/.test(address.countryCode)) {
      throw new OverrideError("INVALID_ADDRESS", "The address needs a street, city, postal code and a 2-letter country code");
    }
    if (!cart || cart.items.length === 0) throw new OverrideError("CART_EMPTY", "The customer's cart is empty");
  } else if (LINE_TYPES.includes(input.type)) {
    lineVariantId = String(input.lineVariantId || "");
    const line = cart && cart.items.find((i) => i.variantId === lineVariantId);
    if (!lineVariantId || !line) throw new OverrideError("LINE_NOT_IN_CART", "That item isn't in the customer's cart");
    snapshot = { variantId: line.variantId, quantity: line.quantity };
    if (input.type === "QUANTITY_RULE") rule = input.rule === "INCREMENT" ? "INCREMENT" : "MOQ";
  } else {
    if (!cart || cart.items.length === 0) throw new OverrideError("CART_EMPTY", "The customer's cart is empty");
    snapshot = { cartHash: cartHash(cart.items) };
  }

  const baseline = { amount: input.baseline.amount, currency: String(input.baseline.currency).toUpperCase() };
  const proposed = { amount: input.proposed.amount, currency: String(input.proposed.currency).toUpperCase() };
  const delta = computeDelta(input.type, baseline, proposed);

  const outcome = await evaluate({ shop, agent, customer, type: input.type, baseline, proposed, delta, settings });

  const now = new Date();
  const doc = await OverrideRequest.create({
    shop,
    agent: agent._id,
    customer: customer._id,
    context: context ? context._id : undefined,
    cart: cart ? cart._id : undefined,
    type: input.type,
    permission: TYPE_PERMISSION[input.type],
    lineVariantId,
    snapshot,
    custom,
    rule,
    address,
    baseline,
    proposed,
    deltaPercent: delta,
    reasonCode: input.reasonCode,
    reasonText: String(input.reasonText).trim(),
    status: outcome.status,
    denyReason: outcome.denyReason,
    policyVersion: outcome.auth && outcome.auth.role ? outcome.auth.role.version : undefined,
    route: outcome.route,
    expiresAt: outcome.status === "DENIED" ? undefined : new Date(now.getTime() + settings.requestTtlHours * HOUR_MS),
  });

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
    customer: customer._id,
    contextId: context ? context._id : undefined,
    action: AUDIT_ACTIONS.OVERRIDE_REQUESTED,
    outcome: outcome.status === "DENIED" ? "denied" : "success",
    reasonCode: outcome.denyReason || outcome.status,
    objectType: "override_request",
    objectId: String(doc._id),
    metadata: {
      type: doc.type,
      baseline: doc.baseline,
      proposed: doc.proposed,
      deltaPercent: doc.deltaPercent,
      reasonCode: doc.reasonCode,
      status: doc.status,
    },
  });

  await emitEvent(shop, EVENT_TYPES.OVERRIDE_REQUESTED, {
    override_id: String(doc._id),
    type: doc.type,
    object_id: doc.cart ? String(doc.cart) : null,
    baseline: doc.baseline,
    proposed: doc.proposed,
    requester: String(agent._id),
    policy_version: doc.policyVersion || null,
  });

  if (doc.status === "AUTO_APPROVED" || doc.status === "DENIED") {
    await emitEvent(shop, EVENT_TYPES.OVERRIDE_DECIDED, {
      override_id: String(doc._id),
      decision: doc.status === "DENIED" ? "deny" : "auto_approve",
      approver: "policy",
      reason: doc.denyReason || "Within the agent's own authority",
      decided_at: new Date().toISOString(),
    });
  }

  return doc;
}

// ---- approving

function agentDisplayName(agent) {
  return agent.name || agent.email || String(agent._id);
}

// Whether `approver` may decide `request`. Returns null when they may, or a
// reason code when they may not. Kept in one place so the pending list and
// the decision itself can never disagree.
async function approvalBlock({ shop, request, approver }) {
  approver.actingFor = null;
  approver.delegation = null;

  const direct = await directBlock({ shop, request, approver });
  if (direct === null || approver.kind !== "agent" || !approver.agent || approver.noDelegation) return direct;

  // Not allowed in their own right: perhaps through a delegation (Phase 4).
  // Never for their own request, and only as far as the delegator could decide it.
  if (String(approver.agent._id) === String(request.agent)) return direct;

  const via = await require("./delegation.service").authorityFor({
    shop,
    delegate: approver.agent,
    memo: (approver.delegationMemo = approver.delegationMemo || {}),
    scope: "override",
    check: (delegator) => directBlock({ shop, request, approver: { kind: "agent", agent: delegator } }),
  });
  if (via.delegation) {
    approver.actingFor = via.delegator;
    approver.delegation = via.delegation;
    return null;
  }
  return via.block === "STEP_UP_REQUIRED" ? via.block : direct;
}

async function directBlock({ shop, request, approver }) {
  if (approver.kind === "merchant_user") return null;

  const agent = approver.agent;
  if (!agent || !isAgentRole(agent.role)) return "NOT_AN_APPROVER";

  const auth = await authorizeAgent(shop, agent, "approval.decide");
  if (!auth.allowed) return auth.stepUpRequired ? "STEP_UP_REQUIRED" : "NOT_AN_APPROVER";

  const roles = (request.route && request.route.approverRoles) || [];
  if (roles.length && !roles.includes(agent.role)) return "NOT_AN_APPROVER";

  // An approver can only decide exceptions within their own approval limit; an
  // exception with no size (a custom line) needs an approver without a limit.
  const limit = auth.constraints ? auth.constraints.maxDeltaPercent : undefined;
  if (limit !== undefined && limit !== null && request.type !== "ORDER_APPROVAL") {
    if (request.deltaPercent === null || request.deltaPercent > limit) return "ABOVE_APPROVAL_LIMIT";
  }

  // Separation of duties (spec §2.4): not your own exception, unless the
  // policy explicitly allows it up to a stated size.
  if (String(agent._id) === String(request.agent)) {
    const route = request.route || {};
    const selfOk =
      route.selfApprovalAllowed &&
      route.selfApprovalMaxPercent !== null &&
      route.selfApprovalMaxPercent !== undefined &&
      request.deltaPercent !== null &&
      request.deltaPercent <= route.selfApprovalMaxPercent;
    if (!selfOk) return "SELF_APPROVAL_NOT_ALLOWED";
  }

  return null;
}

// Is the exception still about what is in the cart? If not it is marked
// INVALIDATED (spec §8.4).
async function stillMatchesCart(request) {
  if (!request.cart) return true;
  // A custom line and a one-off address stand on their own; the rest of the
  // cart can change.
  if (request.type === "CUSTOM_LINE" || request.type === "ADDRESS") return true;
  // (An order approval is tied to the cart as it was: the cart hash below.)

  const cart = await AgentCart.findById(request.cart);
  if (!cart) return false;

  if (request.lineVariantId) {
    const line = cart.items.find((i) => i.variantId === request.lineVariantId);
    return !!line && line.quantity === request.snapshot.quantity;
  }

  return cartHash(cart.items) === request.snapshot.cartHash;
}

async function invalidate(request, reason) {
  request.status = "INVALIDATED";
  request.invalidatedReason = reason;
  await request.save();

  await recordAudit({
    shop: request.shop,
    actorType: "system",
    customer: request.customer,
    action: AUDIT_ACTIONS.OVERRIDE_INVALIDATED,
    reasonCode: reason,
    objectType: "override_request",
    objectId: String(request._id),
  });
}

// Moves overdue requests to EXPIRED.
async function expireDue(shop, now = new Date()) {
  return OverrideRequest.updateMany(
    { shop, status: { $in: LIVE_STATUSES }, expiresAt: { $lt: now } },
    { $set: { status: "EXPIRED" } }
  );
}

// An approver approves or rejects. `approver` is
// { kind: "agent", agent } or { kind: "merchant_user", user }.
async function decide({ shop, requestId, approver, decision, comment }) {
  await expireDue(shop);

  const request = await OverrideRequest.findOne({ _id: requestId, shop });
  if (!request) throw new OverrideError("NOT_FOUND", "Request not found", 404);
  if (request.status !== "PENDING_APPROVAL") {
    throw new OverrideError("NOT_PENDING", `This request is ${request.status.toLowerCase().replace("_", " ")}`, 409);
  }

  if (!["approve", "reject"].includes(decision)) throw new OverrideError("INVALID_DECISION", "Decision must be approve or reject");

  const block = await approvalBlock({ shop, request, approver });
  if (block) throw new OverrideError(block, "You can't decide this request", 403);

  if (!(await stillMatchesCart(request))) {
    await invalidate(request, "CART_CHANGED");
    throw new OverrideError("INVALIDATED", "The cart changed after this was requested", 409);
  }

  const text = String(comment || "").trim();
  const above = request.route && request.route.commentRequiredAbovePercent;
  if (decision === "reject" && !text) throw new OverrideError("COMMENT_REQUIRED", "A comment is required to reject");
  if (decision === "approve" && above !== null && above !== undefined && request.deltaPercent > above && !text) {
    throw new OverrideError("COMMENT_REQUIRED", "A comment is required to approve an exception this large");
  }

  const isAgent = approver.kind === "agent";
  const settings = await getSettings(shop);
  const now = new Date();

  request.decisions.push({
    kind: approver.kind,
    by: isAgent ? approver.agent._id : approver.user._id,
    name: isAgent ? agentDisplayName(approver.agent) : approver.user.name,
    decision,
    comment: text,
    at: now,
    onBehalfOf: approver.actingFor ? approver.actingFor._id : undefined,
    onBehalfOfName: approver.actingFor ? agentDisplayName(approver.actingFor) : undefined,
  });
  request.status = decision === "approve" ? "APPROVED" : "REJECTED";
  // An approval is only good for a while.
  if (decision === "approve") request.expiresAt = new Date(now.getTime() + settings.requestTtlHours * HOUR_MS);
  await request.save();

  await recordAudit({
    shop,
    actorType: isAgent ? "sales_agent" : "merchant_user",
    actor: isAgent ? approver.agent._id : approver.user._id,
    actorShopifyCustomerId: isAgent ? approver.agent.shopifyCustomerId : undefined,
    customer: request.customer,
    action: AUDIT_ACTIONS.OVERRIDE_DECIDED,
    reasonCode: request.status,
    objectType: "override_request",
    objectId: String(request._id),
    metadata: {
      type: request.type,
      baseline: request.baseline,
      proposed: request.proposed,
      deltaPercent: request.deltaPercent,
      requester: String(request.agent),
      comment: text || undefined,
      onBehalfOf: approver.actingFor ? String(approver.actingFor._id) : undefined,
      delegation: approver.delegation ? String(approver.delegation._id) : undefined,
    },
  });
  if (approver.delegation) await require("./delegation.service").recordUse(approver.delegation);

  // The requester hears the outcome and the reason (spec §10.2).
  require("./notification.service")
    .notify({
      shop,
      recipient: request.agent,
      type: "approval.decided",
      title: decision === "approve" ? "Your exception was approved" : "Your exception was rejected",
      body: text ? `${agentDisplayName(isAgent ? approver.agent : { name: approver.user.name })}: ${text}` : undefined,
      link: "/account",
      dedupeKey: `appr-decided:${request._id}`,
    })
    .catch(() => {});

  await emitEvent(shop, EVENT_TYPES.OVERRIDE_DECIDED, {
    override_id: String(request._id),
    decision,
    approver: String(isAgent ? approver.agent._id : approver.user._id),
    on_behalf_of: approver.actingFor ? String(approver.actingFor._id) : null,
    reason: text || null,
    decided_at: now.toISOString(),
  });

  return request;
}

// The requester withdraws their own exception.
async function cancel({ shop, requestId, agent }) {
  const request = await OverrideRequest.findOne({ _id: requestId, shop, agent: agent._id });
  if (!request) throw new OverrideError("NOT_FOUND", "Request not found", 404);
  if (!LIVE_STATUSES.includes(request.status)) {
    throw new OverrideError("NOT_CANCELLABLE", `This request is ${request.status.toLowerCase().replace("_", " ")}`, 409);
  }

  request.status = "CANCELLED";
  await request.save();

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
    customer: request.customer,
    action: AUDIT_ACTIONS.OVERRIDE_CANCELLED,
    objectType: "override_request",
    objectId: String(request._id),
  });

  return request;
}

// Called whenever a saved cart changes: exceptions that no longer match it are
// invalidated, so an old approval can never be reused on a different order.
async function invalidateForCart(shop, cart) {
  const open = await OverrideRequest.find({ shop, cart: cart._id, status: { $in: LIVE_STATUSES } });

  for (const request of open) {
    if (!(await stillMatchesCart(request))) await invalidate(request, "CART_CHANGED");
  }
}

// Exceptions that can be used on this customer's order right now.
async function usableForCart({ shop, agent, customer }) {
  await expireDue(shop);

  const cart = await AgentCart.findOne({ shop, agent: agent._id, customer: customer._id });
  if (!cart) return [];

  const candidates = await OverrideRequest.find({
    shop,
    agent: agent._id,
    customer: customer._id,
    cart: cart._id,
    status: { $in: ["AUTO_APPROVED", "APPROVED"] },
  });

  const usable = [];
  for (const request of candidates) {
    if (await stillMatchesCart(request)) usable.push(request);
    else await invalidate(request, "CART_CHANGED");
  }
  return usable;
}

// Pending requests this approver is allowed to decide, newest first.
// `needsStepUp` is true when some are held back only because the approver
// has to confirm with their authenticator first, so the screen can ask.
async function pendingFor({ shop, approver }) {
  await expireDue(shop);

  const pending = await OverrideRequest.find({ shop, status: "PENDING_APPROVAL" })
    .sort({ createdAt: -1 })
    .limit(200);

  const requests = [];
  let needsStepUp = false;

  for (const request of pending) {
    const block = await approvalBlock({ shop, request, approver });
    if (block === null) requests.push(request);
    else if (block === "STEP_UP_REQUIRED") needsStepUp = true;
  }

  return { requests, needsStepUp };
}

// Adds the names an approver needs to read a request (spec §8.4: baseline,
// requested value, reason, requester, customer).
// How much price an exception gives away (spec §8.4 "margin impact"). Product
// cost isn't tracked, so this is the reduction against the baseline, not a
// margin: per unit, for the line as ordered, and as a percent.
function priceImpact(r) {
  if (!["UNIT_PRICE", "ORDER_DISCOUNT", "SHIPPING_PRICE"].includes(r.type)) return null;

  const perUnit = r.baseline.amount - r.proposed.amount;
  const quantity = r.type === "UNIT_PRICE" && r.snapshot && r.snapshot.quantity ? r.snapshot.quantity : 1;
  return { perUnit, total: perUnit * quantity, percent: r.deltaPercent, currency: r.baseline.currency, costTracked: false };
}

// What the customer has done before (spec §8.4 "customer history"): orders
// placed, what they spent, and how earlier exceptions for them went.
async function customerHistory(shop, customer) {
  const since = new Date(Date.now() - 90 * 24 * HOUR_MS);

  const orderRows = customer && customer.shopifyCustomerId
    ? await Order.aggregate([
        { $match: { shop, shopifyCustomerId: customer.shopifyCustomerId } },
        { $sort: { orderedAt: 1 } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$totalPrice" }, last: { $last: "$orderedAt" }, currency: { $last: "$currency" } } },
      ])
    : [];
  const o = orderRows[0];

  const statusRows = customer
    ? await OverrideRequest.aggregate([
        { $match: { shop, customer: customer._id, createdAt: { $gte: since }, status: { $ne: "CANCELLED" } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ])
    : [];
  const count = (...names) => statusRows.filter((s) => names.includes(s._id)).reduce((n, s) => n + s.count, 0);

  return {
    orders: o ? o.count : 0,
    orderTotal: o ? Math.round(o.total * 100) : 0,
    currency: o ? o.currency : null,
    lastOrderAt: o ? o.last : null,
    exceptions90d: {
      total: statusRows.reduce((n, s) => n + s.count, 0),
      approved: count("APPROVED", "AUTO_APPROVED", "APPLIED"),
      rejected: count("REJECTED", "DENIED"),
    },
  };
}

async function describeRequests(requests) {
  const ids = [...new Set(requests.flatMap((r) => [String(r.agent), String(r.customer)]))];
  const people = await Customer.find({ _id: { $in: ids } }).select("name email company shopifyCustomerId");
  const byId = new Map(people.map((p) => [String(p._id), p]));
  const histories = new Map();

  const out = [];
  for (const r of requests) {
    const agent = byId.get(String(r.agent));
    const customer = byId.get(String(r.customer));
    const key = String(r.customer);
    if (!histories.has(key)) histories.set(key, await customerHistory(r.shop, customer));

    out.push({
      ...r.toObject(),
      agentName: agent ? agent.name : null,
      customerName: customer ? customer.name : null,
      customerCompany: customer ? customer.company || null : null,
      impact: priceImpact(r),
      history: histories.get(key),
    });
  }
  return out;
}

module.exports = {
  TYPE_PERMISSION,
  REASON_CODES,
  OverrideError,
  getSettings,
  cartHash,
  requestOverride,
  decide,
  cancel,
  expireDue,
  invalidateForCart,
  usableForCart,
  pendingFor,
  describeRequests,
  approvalBlock,
};
