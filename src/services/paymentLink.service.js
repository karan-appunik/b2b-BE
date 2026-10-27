const crypto = require("crypto");

const PaymentLink = require("../models/paymentLink.model");
const Customer = require("../models/customer.model");
const { authorizeAgent, checkCustomerAccess } = require("./agentAccess.service");
const { getSettings } = require("./override.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");
const { EVENT_TYPES, emitEvent } = require("./outbox.service");
const { sendPaymentLinkEmail } = require("./email.service");

const HOUR_MS = 60 * 60 * 1000;

class PaymentLinkError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.statusCode = status;
  }
}

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

// j***@example.com — enough for the agent to confirm where it went.
function maskEmail(email) {
  const [name, domain] = String(email || "").split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, 1)}${"*".repeat(Math.max(2, name.length - 1))}@${domain}`;
}

function formatMinor(amount, currency) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount / 100);
  } catch {
    return `${amount / 100} ${currency}`;
  }
}

function linkUrl(shop, token) {
  return `https://${shop}/apps/sparklayer/pay/${token}`;
}

// What an agent or merchant may see of a link: never the secret token or the
// hosted checkout URL.
function present(link) {
  const l = link.toObject ? link.toObject() : link;
  return {
    id: l._id,
    status: l.status,
    amount: l.amount,
    currency: l.currency,
    draftOrderId: l.draftOrderId,
    quoteId: l.quote || null,
    sentTo: l.sentTo || null,
    expiresAt: l.expiresAt,
    openedAt: l.openedAt || null,
    paidAt: l.paidAt || null,
    paidOrderId: l.paidOrderId || null,
    reconcileFlag: l.reconcileFlag || null,
    createdAt: l.createdAt,
  };
}

function note(link, type, comment) {
  link.activity.push({ at: new Date(), type, comment });
}

// Creates the link for a draft order and emails it to the customer. Any link
// already open for the same order is replaced, so there is only ever one live
// way to pay (spec §9.4 "creates a replacement").
async function createLink({ shop, agent, customerShopifyId, draftOrderId, invoiceUrl, amount, currency, quoteId, shipTo }) {
  const auth = await authorizeAgent(shop, agent, "payment_link.send");
  if (!auth.allowed) throw new PaymentLinkError("PERMISSION_DENIED", "Your role can't send payment links", 403);

  const customer = await Customer.findOne({ shop, shopifyCustomerId: String(customerShopifyId || "") });
  if (!customer) throw new PaymentLinkError("CUSTOMER_NOT_FOUND", "Customer not found", 404);

  // The agent may only send a link for a customer they are allowed to act for.
  const access = await checkCustomerAccess(shop, agent, customer);
  if (!access.allowed) throw new PaymentLinkError("CUSTOMER_ACCESS_DENIED", "You do not have access to this customer", 403);

  if (!customer.email) throw new PaymentLinkError("NO_EMAIL", "This customer has no email address to send the link to");
  if (!String(draftOrderId || "").trim()) throw new PaymentLinkError("ORDER_REQUIRED", "draftOrderId is required");
  if (!/^https:\/\//.test(String(invoiceUrl || ""))) throw new PaymentLinkError("INVALID_URL", "A secure checkout URL is required");
  if (!Number.isInteger(amount) || amount < 1 || !currency) {
    throw new PaymentLinkError("INVALID_AMOUNT", "A positive amount in minor units and a currency are required");
  }

  const settings = await getSettings(shop);
  const now = new Date();

  const link = await PaymentLink.create({
    shop,
    token: newToken(),
    customer: customer._id,
    agent: agent._id,
    quote: quoteId || undefined,
    draftOrderId: String(draftOrderId),
    shipTo: normalizeRegion(shipTo),
    invoiceUrl,
    amount,
    currency: String(currency).toUpperCase(),
    expiresAt: new Date(now.getTime() + settings.paymentLinkValidHours * HOUR_MS),
    sentTo: customer.email,
    activity: [{ at: now, type: "created" }],
  });

  // Older links for this order stop working.
  const older = await PaymentLink.find({ shop, draftOrderId: String(draftOrderId), status: "ACTIVE", _id: { $ne: link._id } });
  for (const old of older) {
    old.status = "REPLACED";
    old.replacedBy = link._id;
    note(old, "replaced");
    await old.save();

    await recordAudit({
      shop,
      actorType: "sales_agent",
      actor: agent._id,
      customer: customer._id,
      action: AUDIT_ACTIONS.PAYMENT_LINK_REPLACED,
      objectType: "payment_link",
      objectId: String(old._id),
      metadata: { replacedBy: String(link._id) },
    });
  }

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
    customer: customer._id,
    action: AUDIT_ACTIONS.PAYMENT_LINK_CREATED,
    objectType: "payment_link",
    objectId: String(link._id),
    metadata: { draftOrderId: link.draftOrderId, amount, currency: link.currency, expiresAt: link.expiresAt },
  });

  sendPaymentLinkEmail({
    customer,
    agent,
    amountText: formatMinor(amount, link.currency),
    expiresAt: link.expiresAt,
    url: linkUrl(shop, link.token),
  }).catch((err) => console.error("[email] payment link email failed", err));

  return { link, emailMasked: maskEmail(customer.email) };
}

// The buyer opens their link. Returns the hosted checkout URL to send them to,
// or throws. Someone else's link and a missing one look the same.
async function resolveForBuyer({ shop, token, buyerShopifyCustomerId }) {
  const link = await PaymentLink.findOne({ shop, token: String(token || "") }).select("+invoiceUrl");
  const customer = link ? await Customer.findById(link.customer) : null;

  if (!link || !customer || !buyerShopifyCustomerId || customer.shopifyCustomerId !== String(buyerShopifyCustomerId)) {
    throw new PaymentLinkError("NOT_FOUND", "This payment link isn't available", 404);
  }

  if (link.status === "ACTIVE" && link.expiresAt <= new Date()) {
    link.status = "EXPIRED";
    note(link, "expired");
    await link.save();
  }

  if (link.status === "PAID") throw new PaymentLinkError("ALREADY_PAID", "This has already been paid", 409);
  if (link.status !== "ACTIVE") {
    throw new PaymentLinkError("LINK_INVALID", "This payment link is no longer valid. Ask your sales contact for a new one.", 410);
  }

  link.openedAt = link.openedAt || new Date();
  link.openCount += 1;
  await link.save();

  return { invoiceUrl: link.invoiceUrl, link };
}

// Called when Shopify reports the order paid. Idempotent: the same payment
// reported twice changes nothing. A paid amount that differs from what the
// link asked for is flagged for review, not hidden.
// The hosted checkout adds shipping and tax to what the link asked for, so the
// total paid can be more than the link's amount without anything being wrong.
// The payment matches if it is the link's amount, or the link's amount plus
// shipping, tax, or both. Anything else (an item changed, a wrong total) is
// flagged.
function paymentMatches(paid, expected, extras) {
  const shipping = Number(extras && extras.shipping) || 0;
  const tax = Number(extras && extras.tax) || 0;
  return [0, shipping, tax, shipping + tax].some((extra) => Math.abs(paid - extra - expected) <= 1) || paid === expected;
}

async function markPaid({ shop, token, orderId, amount, currency, extras }) {
  const link = await PaymentLink.findOne({ shop, token: String(token || "") });
  if (!link) return { found: false };

  if (link.status === "PAID") return { found: true, already: true, link };

  const mismatch = !paymentMatches(Number(amount), link.amount, extras) || String(currency || "").toUpperCase() !== link.currency;

  link.status = "PAID";
  link.paidAt = new Date();
  link.paidOrderId = String(orderId || "");
  link.paidAmount = Number(amount);
  if (mismatch) link.reconcileFlag = "AMOUNT_MISMATCH";
  note(link, "paid", String(orderId || ""));
  await link.save();

  await recordAudit({
    shop,
    actorType: "system",
    customer: link.customer,
    action: mismatch ? AUDIT_ACTIONS.PAYMENT_LINK_MISMATCH : AUDIT_ACTIONS.PAYMENT_LINK_PAID,
    outcome: mismatch ? "failure" : "success",
    reasonCode: mismatch ? "AMOUNT_MISMATCH" : undefined,
    objectType: "payment_link",
    objectId: String(link._id),
    metadata: { orderId: link.paidOrderId, expected: link.amount, paid: link.paidAmount, currency: link.currency, shipping: Number(extras && extras.shipping) || 0, tax: Number(extras && extras.tax) || 0 },
  });
  await emitEvent(shop, EVENT_TYPES.PAYMENT_COMPLETED, {
    payment_link_id: String(link._id),
    order_id: link.paidOrderId,
    customer_id: String(link.customer),
    amount: link.paidAmount,
    currency: link.currency,
    reconciled: !mismatch,
  });

  return { found: true, already: false, link };
}

async function revokeLink({ shop, linkId, agent, user }) {
  const link = await PaymentLink.findOne({ _id: linkId, shop, ...(agent ? { agent: agent._id } : {}) });
  if (!link) throw new PaymentLinkError("NOT_FOUND", "Payment link not found", 404);
  if (link.status !== "ACTIVE") throw new PaymentLinkError("NOT_ACTIVE", `This link is already ${link.status.toLowerCase()}`, 409);

  link.status = "REVOKED";
  link.revokedAt = new Date();
  note(link, "revoked");
  await link.save();

  await recordAudit({
    shop,
    actorType: agent ? "sales_agent" : "merchant_user",
    actor: agent ? agent._id : user._id,
    customer: link.customer,
    action: AUDIT_ACTIONS.PAYMENT_LINK_REVOKED,
    objectType: "payment_link",
    objectId: String(link._id),
  });

  return link;
}

function normalizeRegion(r) {
  if (!r || typeof r !== "object") return undefined;
  const out = {
    zip: r.zip ? String(r.zip).trim().toUpperCase().replace(/\s+/g, "") : undefined,
    countryCode: r.countryCode ? String(r.countryCode).trim().toUpperCase() : undefined,
    provinceCode: r.provinceCode ? String(r.provinceCode).trim().toUpperCase() : undefined,
  };
  return out.zip || out.countryCode ? out : undefined;
}

const sameRegion = (a, b) => !!a && !!b && (a.zip || "") === (b.zip || "") && (a.countryCode || "") === (b.countryCode || "") && (a.provinceCode || "") === (b.provinceCode || "");

// The customer's address in Shopify changed: a payment link that was sending
// the order to the address they no longer have is withdrawn, since the tax on
// it is no longer right. The agent is told to send a new one (spec §12).
async function invalidateForAddressChange({ shop, customerId, previousRegion, newRegion }) {
  const prev = normalizeRegion(previousRegion);
  const next = normalizeRegion(newRegion);
  if (!prev || sameRegion(prev, next)) return 0;

  const links = await PaymentLink.find({ shop, customer: customerId, status: "ACTIVE" });
  let withdrawn = 0;

  for (const link of links) {
    const to = normalizeRegion(link.shipTo ? link.shipTo.toObject() : null);
    if (!sameRegion(to, prev)) continue;

    link.status = "REVOKED";
    link.revokedAt = new Date();
    note(link, "revoked", "ADDRESS_CHANGED");
    await link.save();
    withdrawn += 1;

    await recordAudit({
      shop,
      actorType: "system",
      customer: link.customer,
      action: AUDIT_ACTIONS.PAYMENT_LINK_REVOKED,
      reasonCode: "ADDRESS_CHANGED",
      objectType: "payment_link",
      objectId: String(link._id),
    });

    const { notify } = require("./notification.service");
    await notify({
      shop,
      recipient: link.agent,
      type: "payment_link.withdrawn",
      title: "A payment link was withdrawn",
      body: `The customer's address changed, so the link for ${formatMinor(link.amount, link.currency)} no longer fits. Send a new one.`,
      link: "/account",
      dedupeKey: `addrchg:${link._id}`,
    });
  }

  return withdrawn;
}

// The order's total changed, so the old link would collect the wrong amount:
// it is withdrawn (spec §9.4).
async function invalidateForOrder({ shop, draftOrderId, reason }) {
  const links = await PaymentLink.find({ shop, draftOrderId: String(draftOrderId), status: "ACTIVE" });

  for (const link of links) {
    link.status = "REVOKED";
    link.revokedAt = new Date();
    note(link, "revoked", reason);
    await link.save();

    await recordAudit({
      shop,
      actorType: "system",
      customer: link.customer,
      action: AUDIT_ACTIONS.PAYMENT_LINK_REVOKED,
      reasonCode: reason,
      objectType: "payment_link",
      objectId: String(link._id),
    });
  }

  return links.length;
}

async function expireDue(shop, now = new Date()) {
  await PaymentLink.updateMany({ shop, status: "ACTIVE", expiresAt: { $lte: now } }, { $set: { status: "EXPIRED" } });
}

async function listForAgent(shop, agent) {
  await expireDue(shop);
  return PaymentLink.find({ shop, agent: agent._id }).sort({ createdAt: -1 }).limit(100);
}

async function listForMerchant(shop) {
  await expireDue(shop);
  const links = await PaymentLink.find({ shop }).sort({ createdAt: -1 }).limit(200);
  const people = await Customer.find({
    _id: { $in: [...new Set(links.flatMap((l) => [String(l.customer), String(l.agent)]))] },
  }).select("name email");
  const byId = new Map(people.map((p) => [String(p._id), p]));

  return links.map((l) => ({
    ...present(l),
    customerName: (byId.get(String(l.customer)) || {}).name || null,
    agentName: (byId.get(String(l.agent)) || {}).name || null,
    activity: l.activity,
  }));
}

module.exports = {
  PaymentLinkError,
  maskEmail,
  present,
  createLink,
  resolveForBuyer,
  markPaid,
  revokeLink,
  invalidateForOrder,
  invalidateForAddressChange,
  expireDue,
  listForAgent,
  listForMerchant,
};
