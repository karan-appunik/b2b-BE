const mongoose = require("mongoose");

const Customer = require("../models/customer.model");
const CustomerGroup = require("../models/customerGroup.model");
const AgentScopeGrant = require("../models/agentScopeGrant.model");
const { CUSTOMER_ROLE } = require("../config/permissions");
const { getRole, hasGlobalScope } = require("../services/role.service");
const { AUDIT_ACTIONS, recordAudit } = require("../services/audit.service");

// Grant changes are done by a merchant-panel user acting on an agent's
// access, so the audit row's actor is the user and the agent is the object.
function grantAudit(req, agent, grant, action) {
  return recordAudit({
    shop: req.user.shop,
    actorType: "merchant_user",
    actor: req.user._id,
    action,
    objectType: "agent_scope_grant",
    objectId: String(grant._id),
    metadata: {
      agentId: String(agent._id),
      scopeType: grant.scopeType,
      scopeId: grant.scopeId,
      effect: grant.effect,
      validFrom: grant.validFrom,
      validTo: grant.validTo,
    },
  });
}

async function findAgent(req) {
  if (!mongoose.isValidObjectId(req.params.agentId)) return null;

  return Customer.findOne({
    _id: req.params.agentId,
    shop: req.user.shop,
    role: { $exists: true, $nin: [CUSTOMER_ROLE, null] },
  });
}

function parseDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function listGrants(req, res, next) {
  try {
    const agent = await findAgent(req);
    if (!agent) {
      return res.status(404).json({ message: "Agent not found" });
    }

    const grants = await AgentScopeGrant.find({ shop: req.user.shop, agent: agent._id }).sort({
      createdAt: -1,
    });
    res.status(200).json(grants);
  } catch (err) {
    next(err);
  }
}

// Checks a rule as typed in. Returns { error: { status, message } } or the
// cleaned-up rule.
async function parseGrant(req, agent) {
  {
    const { scopeType, scopeId, effect = "allow" } = req.body;
    const { SCOPE_TYPES, EFFECTS } = AgentScopeGrant;

    const bad = (status, message) => ({ error: { status, message } });

    if (!SCOPE_TYPES.includes(scopeType)) return bad(400, `scopeType must be one of: ${SCOPE_TYPES.join(", ")}`);
    if (!EFFECTS.includes(effect)) return bad(400, `effect must be one of: ${EFFECTS.join(", ")}`);

    const validFrom = parseDate(req.body.validFrom);
    const validTo = parseDate(req.body.validTo);
    if (validFrom === undefined || validTo === undefined) return bad(400, "validFrom and validTo must be valid dates");
    if (validFrom && validTo && validTo <= validFrom) return bad(400, "validTo must be after validFrom");

    let resolvedScopeId = null;

    if (scopeType === "all") {
      // An allow-all grant is only meaningful for roles configured for global
      // access; a deny-all is always a valid way to switch an agent off.
      if (effect === "allow" && !hasGlobalScope(await getRole(req.user.shop, agent.role))) {
        return bad(400, "Global access is not available for this agent role");
      }
    } else if (scopeType === "customer") {
      if (!mongoose.isValidObjectId(scopeId)) return bad(400, "scopeId must be a customer id");
      const customer = await Customer.findOne({ _id: scopeId, shop: req.user.shop });
      if (!customer) return bad(404, "Customer not found");
      resolvedScopeId = String(customer._id);
    } else if (scopeType === "group") {
      if (!mongoose.isValidObjectId(scopeId)) return bad(400, "scopeId must be a customer group id");
      const group = await CustomerGroup.findOne({ _id: scopeId, shop: req.user.shop });
      if (!group) return bad(404, "Customer group not found");
      resolvedScopeId = String(group._id);
    } else {
      const territory = typeof scopeId === "string" ? scopeId.trim() : "";
      if (!territory) return bad(400, "scopeId must be a territory name");
      resolvedScopeId = territory;
    }

    return { value: { scopeType, scopeId: resolvedScopeId, effect, validFrom, validTo } };
  }
}

// POST /api/agents/:agentId/scope-grants/preview — what a rule would do,
// without saving it (spec §4.1 Assignments "conflict preview").
async function previewGrantRule(req, res, next) {
  try {
    const agent = await findAgent(req);
    if (!agent) return res.status(404).json({ message: "Agent not found" });

    const parsed = await parseGrant(req, agent);
    if (parsed.error) return res.status(parsed.error.status).json({ message: parsed.error.message });

    res.status(200).json(await require("../services/grantPreview.service").previewGrant({ shop: req.user.shop, agent, grant: parsed.value }));
  } catch (err) {
    next(err);
  }
}

async function createGrant(req, res, next) {
  try {
    const agent = await findAgent(req);
    if (!agent) {
      return res.status(404).json({ message: "Agent not found" });
    }

    const parsed = await parseGrant(req, agent);
    if (parsed.error) return res.status(parsed.error.status).json({ message: parsed.error.message });
    const { scopeType, scopeId: resolvedScopeId, effect, validFrom, validTo } = parsed.value;

    const grant = await AgentScopeGrant.create({
      shop: req.user.shop,
      agent: agent._id,
      scopeType,
      scopeId: resolvedScopeId,
      effect,
      validFrom,
      validTo,
      createdBy: req.user._id,
    });

    await grantAudit(req, agent, grant, AUDIT_ACTIONS.GRANT_CREATED);

    res.status(201).json(grant);
  } catch (err) {
    next(err);
  }
}

async function deleteGrant(req, res, next) {
  try {
    const agent = await findAgent(req);
    if (!agent) {
      return res.status(404).json({ message: "Agent not found" });
    }

    if (!mongoose.isValidObjectId(req.params.grantId)) {
      return res.status(404).json({ message: "Grant not found" });
    }

    const grant = await AgentScopeGrant.findOneAndDelete({
      _id: req.params.grantId,
      shop: req.user.shop,
      agent: agent._id,
    });

    if (!grant) {
      return res.status(404).json({ message: "Grant not found" });
    }

    await grantAudit(req, agent, grant, AUDIT_ACTIONS.GRANT_DELETED);

    res.status(200).json({ message: "Grant deleted" });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  previewGrantRule, listGrants, createGrant, deleteGrant };
