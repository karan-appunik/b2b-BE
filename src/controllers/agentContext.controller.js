const mongoose = require("mongoose");

const { PERMISSION_KEYS } = require("../config/permissions");
const { findAgentByShopifyId, authorizeAgent } = require("../services/agentAccess.service");
const { getSettings } = require("../services/override.service");

const {
  enterContext,
  validateContext,
  getCurrentContext,
  revokeSession,
  customerSummary,
  refreshContext,
  SENSITIVE_PERMISSIONS,
} = require("../services/agentContext.service");

// One generic answer for every denial — never reveal whether an
// unauthorized customer exists (spec §7.1).
function accessDenied(res) {
  return res.status(403).json({
    code: "CUSTOMER_ACCESS_DENIED",
    message: "You do not have access to this customer",
  });
}

function contextRequired(res, reason = "CONTEXT_REQUIRED") {
  const message =
    reason === "CONTEXT_EXPIRED"
      ? "Customer context has expired"
      : reason === "CONTEXT_REVOKED"
        ? "Customer context is no longer valid"
        : reason === "MFA_REQUIRED"
          ? "Enter your authenticator code to continue"
          : reason === "CONTEXT_STALE"
            ? "Your access has changed since you started. Refresh to carry on."
          : "Customer context is required";

  return res.status(401).json({ code: reason, message });
}

function contextPayload(session, customer, stale = false) {
  return {
    state: stale ? "STALE" : "ACTIVE",
    contextId: session._id,
    channel: session.channel,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    customer: customerSummary(customer),
  };
}

// POST /api/internal/agent/contexts
async function createContext(req, res, next) {
  try {
    const { shop, agentShopifyCustomerId, customerId, channel, clientIp, userAgent } = req.body;

    if (!agentShopifyCustomerId || !mongoose.isValidObjectId(customerId)) {
      return res.status(400).json({ message: "agentShopifyCustomerId and customerId are required" });
    }

    const result = await enterContext({
      shop,
      agentShopifyCustomerId,
      customerId,
      channel,
      meta: { clientIp, userAgent },
    });

    if (!result.ok) {
      // MFA is about the agent's own sign-in state, not about any customer, so
      // saying so reveals nothing — and the portal needs it to prompt.
      if (result.reason === "MFA_REQUIRED") {
        return res.status(403).json({ code: "MFA_REQUIRED", message: "Enter your authenticator code to continue" });
      }
      return accessDenied(res);
    }

    res.status(201).json(contextPayload(result.session, result.customer));
  } catch (err) {
    next(err);
  }
}

// GET /api/internal/agent/contexts/current
async function readCurrentContext(req, res, next) {
  try {
    const { shop, agentShopifyCustomerId } = req.query;

    if (!agentShopifyCustomerId) {
      return res.status(400).json({ message: "agentShopifyCustomerId is required" });
    }

    const result = await getCurrentContext({ shop, agentShopifyCustomerId });
    if (!result.valid) {
      return res.status(200).json({ active: false });
    }

    res.status(200).json({ active: true, ...contextPayload(result.session, result.customer, result.stale) });
  } catch (err) {
    next(err);
  }
}

// GET /api/internal/agent/contexts/:id/validate — for services that need to
// confirm a context before acting on it (cart, quote, order).
// POST /api/internal/agent/contexts/:id/refresh — the agent confirms the
// changed access and carries on.
async function refreshContextById(req, res, next) {
  try {
    const { shop, agentShopifyCustomerId } = req.body;
    if (!agentShopifyCustomerId || !mongoose.isValidObjectId(req.params.id)) return contextRequired(res);

    const result = await refreshContext({ shop, contextId: req.params.id, agentShopifyCustomerId });
    if (!result.valid) return contextRequired(res, result.reason);

    res.status(200).json({ active: true, ...contextPayload(result.session, result.customer, false) });
  } catch (err) {
    next(err);
  }
}

async function validateContextById(req, res, next) {
  try {
    const { shop, agentShopifyCustomerId } = req.query;

    if (!agentShopifyCustomerId || !mongoose.isValidObjectId(req.params.id)) {
      return contextRequired(res);
    }

    const result = await validateContext({
      shop,
      contextId: req.params.id,
      agentShopifyCustomerId,
    });

    if (!result.valid) {
      return contextRequired(res, result.reason);
    }

    res.status(200).json(contextPayload(result.session, result.customer));
  } catch (err) {
    next(err);
  }
}

// DELETE /api/internal/agent/contexts/:id
async function exitContext(req, res, next) {
  try {
    const { shop, agentShopifyCustomerId } = req.query;

    if (!agentShopifyCustomerId || !mongoose.isValidObjectId(req.params.id)) {
      return contextRequired(res);
    }

    const result = await validateContext({
      shop,
      contextId: req.params.id,
      agentShopifyCustomerId,
    });

    // validateContext already revoked it if access was lost; an expired or
    // already-ended context is simply treated as exited.
    if (result.valid) {
      await revokeSession(result.session, "EXIT");
    }

    res.status(200).json({ active: false });
  } catch (err) {
    next(err);
  }
}

// POST /api/internal/agent/authorize — asks whether an agent may do
// something right now, so other services (checkout, address book) enforce
// the same server-side rules instead of trusting the browser. When a
// contextId is given it must also be a live context for that agent. Returns
// the permission's constraints (e.g. a price-change ceiling) when allowed.
async function authorizeAction(req, res, next) {
  try {
    const { shop, agentShopifyCustomerId, contextId, permission } = req.body;

    if (!agentShopifyCustomerId || !PERMISSION_KEYS.includes(permission)) {
      return res.status(400).json({ message: "agentShopifyCustomerId and a known permission are required" });
    }

    if (contextId !== undefined && contextId !== null) {
      if (!mongoose.isValidObjectId(contextId)) return contextRequired(res);

      const result = await validateContext({ shop, contextId, agentShopifyCustomerId, sensitive: SENSITIVE_PERMISSIONS.includes(permission) });
      if (!result.valid) return contextRequired(res, result.reason);
    }

    const agent = await findAgentByShopifyId(shop, agentShopifyCustomerId);
    if (!agent) return res.status(200).json({ allowed: false });

    const decision = await authorizeAgent(shop, agent, permission);

    if (decision.allowed && permission === "order.submit" && contextId) {
      const live = await validateContext({ shop, contextId, agentShopifyCustomerId });
      const settings = await getSettings(shop);
      if (live.valid && live.customer.provisional && settings.provisionalOrdering === "block") {
        return res.status(200).json({ allowed: false, reason: "ACCOUNT_PENDING_APPROVAL" });
      }
    }

    res.status(200).json({
      allowed: decision.allowed,
      constraints: decision.constraints || null,
      ...(decision.stepUpRequired ? { reason: "STEP_UP_REQUIRED" } : {}),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { refreshContextById, createContext, readCurrentContext, validateContextById, exitContext, authorizeAction };
