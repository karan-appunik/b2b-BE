const offline = require("../services/offlineCapture.service");
const { findAgentByShopifyId } = require("../services/agentAccess.service");

function fail(res, err) {
  if (err && err.code && err.statusCode) return res.status(err.statusCode).json({ code: err.code, message: err.message });
  throw err;
}

// POST /api/internal/agent/offline-captures — { captures: [...] } from a device
// that was offline. Each one is answered on its own.
async function receive(req, res, next) {
  try {
    const agent = await findAgentByShopifyId(req.body.shop, req.body.agentShopifyCustomerId);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    const results = await offline.receive({ shop: req.body.shop, agent, captures: req.body.captures });
    res.status(200).json({ results });
  } catch (err) {
    try { return fail(res, err); } catch (e) { next(e); }
  }
}

// GET /api/internal/agent/offline-captures — what is waiting for this agent.
async function list(req, res, next) {
  try {
    const agent = await findAgentByShopifyId(req.query.shop, req.query.agentShopifyCustomerId);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    const settings = await offline.settingsFor(req.query.shop);
    res.status(200).json({ enabled: settings.enabled, captures: settings.enabled ? await offline.listPending({ shop: req.query.shop, agent }) : [] });
  } catch (err) {
    next(err);
  }
}

// POST /api/internal/agent/offline-captures/:id/resolve — { outcome: "ADDED" | "DISCARDED" }
async function resolve(req, res, next) {
  try {
    const agent = await findAgentByShopifyId(req.body.shop, req.body.agentShopifyCustomerId);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    const doc = await offline.resolve({ shop: req.body.shop, agent, id: req.params.id, outcome: req.body.outcome });
    res.status(200).json({ id: String(doc._id), status: doc.status });
  } catch (err) {
    try { return fail(res, err); } catch (e) { next(e); }
  }
}

module.exports = { receive, list, resolve };
