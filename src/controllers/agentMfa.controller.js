const Customer = require("../models/customer.model");
const { findAgentByShopifyId } = require("../services/agentAccess.service");
const { getRole } = require("../services/role.service");
const mfa = require("../services/mfa.service");

// Internal endpoints the storefront portal uses (through the app proxy) so an
// agent can set up and answer the authenticator-app check. The agent is
// always identified by the signed storefront login, never by the request body.

async function agentFrom(source) {
  const { shop, agentShopifyCustomerId } = source;
  if (!agentShopifyCustomerId) return null;
  return findAgentByShopifyId(shop, agentShopifyCustomerId);
}

// GET /api/internal/agent/mfa/status
async function getStatus(req, res, next) {
  try {
    const agent = await agentFrom(req.query);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    const role = await getRole(req.query.shop, agent.role);
    res.status(200).json({ required: !!(role && role.requireMfa), ...mfa.describe(agent) });
  } catch (err) {
    next(err);
  }
}

// POST /api/internal/agent/mfa/enroll — returns the secret to add to an
// authenticator app. Nothing is switched on until a code is confirmed.
async function enroll(req, res, next) {
  try {
    const agent = await agentFrom(req.body);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    const result = await mfa.beginEnrollment(agent);
    if (!result.ok) {
      return res.status(409).json({ code: "ALREADY_ENROLLED", message: "An authenticator is already set up" });
    }

    res.status(200).json({ secret: result.secret, otpauthUrl: result.otpauthUrl });
  } catch (err) {
    next(err);
  }
}

// POST /api/internal/agent/mfa/verify — body: { code, purpose }
async function verifyCode(req, res, next) {
  try {
    const agent = await agentFrom(req.body);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    const purpose = req.body.purpose === "step_up" ? "step_up" : "session";
    const result = await mfa.verify(req.body.shop, agent._id, req.body.code, purpose);

    if (!result.ok) {
      const status = result.reason === "LOCKED" ? 429 : result.reason === "NOT_ENROLLED" ? 409 : 401;
      return res.status(status).json({
        code: result.reason,
        message:
          result.reason === "LOCKED"
            ? "Too many wrong codes. Try again in a few minutes."
            : result.reason === "NOT_ENROLLED"
              ? "Set up an authenticator first."
              : "That code isn't right.",
        lockedUntil: result.lockedUntil || null,
      });
    }

    res.status(200).json({ verified: true, until: result.until, enrolled: result.enrolled });
  } catch (err) {
    next(err);
  }
}

// POST /api/agents/:agentId/mfa/reset — merchant clears an agent's MFA.
async function resetMfa(req, res, next) {
  try {
    const agent = await Customer.findOne({ _id: req.params.agentId, shop: req.user.shop });
    if (!agent) return res.status(404).json({ message: "Agent not found" });

    await mfa.reset(req.user.shop, agent._id, req.user._id);
    res.status(200).json({ message: "Authenticator reset. The agent will set up a new one next time." });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStatus, enroll, verifyCode, resetMfa };
