const Customer = require("../models/customer.model");
const ContextSession = require("../models/contextSession.model");
const Notification = require("../models/notification.model");
const Quote = require("../models/quote.model");
const QuoteVersion = require("../models/quoteVersion.model");
const AgentCart = require("../models/agentCart.model");
const OfflineCapture = require("../models/offlineCapture.model");
const ShoppingList = require("../models/shoppingList.model");
const AgentPin = require("../models/agentPin.model");
const OverrideRequest = require("../models/overrideRequest.model");
const Order = require("../models/order.model");
const LegalHold = require("../models/legalHold.model");
const DataSubjectRequest = require("../models/dataSubjectRequest.model");
const AgentSettings = require("../models/agentSettings.model");
const { isAgentRole } = require("./agentAccess.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");

// Retention schedules, legal holds and data-subject requests (spec §11.2).
//
// The audit trail is not on a schedule: it is append-only and hash-chained, and
// the spec asks for immutable retention, so it is kept. A schedule covers the
// working records around it: finished contexts, old notifications, closed
// quotes and carts nobody has touched. A hold on a customer (or on the whole
// shop) stops every one of them, and an erasure request too.

const CLOSED_QUOTES = ["REJECTED", "DECLINED", "EXPIRED", "WITHDRAWN", "CONVERTED"];
const DAY = 24 * 60 * 60 * 1000;

const DEFAULTS = { contextsDays: 365, notificationsDays: 180, closedQuotesDays: 730, inactiveCartsDays: 180 };

async function getPolicy(shop) {
  const s = await AgentSettings.findOne({ shop }).select("retention").lean();
  const r = (s && s.retention) || {};
  return {
    autoPurge: r.autoPurge === true,
    contextsDays: r.contextsDays || DEFAULTS.contextsDays,
    notificationsDays: r.notificationsDays || DEFAULTS.notificationsDays,
    closedQuotesDays: r.closedQuotesDays || DEFAULTS.closedQuotesDays,
    inactiveCartsDays: r.inactiveCartsDays || DEFAULTS.inactiveCartsDays,
  };
}

// Who is held: everyone (a shop-wide hold), or these customers.
async function heldCustomers(shop) {
  const holds = await LegalHold.find({ shop, releasedAt: null }).lean();
  if (holds.some((h) => h.scope === "shop")) return { all: true, ids: [] };
  return { all: false, ids: holds.filter((h) => h.customer).map((h) => h.customer) };
}

async function isHeld(shop, customerId) {
  const held = await heldCustomers(shop);
  return held.all || held.ids.some((id) => String(id) === String(customerId));
}

// Deletes (or, with dryRun, counts) what the schedule says is old enough and is
// not held. Returns what it did, per kind.
async function runRetention(shop, { dryRun = false, now = new Date(), user = null } = {}) {
  const policy = await getPolicy(shop);
  const held = await heldCustomers(shop);

  if (held.all) {
    return { dryRun, skippedBecause: "SHOP_HOLD", contexts: 0, notifications: 0, closedQuotes: 0, inactiveCarts: 0 };
  }
  const notHeld = held.ids.length ? { $nin: held.ids } : { $exists: true };
  const ago = (days) => new Date(now.getTime() - days * DAY);

  const filters = {
    contexts: { shop, customer: notHeld, $or: [{ revokedAt: { $lt: ago(policy.contextsDays) } }, { expiresAt: { $lt: ago(policy.contextsDays) } }] },
    notifications: { shop, recipient: notHeld, createdAt: { $lt: ago(policy.notificationsDays) } },
    closedQuotes: { shop, customer: notHeld, status: { $in: CLOSED_QUOTES }, updatedAt: { $lt: ago(policy.closedQuotesDays) } },
    inactiveCarts: { shop, customer: notHeld, updatedAt: { $lt: ago(policy.inactiveCartsDays) } },
    // Offline captures (Phase 4) follow the same schedule as untouched carts.
    offlineCaptures: { shop, customer: notHeld, receivedAt: { $lt: ago(policy.inactiveCartsDays) } },
  };

  const result = { dryRun, skippedBecause: null, heldCustomers: held.ids.length };

  const quoteIds = (await Quote.find(filters.closedQuotes).select("_id").lean()).map((q) => q._id);
  result.contexts = dryRun ? await ContextSession.countDocuments(filters.contexts) : (await ContextSession.deleteMany(filters.contexts)).deletedCount;
  result.notifications = dryRun ? await Notification.countDocuments(filters.notifications) : (await Notification.deleteMany(filters.notifications)).deletedCount;
  result.closedQuotes = quoteIds.length;
  result.inactiveCarts = dryRun ? await AgentCart.countDocuments(filters.inactiveCarts) : (await AgentCart.deleteMany(filters.inactiveCarts)).deletedCount;
  result.offlineCaptures = dryRun ? await OfflineCapture.countDocuments(filters.offlineCaptures) : (await OfflineCapture.deleteMany(filters.offlineCaptures)).deletedCount;

  if (!dryRun) {
    if (quoteIds.length) {
      await QuoteVersion.deleteMany({ quote: { $in: quoteIds } });
      await Quote.deleteMany({ _id: { $in: quoteIds } });
    }
    await recordAudit({
      shop,
      actorType: user ? "merchant_user" : "system",
      actor: user ? user._id : undefined,
      action: AUDIT_ACTIONS.RETENTION_RUN,
      objectType: "retention",
      metadata: { contexts: result.contexts, notifications: result.notifications, closedQuotes: result.closedQuotes, inactiveCarts: result.inactiveCarts, heldCustomers: held.ids.length },
    });
  }

  return result;
}

// ---- legal holds

async function placeHold({ shop, scope, customerId, reason, user }) {
  if (!["shop", "customer"].includes(scope)) throw Object.assign(new Error("scope must be shop or customer"), { statusCode: 400 });
  if (!String(reason || "").trim()) throw Object.assign(new Error("Say why the hold is needed"), { statusCode: 400 });

  let customer = null;
  if (scope === "customer") {
    customer = await Customer.findOne({ _id: customerId, shop });
    if (!customer) throw Object.assign(new Error("Customer not found"), { statusCode: 404 });
  }

  const hold = await LegalHold.create({ shop, scope, customer: customer ? customer._id : undefined, reason: String(reason).trim(), placedBy: user._id });
  await recordAudit({
    shop,
    actorType: "merchant_user",
    actor: user._id,
    customer: customer ? customer._id : undefined,
    action: AUDIT_ACTIONS.LEGAL_HOLD_PLACED,
    objectType: "legal_hold",
    objectId: String(hold._id),
    metadata: { scope, reason: hold.reason },
  });
  return hold;
}

async function releaseHold({ shop, holdId, user }) {
  const hold = await LegalHold.findOne({ _id: holdId, shop });
  if (!hold) throw Object.assign(new Error("Hold not found"), { statusCode: 404 });
  if (hold.releasedAt) return hold;

  hold.releasedAt = new Date();
  hold.releasedBy = user._id;
  await hold.save();
  await recordAudit({
    shop,
    actorType: "merchant_user",
    actor: user._id,
    customer: hold.customer || undefined,
    action: AUDIT_ACTIONS.LEGAL_HOLD_RELEASED,
    objectType: "legal_hold",
    objectId: String(hold._id),
    metadata: { scope: hold.scope },
  });
  return hold;
}

// ---- data-subject requests

// Everything we hold that is about this customer, to hand back to them.
async function accessData(shop, customer) {
  const [quotes, orders, overrides, notifications, lists] = await Promise.all([
    Quote.find({ shop, customer: customer._id }).select("number status createdAt updatedAt").lean(),
    Order.find({ shop, shopifyCustomerId: customer.shopifyCustomerId }).select("name totalPrice currency createdAt poNumber").lean(),
    OverrideRequest.find({ shop, customer: customer._id }).select("type status createdAt reasonCode").lean(),
    Notification.find({ shop, recipient: customer._id }).select("type title body createdAt").lean(),
    ShoppingList.find({ shop, customer: customer._id }).select("name items createdAt").lean(),
  ]);
  const profile = customer.toObject ? customer.toObject() : customer;
  delete profile.mfa;
  return {
    profile: {
      name: profile.name,
      email: profile.email,
      company: profile.company || null,
      phone: profile.phone || null,
      taxId: profile.taxId || null,
      legalEntity: profile.legalEntity || null,
      addresses: profile.addresses || [],
      consent: profile.consent || null,
      createdAt: profile.createdAt,
    },
    quotes,
    orders,
    exceptionRequests: overrides,
    notifications,
    shoppingLists: lists,
  };
}

// Removes the optional profile data and the working records that only exist for
// the customer, and keeps what must be kept: orders, payment records, quotes
// already sent, exception decisions and the audit trail (spec §11.2).
async function eraseCustomer(shop, customer) {
  const id = customer._id;
  const counts = {};

  await Customer.updateOne(
    { _id: id },
    {
      $set: {
        name: "Erased customer",
        email: `erased-${id}@erased.invalid`,
        addresses: [],
        tags: [],
        accountStatus: "suspended",
        erasedAt: new Date(),
      },
      $unset: { company: 1, phone: 1, phoneKey: 1, taxId: 1, internalNotes: 1, region: 1, consent: 1, createdByAgent: 1, shopifyCompanyName: 1 },
    }
  );
  counts.profileFieldsCleared = true;
  counts.shoppingLists = (await ShoppingList.deleteMany({ shop, customer: id })).deletedCount;
  counts.pins = (await AgentPin.deleteMany({ shop, customer: id })).deletedCount;
  counts.notifications = (await Notification.deleteMany({ shop, recipient: id })).deletedCount;
  counts.carts = (await AgentCart.deleteMany({ shop, customer: id })).deletedCount;
  counts.offlineCaptures = (await OfflineCapture.deleteMany({ shop, customer: id })).deletedCount;
  return counts;
}

async function handleRequest({ shop, customerId, type, user }) {
  if (!["access", "erasure"].includes(type)) throw Object.assign(new Error("type must be access or erasure"), { statusCode: 400 });
  const customer = await Customer.findOne({ _id: customerId, shop });
  if (!customer) throw Object.assign(new Error("Customer not found"), { statusCode: 404 });

  const log = async (status, extra = {}) => {
    const request = await DataSubjectRequest.create({ shop, customer: customer._id, type, status, requestedBy: user._id, ...extra });
    await recordAudit({
      shop,
      actorType: "merchant_user",
      actor: user._id,
      customer: customer._id,
      action: status === "completed" ? AUDIT_ACTIONS.DSR_COMPLETED : AUDIT_ACTIONS.DSR_REFUSED,
      outcome: status === "completed" ? "success" : "denied",
      reasonCode: extra.refusedReason,
      objectType: "data_subject_request",
      objectId: String(request._id),
      metadata: { type, ...(extra.summary || {}) },
    });
    return request;
  };

  if (type === "access") {
    const data = await accessData(shop, customer);
    const request = await log("completed", { summary: { quotes: data.quotes.length, orders: data.orders.length } });
    return { request, data };
  }

  if (customer.erasedAt) return { request: await log("refused", { refusedReason: "ALREADY_ERASED" }) };
  if (isAgentRole(customer.role)) return { request: await log("refused", { refusedReason: "AGENT_ACCOUNT" }) };
  if (await isHeld(shop, customer._id)) return { request: await log("refused", { refusedReason: "LEGAL_HOLD" }) };

  const summary = await eraseCustomer(shop, customer);
  const request = await log("completed", { summary });
  return {
    request,
    shopifyNote: "Orders, payment records, sent quotes and the audit trail are kept as the law requires. The customer's Shopify record is not changed here; erase it from Shopify's own privacy tools.",
  };
}

// Runs the schedule once a day for every shop that has turned it on.
function startRetentionSweeper() {
  const tick = async () => {
    try {
      const shops = await AgentSettings.find({ "retention.autoPurge": true }).select("shop").lean();
      for (const s of shops) await runRetention(s.shop);
    } catch (err) {
      console.error("[retention] sweep failed", err);
    }
  };
  setTimeout(tick, 5 * 60 * 1000).unref();
  setInterval(tick, DAY).unref();
}

module.exports = { DEFAULTS, getPolicy, isHeld, runRetention, placeHold, releaseHold, handleRequest, startRetentionSweeper };
