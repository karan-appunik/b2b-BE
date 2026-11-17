const Order = require("../models/order.model");
const Quote = require("../models/quote.model");
const OverrideRequest = require("../models/overrideRequest.model");
const Customer = require("../models/customer.model");
const AgentScopeGrant = require("../models/agentScopeGrant.model");
const { agentPseudonym } = require("./pseudonym.service");
const { parsePeriod } = require("./report.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");

// Phase 4: feeds for a CRM and for a commission system.
//
// These are read-only exports of what already happened. They are inputs for
// the merchant's own systems and nothing more:
//   * The CRM feed turns accounts and quotes into rows a CRM can load. It is
//     not a pipeline: stages are a plain mapping of the quote's own state.
//   * The commission feed lists orders an agent placed, with what the
//     customer paid and what price concessions were approved. It never works
//     out a commission and never says who is entitled to one: an agent being on
//     an order is not an entitlement (spec §10.3). Net sales are not given
//     because the order record keeps one total; the field says so.

const MAX_ROWS = 50000;

const STAGE = {
  DRAFT: "prospecting",
  PENDING_APPROVAL: "prospecting",
  APPROVED: "prospecting",
  REJECTED: "prospecting",
  SENT: "proposal",
  CHANGES_REQUESTED: "negotiation",
  ACCEPTED: "won",
  CONVERTED: "won",
  DECLINED: "lost",
  EXPIRED: "lost",
  WITHDRAWN: "lost",
};

function agentRef(shop, agent, pseudonymous) {
  if (!agent) return { agentCode: null, agentName: null };
  return { agentCode: agentPseudonym(shop, agent._id), agentName: pseudonymous ? null : agent.name || agent.email || null };
}

function toMajor(minor) {
  return Math.round(Number(minor || 0)) / 100;
}

// One row per account an agent can work with, for the CRM's account table.
async function crmAccounts({ shop, pseudonymous = true }) {
  const customers = await Customer.find({ shop, $or: [{ role: "customer" }, { role: { $exists: false } }, { role: null }], mergedInto: null, erasedAt: null })
    .select("name company email accountCode territory legalEntity accountStatus createdAt shopifyCustomerId")
    .limit(MAX_ROWS)
    .lean();

  const ids = customers.map((c) => String(c._id));
  const [grants, openQuotes, lastOrders] = await Promise.all([
    AgentScopeGrant.find({ shop, scopeType: "customer", effect: "allow", scopeId: { $in: ids } }).select("agent scopeId").lean(),
    Quote.aggregate([
      { $match: { shop, status: { $in: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "CHANGES_REQUESTED"] } } },
      { $group: { _id: "$customer", n: { $sum: 1 } } },
    ]),
    Order.aggregate([{ $match: { shop, shopifyCustomerId: { $exists: true } } }, { $group: { _id: "$shopifyCustomerId", at: { $max: "$orderedAt" }, orders: { $sum: 1 } } }]),
  ]);

  const owners = new Map();
  grants.forEach((g) => owners.set(g.scopeId, (owners.get(g.scopeId) || []).concat(String(g.agent))));
  const quotesBy = new Map(openQuotes.map((x) => [String(x._id), x.n]));
  const ordersBy = new Map(lastOrders.map((x) => [x._id, x]));

  const agentIds = [...new Set([...owners.values()].flat())];
  const agents = await Customer.find({ shop, _id: { $in: agentIds } }).select("name email").lean();
  const agentBy = new Map(agents.map((a) => [String(a._id), a]));

  return customers.map((c) => {
    const o = ordersBy.get(c.shopifyCustomerId) || null;
    return {
      customerId: String(c._id),
      company: c.company || null,
      name: c.name || null,
      email: c.email || null,
      accountCode: c.accountCode || null,
      territory: c.territory || null,
      legalEntity: c.legalEntity || null,
      status: c.accountStatus || "active",
      assignedAgents: (owners.get(String(c._id)) || []).map((id) => agentRef(shop, agentBy.get(id) || { _id: id }, pseudonymous)),
      openQuotes: quotesBy.get(String(c._id)) || 0,
      lastOrderAt: c.lastOrderAt || (o && o.at) || null,
      createdAt: c.createdAt,
    };
  });
}

// One row per quote, with a stage a CRM understands.
async function crmQuotes({ shop, from, to, pseudonymous = true }) {
  const period = parsePeriod(from, to);
  const quotes = await Quote.find({ shop, updatedAt: { $gte: period.from, $lt: period.to } }).sort({ updatedAt: -1 }).limit(MAX_ROWS).lean();
  const people = await Customer.find({ shop, _id: { $in: [...new Set(quotes.flatMap((q) => [String(q.ownerAgent), String(q.customer)]))] } }).select("name email company").lean();
  const byId = new Map(people.map((p) => [String(p._id), p]));
  const QuoteVersion = require("../models/quoteVersion.model");
  const versions = await QuoteVersion.find({ quote: { $in: quotes.map((q) => q._id) } }).select("quote version totals currency").lean();
  const latest = new Map();
  versions.forEach((v) => {
    const key = String(v.quote);
    if (!latest.has(key) || latest.get(key).version < v.version) latest.set(key, v);
  });

  return quotes.map((q) => {
    const v = latest.get(String(q._id));
    const customer = byId.get(String(q.customer));
    return {
      quoteNumber: q.number,
      quoteId: String(q._id),
      customerId: String(q.customer),
      customerCompany: (customer && (customer.company || customer.name)) || null,
      ...agentRef(shop, byId.get(String(q.ownerAgent)) || { _id: q.ownerAgent }, pseudonymous),
      status: q.status,
      stage: STAGE[q.status] || "prospecting",
      version: q.currentVersion,
      amount: v && v.totals ? toMajor(v.totals.subtotal) : null,
      currency: (v && v.currency) || q.currency || null,
      createdAt: q.createdAt,
      sentAt: q.sentAt || null,
      expiresAt: q.expiresAt || null,
      updatedAt: q.updatedAt,
    };
  });
}

// One row per order an agent placed for a customer.
async function commissionRows({ shop, from, to, pseudonymous = true }) {
  const period = parsePeriod(from, to);
  const orders = await Order.find({ shop, source: "sales_agent", orderedAt: { $gte: period.from, $lt: period.to } })
    .sort({ orderedAt: -1 })
    .limit(MAX_ROWS)
    .lean();

  const agentIds = [...new Set(orders.map((o) => o.placedByAgent && o.placedByAgent.agent).filter(Boolean).map(String))];
  const agents = await Customer.find({ shop, _id: { $in: agentIds } }).select("name email territory").lean();
  const agentBy = new Map(agents.map((a) => [String(a._id), a]));

  const overrideIds = [...new Set(orders.flatMap((o) => (o.placedByAgent && o.placedByAgent.overrides) || []).map(String))];
  const overrides = await OverrideRequest.find({ shop, _id: { $in: overrideIds }, status: { $in: ["APPROVED", "AUTO_APPROVED"] } })
    .select("type baseline proposed snapshot")
    .lean();
  const ovBy = new Map(overrides.map((r) => [String(r._id), r]));

  return orders.map((o) => {
    const agent = agentBy.get(String(o.placedByAgent && o.placedByAgent.agent));
    const used = ((o.placedByAgent && o.placedByAgent.overrides) || []).map((id) => ovBy.get(String(id))).filter(Boolean);
    const concession = used.reduce((sum, r) => {
      if (!["UNIT_PRICE", "ORDER_DISCOUNT", "SHIPPING_PRICE"].includes(r.type)) return sum;
      const qty = r.type === "UNIT_PRICE" && r.snapshot && r.snapshot.quantity ? r.snapshot.quantity : 1;
      return sum + (r.baseline.amount - r.proposed.amount) * qty;
    }, 0);

    return {
      orderName: o.name,
      shopifyOrderId: o.shopifyOrderId,
      orderedAt: o.orderedAt,
      customerId: o.shopifyCustomerId || null,
      ...agentRef(shop, agent || (o.placedByAgent && { _id: o.placedByAgent.agent }), pseudonymous),
      territory: (agent && agent.territory) || null,
      source: "assisted",
      currency: o.currency,
      orderTotal: o.totalPrice,
      // The total as recorded on the order. Tax and shipping are not split out here.
      netSales: null,
      approvedPriceConcessions: toMajor(concession),
      approvedExceptions: used.length,
      fromQuote: !!(o.placedByAgent && o.placedByAgent.quote),
      financialStatus: o.financialStatus || null,
      // Being on an order is not an entitlement to commission (spec §10.3).
      commissionEntitlement: "not_determined",
    };
  });
}

const CSV_NOTE = "Agent attribution is not a commission entitlement. Net sales are not tracked, so netSales is empty.";

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  // A cell must never be read as a formula by a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

async function audited({ shop, user, kind, rows, extra }) {
  await recordAudit({
    shop,
    actorType: "merchant_user",
    actor: user._id,
    action: kind === "commission" ? AUDIT_ACTIONS.COMMISSION_FEED_EXPORTED : AUDIT_ACTIONS.CRM_FEED_EXPORTED,
    objectType: "integration_feed",
    metadata: { kind, rows: rows.length, ...extra },
  });
}

module.exports = { crmAccounts, crmQuotes, commissionRows, toCsv, audited, STAGE, CSV_NOTE };
