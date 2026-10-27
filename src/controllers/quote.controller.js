const mongoose = require("mongoose");

const Quote = require("../models/quote.model");
const { validateContext } = require("../services/agentContext.service");
const { findAgentByShopifyId, authorizeAgent } = require("../services/agentAccess.service");
const quotes = require("../services/quote.service");

// Quotes for the three kinds of caller: the agent who owns them (and managers
// who approve them), the buyer they are sent to, and the merchant panel. The
// agent or buyer is always the signed-in storefront shopper; a buyer can only
// ever reach quotes sent to them, and sees them without internal details.

function fail(res, err) {
  if (err instanceof quotes.QuoteError) {
    return res.status(err.statusCode).json({ code: err.code, message: err.message });
  }
  throw err;
}

function guard(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      try {
        fail(res, err);
      } catch (unexpected) {
        next(unexpected);
      }
    }
  };
}

function notFound(res) {
  return res.status(404).json({ code: "NOT_FOUND", message: "Quote not found" });
}

async function loadQuote(shop, id) {
  if (!mongoose.isValidObjectId(id)) return null;
  return Quote.findOne({ _id: id, shop });
}

async function ownerAgent(source, res) {
  const agent = await findAgentByShopifyId(source.shop, source.agentShopifyCustomerId);
  if (!agent) {
    res.status(403).json({ message: "Not authorized" });
    return null;
  }
  return agent;
}

async function show(quote, options = {}) {
  const version = await quotes.currentVersion(quote);
  const out = quotes.present({ quote, version }, options);

  if (!options.forBuyer) {
    const Customer = require("../models/customer.model");
    const customer = await Customer.findById(quote.customer).select("name company shopifyCustomerId");
    out.customerName = customer ? customer.name : null;
    out.customerCompany = customer ? customer.company || null : null;
    out.customerShopifyId = customer ? customer.shopifyCustomerId || null : null;
  }

  return out;
}

// ---- the agent

// POST /api/internal/agent/quotes — creates a quote from the lines the
// storefront proxy resolved (titles, SKUs, baseline and agreed prices).
const createQuote = guard(async (req, res) => {
  const { shop, agentShopifyCustomerId, contextId } = req.body;

  if (!agentShopifyCustomerId || !mongoose.isValidObjectId(contextId)) {
    return res.status(401).json({ code: "CONTEXT_REQUIRED", message: "Customer context is required" });
  }

  const context = await validateContext({ shop, contextId, agentShopifyCustomerId });
  if (!context.valid) {
    return res.status(401).json({ code: context.reason, message: "Customer context is required" });
  }

  const { quote, version } = await quotes.createQuote({
    shop,
    agent: context.agent,
    customer: context.customer,
    input: req.body,
  });

  res.status(201).json(quotes.present({ quote, version }));
});

const listOwned = guard(async (req, res) => {
  const agent = await ownerAgent(req.query, res);
  if (!agent) return;

  const Customer = require("../models/customer.model");
  const { getSettings } = require("../services/override.service");

  const rows = await quotes.listOwned(req.query.shop, agent);
  const settings = await getSettings(req.query.shop);
  const people = await Customer.find({ _id: { $in: [...new Set(rows.map((r) => String(r.quote.customer)))] } }).select("name company");
  const byId = new Map(people.map((p) => [String(p._id), p]));

  res.status(200).json({
    quotes: rows.map((r) => ({
      ...quotes.present(r),
      customerName: (byId.get(String(r.quote.customer)) || {}).name || null,
      requiresApproval: r.version ? quotes.needsApproval(r.version, settings) : false,
    })),
  });
});

// The owner, an approver, or (for an approval) a manager may read a quote.
const getQuote = guard(async (req, res) => {
  const agent = await ownerAgent(req.query, res);
  if (!agent) return;

  const quote = await loadQuote(req.query.shop, req.params.id);
  if (!quote) return notFound(res);

  const isOwner = String(quote.ownerAgent) === String(agent._id);
  const mayApprove = !isOwner && (await authorizeAgent(req.query.shop, agent, "approval.decide")).allowed;
  if (!isOwner && !mayApprove) return notFound(res);

  res.status(200).json(await show(quote));
});

// Runs an action on a quote the agent owns, then returns the quote.
function ownerAction(run) {
  return guard(async (req, res) => {
    const agent = await ownerAgent(req.body, res);
    if (!agent) return;

    const quote = await loadQuote(req.body.shop, req.params.id);
    // Someone else's quote looks the same as a missing one, whatever the action.
    if (!quote || String(quote.ownerAgent) !== String(agent._id)) return notFound(res);

    const result = await run({ shop: req.body.shop, quote, agent, body: req.body });
    // Some actions return a new quote (duplicate) or a { quote, version } pair.
    const target = result.quote ? result : { quote: result };

    res.status(200).json(await show(target.quote));
  });
}

const editQuote = ownerAction(({ shop, quote, agent, body }) => quotes.editQuote({ shop, quote, agent, input: body }));
const submitQuote = ownerAction(({ shop, quote, agent }) => quotes.submitForApproval({ shop, quote, agent }));
const sendQuote = ownerAction(({ shop, quote, agent }) => quotes.sendQuote({ shop, quote, agent }));
const withdrawQuote = ownerAction(({ shop, quote, agent }) => quotes.withdrawQuote({ shop, quote, agent }));
const reviseQuote = ownerAction(({ shop, quote, agent }) => quotes.reviseQuote({ shop, quote, agent }));
const duplicateQuote = ownerAction(({ shop, quote, agent }) => quotes.duplicateQuote({ shop, quote, agent }));

// POST /api/internal/agent/quotes/:id/converted — the storefront proxy has
// created the order; this records it. Needs the right to place orders.
const markConverted = ownerAction(async ({ shop, quote, agent, body }) => {
  if (!(await authorizeAgent(shop, agent, "order.submit")).allowed) {
    throw new quotes.QuoteError("PERMISSION_DENIED", "Your role can't place orders", 403);
  }
  if (!String(body.orderId || "").trim()) throw new quotes.QuoteError("ORDER_REQUIRED", "orderId is required");

  return quotes.markConverted({ shop, quote, agent, orderId: body.orderId });
});

// GET /api/internal/agent/quote-approvals — quotes waiting for this agent.
const listApprovals = guard(async (req, res) => {
  const agent = await ownerAgent(req.query, res);
  if (!agent) return;

  const { items, needsStepUp } = await quotes.listPendingApproval(req.query.shop, { kind: "agent", agent });
  res.status(200).json({ needsStepUp, quotes: items.map((r) => quotes.present(r)) });
});

const decideApproval = guard(async (req, res) => {
  const agent = await ownerAgent(req.body, res);
  if (!agent) return;
  if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);

  const quote = await quotes.decideQuote({
    shop: req.body.shop,
    quoteId: req.params.id,
    approver: { kind: "agent", agent },
    decision: req.body.decision,
    comment: req.body.comment,
  });

  res.status(200).json(await show(quote));
});

// ---- the buyer

function buyerId(source) {
  return String(source.buyerShopifyCustomerId || "");
}

const listForBuyer = guard(async (req, res) => {
  const rows = await quotes.listForBuyer(req.query.shop, buyerId(req.query));
  res.status(200).json({ quotes: rows.map((r) => quotes.present(r, { forBuyer: true })) });
});

const getForBuyer = guard(async (req, res) => {
  const rows = await quotes.listForBuyer(req.query.shop, buyerId(req.query));
  const row = rows.find((r) => String(r.quote._id) === String(req.params.id));
  if (!row) return notFound(res);

  res.status(200).json(quotes.present(row, { forBuyer: true }));
});

const respond = guard(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);

  const quote = await quotes.respondToQuote({
    shop: req.body.shop,
    quoteId: req.params.id,
    buyerShopifyCustomerId: buyerId(req.body),
    action: req.body.action,
    comment: req.body.comment,
  });

  res.status(200).json(await show(quote, { forBuyer: true }));
});

// ---- the merchant panel

const listForMerchant = guard(async (req, res) => {
  const shop = req.user.shop;
  await quotes.expireDue(shop);

  const filter = { shop };
  if (req.query.status && req.query.status !== "all") {
    if (!Quote.STATUSES.includes(req.query.status)) return res.status(400).json({ message: "Unknown status" });
    filter.status = req.query.status;
  }

  const found = await Quote.find(filter).sort({ updatedAt: -1 }).limit(200);
  const rows = found.length ? await quotes.withVersions(found) : [];

  const Customer = require("../models/customer.model");
  const people = await Customer.find({
    _id: { $in: [...new Set(found.flatMap((q) => [String(q.customer), String(q.ownerAgent)]))] },
  }).select("name company");
  const byId = new Map(people.map((p) => [String(p._id), p]));

  res.status(200).json({
    quotes: rows.map((r) => ({
      ...quotes.present(r),
      customerName: (byId.get(String(r.quote.customer)) || {}).name || null,
      customerCompany: (byId.get(String(r.quote.customer)) || {}).company || null,
      ownerName: (byId.get(String(r.quote.ownerAgent)) || {}).name || null,
    })),
  });
});

const getForMerchant = guard(async (req, res) => {
  const quote = await loadQuote(req.user.shop, req.params.id);
  if (!quote) return notFound(res);

  res.status(200).json(await show(quote));
});

const decideForMerchant = guard(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);

  const quote = await quotes.decideQuote({
    shop: req.user.shop,
    quoteId: req.params.id,
    approver: { kind: "merchant_user", user: req.user },
    decision: req.body.decision,
    comment: req.body.comment,
  });

  res.status(200).json(await show(quote));
});

module.exports = {
  createQuote,
  listOwned,
  getQuote,
  editQuote,
  submitQuote,
  sendQuote,
  withdrawQuote,
  reviseQuote,
  duplicateQuote,
  markConverted,
  listApprovals,
  decideApproval,
  listForBuyer,
  getForBuyer,
  respond,
  listForMerchant,
  getForMerchant,
  decideForMerchant,
};
