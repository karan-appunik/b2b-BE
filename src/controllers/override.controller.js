const mongoose = require("mongoose");

const OverrideRequest = require("../models/overrideRequest.model");
const AgentSettings = require("../models/agentSettings.model");
const { validateContext } = require("../services/agentContext.service");
const { findAgentByShopifyId } = require("../services/agentAccess.service");
const { AUDIT_ACTIONS, recordAudit } = require("../services/audit.service");
const overrides = require("../services/override.service");
const approvalLinks = require("../services/approvalLink.service");

// Endpoints the storefront uses for an agent's own exceptions and for agents
// who approve. The agent is always the signed-in storefront shopper; the
// customer always comes from their live context, never from the request.

function fail(res, err) {
  if (err instanceof overrides.OverrideError) {
    return res.status(err.statusCode).json({ code: err.code, message: err.message });
  }
  throw err;
}

function contextRequired(res, reason = "CONTEXT_REQUIRED") {
  const message = reason === "CONTEXT_STALE" ? "Your access changed since you started. Use Refresh in the Agent Mode bar, then try again." : "Customer context is required";
  return res.status(401).json({ code: reason, message });
}

async function liveContext(source, res, { sensitive = false } = {}) {
  const { shop, agentShopifyCustomerId, contextId } = source;

  if (!agentShopifyCustomerId || !mongoose.isValidObjectId(contextId)) {
    contextRequired(res);
    return null;
  }

  const result = await validateContext({ shop, contextId, agentShopifyCustomerId, sensitive });
  if (!result.valid) {
    contextRequired(res, result.reason);
    return null;
  }

  return result;
}

function present(request) {
  const r = request.toObject ? request.toObject() : request;
  return {
    id: r._id,
    type: r.type,
    status: r.status,
    denyReason: r.denyReason || null,
    lineVariantId: r.lineVariantId || null,
    // The quantity the exception was approved for (line-level exceptions).
    snapshotQuantity: r.snapshot && r.snapshot.quantity !== undefined ? r.snapshot.quantity : null,
    custom: r.custom && r.custom.title
      ? { title: r.custom.title, quantity: r.custom.quantity, taxable: r.custom.taxable !== false, taxCode: r.custom.taxCode || null, accountingCode: r.custom.accountingCode || null }
      : null,
    rule: r.rule || null,
    address: r.address && r.address.address1 ? r.address : null,
    baseline: r.baseline,
    proposed: r.proposed,
    deltaPercent: r.deltaPercent,
    reasonCode: r.reasonCode,
    reasonText: r.reasonText,
    expiresAt: r.expiresAt || null,
    route: r.route ? { policyName: r.route.policyName, slaHours: r.route.slaHours } : null,
    decisions: (r.decisions || []).map((d) => ({ name: d.name, decision: d.decision, comment: d.comment, at: d.at })),
    createdAt: r.createdAt,
  };
}

// POST /api/internal/agent/overrides
async function createOverride(req, res, next) {
  try {
    const context = await liveContext(req.body, res, { sensitive: true });
    if (!context) return;

    const { type, lineVariantId, baseline, proposed, reasonCode, reasonText, custom, rule, address } = req.body;
    const request = await overrides.requestOverride({
      shop: req.body.shop,
      agent: context.agent,
      customer: context.customer,
      context: context.session,
      input: { type, lineVariantId, baseline, proposed, reasonCode, reasonText, custom, rule, address },
    });

    // Approvers get a link of their own (spec §8.4). Never holds up the answer.
    if (request.status === "PENDING_APPROVAL") {
      approvalLinks.issueForRequest(request).catch((err) => console.error("[approval] could not issue links", err));
    }

    res.status(201).json(present(request));
  } catch (err) {
    try { return fail(res, err); } catch (e) { next(e); }
  }
}

// GET /api/internal/agent/overrides — this agent's exceptions for the
// customer they are currently ordering for.
async function listOverrides(req, res, next) {
  try {
    const context = await liveContext(req.query, res);
    if (!context) return;

    await overrides.expireDue(req.query.shop);
    const requests = await OverrideRequest.find({
      shop: req.query.shop,
      agent: context.agent._id,
      customer: context.customer._id,
      status: { $nin: ["APPLIED", "CANCELLED"] },
    })
      .sort({ createdAt: -1 })
      .limit(50);

    const settings = await AgentSettings.findOne({ shop: req.query.shop }).select("featuresOff moduleEnabled").lean();
    const isEnabled = (!settings || settings.moduleEnabled !== false) && (!settings || !settings.featuresOff || !settings.featuresOff.includes("overrides"));

    res.status(200).json({ overrides: requests.map(present), enabled: isEnabled });
  } catch (err) {
    next(err);
  }
}

// POST /api/internal/agent/overrides/:id/cancel
async function cancelOverride(req, res, next) {
  try {
    const agent = await findAgentByShopifyId(req.body.shop, req.body.agentShopifyCustomerId);
    if (!agent || !mongoose.isValidObjectId(req.params.id)) return contextRequired(res);

    const request = await overrides.cancel({ shop: req.body.shop, requestId: req.params.id, agent });
    res.status(200).json(present(request));
  } catch (err) {
    try { return fail(res, err); } catch (e) { next(e); }
  }
}

// GET /api/internal/agent/overrides/usable — what checkout may apply now.
async function usableOverrides(req, res, next) {
  try {
    const context = await liveContext(req.query, res);
    if (!context) return;

    const usable = await overrides.usableForCart({
      shop: req.query.shop,
      agent: context.agent,
      customer: context.customer,
    });

    res.status(200).json({ overrides: usable.map(present) });
  } catch (err) {
    next(err);
  }
}

// POST /api/internal/agent/overrides/applied — checkout calls this once the
// order exists, so an exception can't be used on a second order.
async function markApplied(req, res, next) {
  try {
    const context = await liveContext(req.body, res);
    if (!context) return;

    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((id) => mongoose.isValidObjectId(id)) : [];
    const orderId = String(req.body.orderId || "");
    if (!orderId) return res.status(400).json({ message: "orderId is required" });

    const usable = await overrides.usableForCart({
      shop: req.body.shop,
      agent: context.agent,
      customer: context.customer,
    });
    const allowed = new Set(usable.map((u) => String(u._id)));

    const applied = [];
    for (const id of ids.filter((x) => allowed.has(String(x)))) {
      const request = await OverrideRequest.findOneAndUpdate(
        { _id: id, shop: req.body.shop, status: { $in: ["AUTO_APPROVED", "APPROVED"] } },
        { $set: { status: "APPLIED", appliedAt: new Date(), appliedOrderId: orderId } },
        { new: true }
      );
      if (!request) continue;

      applied.push(String(request._id));
      await recordAudit({
        shop: req.body.shop,
        actorType: "sales_agent",
        actor: context.agent._id,
        actorShopifyCustomerId: context.agent.shopifyCustomerId,
        customer: context.customer._id,
        contextId: context.session._id,
        action: AUDIT_ACTIONS.OVERRIDE_APPLIED,
        objectType: "override_request",
        objectId: String(request._id),
        metadata: { orderId, type: request.type, baseline: request.baseline, proposed: request.proposed },
      });
    }

    res.status(200).json({ applied });
  } catch (err) {
    next(err);
  }
}

// GET /api/internal/agent/approvals — pending requests this agent may decide.
async function listApprovals(req, res, next) {
  try {
    const agent = await findAgentByShopifyId(req.query.shop, req.query.agentShopifyCustomerId);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    const { requests, needsStepUp } = await overrides.pendingFor({
      shop: req.query.shop,
      approver: { kind: "agent", agent },
    });
    const described = await overrides.describeRequests(requests);

    res.status(200).json({
      needsStepUp,
      approvals: described.map((r) => ({
        ...present(r),
        agentName: r.agentName,
        customerName: r.customerName,
        customerCompany: r.customerCompany,
        impact: r.impact,
        history: r.history,
        commentRequired: !!(
          r.route && r.route.commentRequiredAbovePercent !== null && r.route.commentRequiredAbovePercent !== undefined &&
          r.deltaPercent > r.route.commentRequiredAbovePercent
        ),
      })),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/internal/agent/approvals/:id/decision — { decision, comment }
async function decideApproval(req, res, next) {
  try {
    const agent = await findAgentByShopifyId(req.body.shop, req.body.agentShopifyCustomerId);
    if (!agent || !mongoose.isValidObjectId(req.params.id)) return res.status(403).json({ message: "Not authorized" });

    const request = await overrides.decide({
      shop: req.body.shop,
      requestId: req.params.id,
      approver: { kind: "agent", agent },
      decision: req.body.decision,
      comment: req.body.comment,
    });

    res.status(200).json(present(request));
  } catch (err) {
    try { return fail(res, err); } catch (e) { next(e); }
  }
}

module.exports = {
  createOverride,
  listOverrides,
  cancelOverride,
  usableOverrides,
  markApplied,
  listApprovals,
  decideApproval,
};
