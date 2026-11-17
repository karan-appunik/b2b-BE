const mongoose = require("mongoose");

const Customer = require("../models/customer.model");
const PermissionGrant = require("../models/permissionGrant.model");
const { PERMISSION_CATALOG, CUSTOMER_ROLE } = require("../config/permissions");
const { AUDIT_ACTIONS, recordAudit } = require("../services/audit.service");

const MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

async function findAgent(req) {
  if (!mongoose.isValidObjectId(req.params.agentId)) return null;

  return Customer.findOne({
    _id: req.params.agentId,
    shop: req.user.shop,
    role: { $exists: true, $nin: [CUSTOMER_ROLE, null] },
  });
}

function grantAudit(req, agent, grant, action) {
  return recordAudit({
    shop: req.user.shop,
    actorType: "merchant_user",
    actor: req.user._id,
    action,
    objectType: "permission_grant",
    objectId: String(grant._id),
    metadata: {
      agentId: String(agent._id),
      permission: grant.permission,
      constraints: grant.constraints,
      reason: grant.reason,
      validFrom: grant.validFrom,
      validTo: grant.validTo,
    },
  });
}

function statusOf(grant, now = new Date()) {
  if (grant.revokedAt) return "revoked";
  if (grant.validFrom > now) return "scheduled";
  if (grant.validTo <= now) return "expired";
  return "active";
}

// GET /api/agents/:agentId/permission-grants
async function listPermissionGrants(req, res, next) {
  try {
    const agent = await findAgent(req);
    if (!agent) return res.status(404).json({ message: "Agent not found" });

    const grants = await PermissionGrant.find({ shop: req.user.shop, agent: agent._id }).sort({ createdAt: -1 });
    res.status(200).json(grants.map((g) => ({ ...g.toObject(), status: statusOf(g) })));
  } catch (err) {
    next(err);
  }
}

// POST /api/agents/:agentId/permission-grants — body: { permission, validTo,
// validFrom?, reason, constraints? }. Only high-risk permissions can be
// granted this way, for at most MAX_DAYS, and a reason is mandatory.
async function createPermissionGrant(req, res, next) {
  try {
    const agent = await findAgent(req);
    if (!agent) return res.status(404).json({ message: "Agent not found" });

    const { permission, constraints } = req.body;
    const reason = String(req.body.reason || "").trim();
    const item = PERMISSION_CATALOG.find((p) => p.key === permission);

    if (!item) return res.status(400).json({ message: "Unknown permission" });
    if (!item.highRisk) {
      return res.status(400).json({ message: "Only high-risk permissions can be granted temporarily" });
    }
    if (!reason) return res.status(400).json({ message: "A reason is required" });

    const now = new Date();
    const validFrom = req.body.validFrom ? new Date(req.body.validFrom) : now;
    const validTo = new Date(req.body.validTo);

    if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) {
      return res.status(400).json({ message: "validFrom and validTo must be valid dates" });
    }
    if (validTo <= now) return res.status(400).json({ message: "The end date must be in the future" });
    if (validTo <= validFrom) return res.status(400).json({ message: "The end date must be after the start" });
    if (validTo.getTime() - validFrom.getTime() > MAX_DAYS * DAY_MS) {
      return res.status(400).json({ message: `A temporary grant can last at most ${MAX_DAYS} days` });
    }

    let cleanConstraints;
    const spec = item.constraint;
    if (spec && constraints && constraints[spec.field] !== undefined && constraints[spec.field] !== "") {
      const value = Number(constraints[spec.field]);
      if (spec.type !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
        return res.status(400).json({ message: `${spec.field} must be a number between 0 and 100` });
      }
      cleanConstraints = { [spec.field]: value };
    }

    const grant = await PermissionGrant.create({
      shop: req.user.shop,
      agent: agent._id,
      permission,
      constraints: cleanConstraints,
      reason,
      validFrom,
      validTo,
      createdBy: req.user._id,
    });

    await grantAudit(req, agent, grant, AUDIT_ACTIONS.PERMISSION_GRANT_CREATED);

    res.status(201).json({ ...grant.toObject(), status: statusOf(grant) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/agents/:agentId/permission-grants/:grantId — ends it now. The
// record is kept (it is evidence); only its access is withdrawn.
async function revokePermissionGrant(req, res, next) {
  try {
    const agent = await findAgent(req);
    if (!agent) return res.status(404).json({ message: "Agent not found" });

    if (!mongoose.isValidObjectId(req.params.grantId)) {
      return res.status(404).json({ message: "Grant not found" });
    }

    const grant = await PermissionGrant.findOneAndUpdate(
      { _id: req.params.grantId, shop: req.user.shop, agent: agent._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedBy: req.user._id } },
      { new: true }
    );
    if (!grant) return res.status(404).json({ message: "Grant not found" });

    await grantAudit(req, agent, grant, AUDIT_ACTIONS.PERMISSION_GRANT_REVOKED);

    res.status(200).json({ ...grant.toObject(), status: statusOf(grant) });
  } catch (err) {
    next(err);
  }
}

module.exports = { listPermissionGrants, createPermissionGrant, revokePermissionGrant };
