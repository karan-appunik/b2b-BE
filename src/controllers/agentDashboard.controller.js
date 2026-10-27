const Customer = require("../models/customer.model");
const Order = require("../models/order.model");
const { markSimilar } = require("../services/customerSummary.service");
const Quote = require("../models/quote.model");
const AgentCart = require("../models/agentCart.model");
const AgentPin = require("../models/agentPin.model");
const ContextSession = require("../models/contextSession.model");
const overrides = require("../services/override.service");
const { checkCustomerAccess } = require("../services/agentAccess.service");
const { AUDIT_ACTIONS, recordAudit } = require("../services/audit.service");

const MAX_PINS = 10;
const {
  findAgentByShopifyId,
  authorizeAgent,
  buildCustomerScopeFilter,
} = require("../services/agentAccess.service");

const ACCOUNT_LIST_LIMIT = 25;

function startOfMonthUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// GET /api/internal/agent/dashboard — what the Sales Agent Portal shows on
// load (spec §4.2): the accounts this agent may act for, plus this month's
// assisted orders and revenue. Everything is scoped to the agent's grants.
async function getAgentDashboard(req, res, next) {
  try {
    const { shop, agentShopifyCustomerId } = req.query;

    if (!agentShopifyCustomerId) {
      return res.status(400).json({ message: "agentShopifyCustomerId is required" });
    }

    const agent = await findAgentByShopifyId(shop, agentShopifyCustomerId);
    if (!agent || !(await authorizeAgent(shop, agent, "customer.search")).allowed) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const scopeFilter = await buildCustomerScopeFilter(shop, agent);

    // Agents never appear in their own account list, and only synced
    // Shopify customers can be ordered for.
    const accountFilter = scopeFilter
      ? { ...scopeFilter, _id: { $ne: agent._id }, shopifyCustomerId: { $exists: true, $ne: null } }
      : null;

    const [assignedCount, accounts, monthOrders] = await Promise.all([
      accountFilter ? Customer.countDocuments(accountFilter) : 0,
      accountFilter
        ? Customer.find(accountFilter)
            .select("name email company territory accountStatus")
            .sort({ name: 1 })
            .limit(ACCOUNT_LIST_LIMIT)
        : [],
      Order.find({
        shop,
        "placedByAgent.agent": agent._id,
        orderedAt: { $gte: startOfMonthUtc() },
      }).select("totalPrice currency"),
    ]);

    // Money is reported per currency — a shop can sell in several and
    // adding across currencies would be meaningless.
    const revenueByCurrency = {};
    for (const order of monthOrders) {
      revenueByCurrency[order.currency] = (revenueByCurrency[order.currency] || 0) + order.totalPrice;
    }

    // Spec §4.2: open carts, pending quotes, approvals that need this agent,
    // and the accounts worked on lately or pinned.
    const [openCarts, pendingQuotes, approvals, pinRows, recentRows] = await Promise.all([
      AgentCart.find({ shop, agent: agent._id, "items.0": { $exists: true } }).sort({ updatedAt: -1 }).select("customer updatedAt").lean(),
      Quote.countDocuments({ shop, ownerAgent: agent._id, status: { $in: ["PENDING_APPROVAL", "SENT", "CHANGES_REQUESTED"] } }),
      overrides.pendingFor({ shop, approver: { kind: "agent", agent } }),
      AgentPin.find({ shop, agent: agent._id }).select("customer").lean(),
      ContextSession.find({ shop, agent: agent._id }).sort({ issuedAt: -1 }).limit(30).select("customer").lean(),
    ]);

    const pinnedIds = new Set(pinRows.map((p) => String(p.customer)));
    const recentIds = [...new Set(recentRows.map((r) => String(r.customer)))].slice(0, 5);

    // Only accounts the agent can still act for are shown, whatever was pinned or visited.
    const mark = (ids) => (accountFilter && ids.length ? Customer.find({ $and: [accountFilter, { _id: { $in: ids } }] }).select("name email company territory accountStatus").lean() : []);
    const [pinnedAccounts, recentAccounts] = await Promise.all([mark([...pinnedIds]), mark(recentIds)]);
    const present = (c) => ({ id: c._id, name: c.name, email: c.email, company: c.company || null, territory: c.territory || null, status: c.accountStatus || "active" });
    const order = (list, ids) => ids.map((id) => list.find((c) => String(c._id) === id)).filter(Boolean);

    res.status(200).json({
      agent: { name: agent.name, email: agent.email, role: agent.role },
      assignedCount,
      metrics: {
        openCarts: openCarts.length,
        pendingQuotes,
        approvalsToDecide: approvals.requests.length,
      },
      pinned: markSimilar(pinnedAccounts.map(present)).map((a) => ({ ...a, pinned: true })),
      recent: order(recentAccounts, recentIds).map((c) => ({ ...present(c), pinned: pinnedIds.has(String(c._id)) })),
      cartAccounts: openCarts.slice(0, 5).map((c) => String(c.customer)),
      accounts: markSimilar(
        accounts.map((c) => ({
          id: c._id,
          name: c.name,
          email: c.email,
          company: c.company || null,
          territory: c.territory || null,
          status: c.accountStatus || "active",
        }))
      ).map((a) => ({ ...a, pinned: pinnedIds.has(String(a.id)) })),
      month: {
        orders: monthOrders.length,
        revenue: Object.entries(revenueByCurrency).map(([currency, amount]) => ({ currency, amount })),
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/internal/agent/pins — { customerId, pinned } keeps an account at
// the top of the dashboard, or lets it go. Pinning needs access to the account.
async function setPin(req, res, next) {
  try {
    const { shop, agentShopifyCustomerId, customerId, pinned } = req.body;
    const agent = await findAgentByShopifyId(shop, agentShopifyCustomerId);
    if (!agent || !(await authorizeAgent(shop, agent, "customer.search")).allowed) {
      return res.status(403).json({ message: "Not authorized" });
    }
    if (!require("mongoose").isValidObjectId(customerId)) return res.status(404).json({ code: "NOT_FOUND", message: "Account not found" });

    const customer = await Customer.findOne({ _id: customerId, shop });
    const access = customer ? await checkCustomerAccess(shop, agent, customer) : { allowed: false };
    if (!access.allowed) return res.status(404).json({ code: "NOT_FOUND", message: "Account not found" });

    if (pinned === false) {
      await AgentPin.deleteOne({ shop, agent: agent._id, customer: customer._id });
      return res.status(200).json({ pinned: false });
    }

    if (!(await AgentPin.findOne({ shop, agent: agent._id, customer: customer._id }))) {
      if ((await AgentPin.countDocuments({ shop, agent: agent._id })) >= MAX_PINS) {
        return res.status(400).json({ code: "TOO_MANY_PINS", message: `You can pin up to ${MAX_PINS} accounts` });
      }
      await AgentPin.create({ shop, agent: agent._id, customer: customer._id });
    }
    res.status(200).json({ pinned: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAgentDashboard, setPin };
