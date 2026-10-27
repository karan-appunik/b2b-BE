const mongoose = require("mongoose");

const { findAgentByShopifyId } = require("../services/agentAccess.service");
const { validateContext } = require("../services/agentContext.service");
const svc = require("../services/customerCreate.service");

function guard(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof svc.CustomerCreateError) {
        return res.status(err.statusCode).json({ code: err.code, message: err.message, ...err.extra });
      }
      next(err);
    }
  };
}

async function agentFrom(body, res) {
  const agent = await findAgentByShopifyId(body.shop, body.agentShopifyCustomerId);
  if (!agent) {
    res.status(403).json({ message: "Not authorized" });
    return null;
  }
  return agent;
}

// POST /api/internal/agent/customers/check
const check = guard(async (req, res) => {
  const agent = await agentFrom(req.body, res);
  if (!agent) return;

  const result = await svc.check({
    shop: req.body.shop,
    agent,
    input: req.body.customer,
    confirmNotDuplicate: req.body.confirmNotDuplicate,
  });

  res.status(200).json({ ok: true, tags: result.tags, duplicatesConfirmed: result.duplicatesConfirmed });
});

// POST /api/internal/agent/customers/record
const record = guard(async (req, res) => {
  const agent = await agentFrom(req.body, res);
  if (!agent) return;

  const customer = await svc.record({
    shop: req.body.shop,
    agent,
    shopifyCustomerId: req.body.shopifyCustomerId,
    input: req.body.customer,
    duplicatesConfirmed: req.body.duplicatesConfirmed,
  });

  res.status(201).json({ id: customer._id, provisional: customer.provisional });
});

// POST /api/internal/agent/addresses/record — the storefront added an address
// for the customer in the agent's live context.
const recordAddress = guard(async (req, res) => {
  if (!mongoose.isValidObjectId(req.body.contextId)) return res.status(403).json({ code: "CONTEXT_REQUIRED", message: "No active customer context" });
  const live = await validateContext({
    shop: req.body.shop,
    contextId: req.body.contextId,
    agentShopifyCustomerId: req.body.agentShopifyCustomerId,
  });
  if (!live.valid) return res.status(403).json({ code: "CONTEXT_REQUIRED", message: "No active customer context" });

  await svc.recordAddress({ shop: req.body.shop, agent: live.agent, customer: live.customer, address: req.body.address });
  res.status(201).json({ ok: true });
});

// ---- merchant panel

const list = guard(async (req, res) => {
  res.status(200).json({ customers: await svc.listProvisional(req.user.shop) });
});

const approve = guard(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ code: "NOT_FOUND", message: "No provisional customer found" });

  await svc.approveProvisional({ shop: req.user.shop, customerId: req.params.id, user: req.user });
  res.status(200).json({ ok: true });
});

module.exports = { recordAddress, check, record, list, approve };
