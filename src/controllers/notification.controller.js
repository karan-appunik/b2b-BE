const mongoose = require("mongoose");
const { findAgentByShopifyId } = require("../services/agentAccess.service");
const notifications = require("../services/notification.service");

// GET /api/internal/agent/notifications — the agent's in-app alerts.
async function list(req, res, next) {
  try {
    const agent = await findAgentByShopifyId(req.query.shop, req.query.agentShopifyCustomerId);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    res.status(200).json(await notifications.listFor(req.query.shop, agent));
  } catch (err) {
    next(err);
  }
}

// POST /api/internal/agent/notifications/read — { ids? } (none = all of them)
async function read(req, res, next) {
  try {
    const agent = await findAgentByShopifyId(req.body.shop, req.body.agentShopifyCustomerId);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((id) => mongoose.isValidObjectId(id)) : [];
    res.status(200).json({ marked: await notifications.markRead(req.body.shop, agent, ids) });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, read };
