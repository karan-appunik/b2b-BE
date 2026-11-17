const Order = require("../models/order.model");
const Quote = require("../models/quote.model");
const OverrideRequest = require("../models/overrideRequest.model");
const Customer = require("../models/customer.model");
const CustomerGroup = require("../models/customerGroup.model");
const AgentCart = require("../models/agentCart.model");
const OutboxEvent = require("../models/outboxEvent.model");
const AuditEvent = require("../models/auditEvent.model");

// Sales agent reports (spec §10.3). Revenue, orders, quotes, conversion,
// average order value, active accounts, new customers and override rate, by
// agent, territory, segment (customer group) and period. Assisted orders are
// told apart from the rest. Reports describe what happened; an agent
// association is not commission entitlement.

const DAY = 24 * 60 * 60 * 1000;
const GROUPS = ["none", "agent", "territory", "segment"];
const SENT_OR_LATER = ["SENT", "ACCEPTED", "DECLINED", "CHANGES_REQUESTED", "EXPIRED", "CONVERTED"];

class ReportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.statusCode = 400;
  }
}

function emptyBucket(key, label) {
  return {
    key,
    label,
    orders: 0,
    revenue: {},
    averageOrderValue: {},
    activeAccounts: 0,
    quotes: { created: 0, sent: 0, accepted: 0, converted: 0 },
    quoteConversion: null,
    newCustomers: 0,
    overrides: 0,
    overrideRate: null,
    _accounts: new Set(),
  };
}

// Turns plain facts into report rows. Pure, so the arithmetic can be tested.
//   orders:       { bucket: {key,label}, amount (major units), currency, customer }
//   quotes:       { bucket, status }
//   overrides:    { bucket }
//   newCustomers: { bucket }
function aggregate({ orders, quotes, overrides, newCustomers }) {
  const buckets = new Map();
  const total = emptyBucket("total", "All");

  const bucketFor = (b) => {
    if (!buckets.has(b.key)) buckets.set(b.key, emptyBucket(b.key, b.label));
    return buckets.get(b.key);
  };
  const each = (b, fn) => {
    fn(bucketFor(b));
    fn(total);
  };

  for (const o of orders) {
    each(o.bucket, (x) => {
      x.orders += 1;
      x.revenue[o.currency] = Math.round(((x.revenue[o.currency] || 0) + o.amount) * 100) / 100;
      if (o.customer) x._accounts.add(o.customer);
    });
  }
  for (const q of quotes) {
    each(q.bucket, (x) => {
      x.quotes.created += 1;
      if (SENT_OR_LATER.includes(q.status)) x.quotes.sent += 1;
      if (q.status === "ACCEPTED" || q.status === "CONVERTED") x.quotes.accepted += 1;
      if (q.status === "CONVERTED") x.quotes.converted += 1;
    });
  }
  for (const o of overrides) each(o.bucket, (x) => { x.overrides += 1; });
  for (const c of newCustomers) each(c.bucket, (x) => { x.newCustomers += 1; });

  const finish = (x) => {
    x.activeAccounts = x._accounts.size;
    delete x._accounts;
    for (const [currency, sum] of Object.entries(x.revenue)) {
      const count = orders.filter((o) => o.currency === currency && (x.key === "total" || o.bucket.key === x.key)).length;
      x.averageOrderValue[currency] = count ? Math.round((sum / count) * 100) / 100 : 0;
    }
    x.quoteConversion = x.quotes.sent ? Math.round((x.quotes.converted / x.quotes.sent) * 1000) / 10 : null;
    x.overrideRate = x.orders ? Math.round((x.overrides / x.orders) * 1000) / 10 : null;
    return x;
  };

  const rows = [...buckets.values()].map(finish).sort((a, b) => b.orders - a.orders || a.label.localeCompare(b.label));
  return { rows, total: finish(total) };
}

function parsePeriod(from, to, now = new Date()) {
  const end = to ? new Date(to) : now;
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * DAY);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new ReportError("INVALID_PERIOD", "Dates are not valid");
  if (start >= end) throw new ReportError("INVALID_PERIOD", "The start must be before the end");
  if (end - start > 366 * DAY) throw new ReportError("INVALID_PERIOD", "A report can cover up to a year");
  return { from: start, to: end };
}

async function salesReport({ shop, from, to, groupBy = "none", pseudonymous = false }) {
  if (!GROUPS.includes(groupBy)) throw new ReportError("INVALID_GROUP", "Group by agent, territory, segment or none");
  const period = parsePeriod(from, to);
  const range = { $gte: period.from, $lt: period.to };

  const [orders, quotes, overrides, createdByAgents] = await Promise.all([
    Order.find({ shop, orderedAt: range }).select("totalPrice currency shopifyCustomerId source placedByAgent").limit(50000).lean(),
    Quote.find({ shop, createdAt: range }).select("status ownerAgent customer").limit(50000).lean(),
    OverrideRequest.find({ shop, createdAt: range, status: { $nin: ["DENIED", "CANCELLED"] } }).select("agent customer").limit(50000).lean(),
    Customer.find({ shop, createdByAgent: { $exists: true, $ne: null }, createdAt: range }).select("createdByAgent territory customerGroup").lean(),
  ]);

  // Everyone referred to, in one go.
  const byShopifyId = new Map();
  const byId = new Map();
  const need = new Set();
  orders.forEach((o) => o.shopifyCustomerId && need.add(o.shopifyCustomerId));
  const idsNeeded = new Set();
  orders.forEach((o) => o.placedByAgent && o.placedByAgent.agent && idsNeeded.add(String(o.placedByAgent.agent)));
  quotes.forEach((q) => { idsNeeded.add(String(q.ownerAgent)); idsNeeded.add(String(q.customer)); });
  overrides.forEach((o) => { idsNeeded.add(String(o.agent)); idsNeeded.add(String(o.customer)); });
  createdByAgents.forEach((c) => idsNeeded.add(String(c.createdByAgent)));

  const people = await Customer.find({
    shop,
    $or: [{ shopifyCustomerId: { $in: [...need] } }, { _id: { $in: [...idsNeeded] } }],
  }).select("name territory customerGroup shopifyCustomerId").lean();
  people.forEach((p) => {
    byId.set(String(p._id), p);
    if (p.shopifyCustomerId) byShopifyId.set(p.shopifyCustomerId, p);
  });

  const groups = await CustomerGroup.find({ shop }).select("name").lean();
  const groupName = new Map(groups.map((g) => [String(g._id), g.name]));

  const bucketOf = (agentId, customer) => {
    if (groupBy === "none") return { key: "all", label: "All" };
    if (groupBy === "agent") {
      const a = agentId ? byId.get(String(agentId)) : null;
      if (!a) return { key: "none", label: "No agent" };
      // With names hidden, the report names an agent only by a stable code.
      if (pseudonymous) {
        const code = require("./pseudonym.service").agentPseudonym(shop, a._id);
        return { key: code, label: code };
      }
      return { key: String(a._id), label: a.name };
    }
    if (groupBy === "territory") {
      const t = customer && customer.territory;
      return t ? { key: "t:" + t, label: t } : { key: "t:none", label: "No territory" };
    }
    const g = customer && customer.customerGroup ? groupName.get(String(customer.customerGroup)) : null;
    return g ? { key: "g:" + g, label: g } : { key: "g:none", label: "No group" };
  };

  const assisted = orders.filter((o) => o.source === "sales_agent");
  const facts = {
    orders: assisted.map((o) => {
      const customer = byShopifyId.get(o.shopifyCustomerId);
      return {
        bucket: bucketOf(o.placedByAgent && o.placedByAgent.agent, customer),
        amount: o.totalPrice,
        currency: o.currency,
        customer: o.shopifyCustomerId,
      };
    }),
    quotes: quotes.map((q) => ({ bucket: bucketOf(q.ownerAgent, byId.get(String(q.customer))), status: q.status })),
    overrides: overrides.map((o) => ({ bucket: bucketOf(o.agent, byId.get(String(o.customer))) })),
    newCustomers: createdByAgents.map((c) => ({ bucket: bucketOf(c.createdByAgent, c) })),
  };

  // How orders arrived, so assisted sales are never mixed up with the rest.
  const sources = {};
  for (const o of orders) {
    const key = o.source === "sales_agent" ? "assisted" : "other";
    sources[key] = sources[key] || { orders: 0, revenue: {} };
    sources[key].orders += 1;
    sources[key].revenue[o.currency] = Math.round(((sources[key].revenue[o.currency] || 0) + o.totalPrice) * 100) / 100;
  }

  return { period, groupBy, ...aggregate(facts), sources };
}

// What needs attention now (spec §10.3 operational reports).
async function operationsReport(shop, now = new Date()) {
  const staleBefore = new Date(now.getTime() - 7 * DAY);
  const soon = new Date(now.getTime() + 3 * DAY);
  const dayAgo = new Date(now.getTime() - DAY);

  const [pending, staleCarts, expiringQuotes, failedEvents, backlog, denials] = await Promise.all([
    OverrideRequest.find({ shop, status: "PENDING_APPROVAL" }).select("createdAt route").lean(),
    AgentCart.countDocuments({ shop, "items.0": { $exists: true }, updatedAt: { $lt: staleBefore } }),
    Quote.countDocuments({ shop, status: "SENT", expiresAt: { $gt: now, $lte: soon } }),
    OutboxEvent.countDocuments({ shop, status: "failed" }),
    OutboxEvent.countDocuments({ shop, status: { $in: ["pending", "sending"] }, occurredAt: { $lt: new Date(now.getTime() - 10 * 60 * 1000) } }),
    AuditEvent.aggregate([
      { $match: { shop, occurredAt: { $gte: dayAgo }, outcome: { $in: ["denied", "failure"] }, actorType: "sales_agent", actorShopifyCustomerId: { $exists: true } } },
      { $group: { _id: "$actorShopifyCustomerId", count: { $sum: 1 } } },
      { $match: { count: { $gte: 5 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]),
  ]);

  const breached = pending.filter((p) => {
    const sla = (p.route && p.route.slaHours) || 24;
    return now.getTime() - new Date(p.createdAt).getTime() > sla * 60 * 60 * 1000;
  }).length;
  const oldest = pending.length ? Math.max(...pending.map((p) => now.getTime() - new Date(p.createdAt).getTime())) : 0;

  return {
    pendingApprovals: { count: pending.length, slaBreaches: breached, oldestHours: Math.round(oldest / 36e5) },
    staleCarts: { count: staleCarts, days: 7 },
    expiringQuotes: { count: expiringQuotes, days: 3 },
    // With no webhook address set, events simply wait: that is not a fault.
    integrations: { failed: failedEvents, backlog, webhookConfigured: !!process.env.AGENT_EVENTS_WEBHOOK_URL },
    accessAnomalies: denials.map((d) => ({ agent: d._id, deniedLast24h: d.count })),
  };
}

module.exports = { ReportError, aggregate, parsePeriod, salesReport, operationsReport, GROUPS };
