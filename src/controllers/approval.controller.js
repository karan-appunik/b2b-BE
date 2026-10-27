const mongoose = require("mongoose");

const OverrideRequest = require("../models/overrideRequest.model");
const ApprovalPolicy = require("../models/approvalPolicy.model");
const AgentSettings = require("../models/agentSettings.model");
const Role = require("../models/role.model");
const overrides = require("../services/override.service");
const { AUDIT_ACTIONS, recordAudit } = require("../services/audit.service");

// Merchant-panel side of exceptions: the approval queue, the approval
// policies, and the module's settings. Administrators here act as approvers
// with no limit of their own.

function fail(res, err) {
  if (err instanceof overrides.OverrideError) {
    return res.status(err.statusCode).json({ code: err.code, message: err.message });
  }
  throw err;
}

function audit(req, action, object, metadata) {
  return recordAudit({
    shop: req.user.shop,
    actorType: "merchant_user",
    actor: req.user._id,
    action,
    objectType: object.type,
    objectId: String(object.id),
    metadata,
  });
}

// GET /api/approvals?status=PENDING_APPROVAL|all
async function listApprovals(req, res, next) {
  try {
    const shop = req.user.shop;
    await overrides.expireDue(shop);

    const filter = { shop };
    if (req.query.status && req.query.status !== "all") {
      if (!OverrideRequest.STATUSES.includes(req.query.status)) {
        return res.status(400).json({ message: "Unknown status" });
      }
      filter.status = req.query.status;
    } else if (!req.query.status) {
      filter.status = "PENDING_APPROVAL";
    }

    const requests = await OverrideRequest.find(filter).sort({ createdAt: -1 }).limit(200);
    res.status(200).json({ approvals: await overrides.describeRequests(requests) });
  } catch (err) {
    next(err);
  }
}

// POST /api/approvals/:id/decision — { decision, comment }
async function decideApproval(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Request not found" });

    const request = await overrides.decide({
      shop: req.user.shop,
      requestId: req.params.id,
      approver: { kind: "merchant_user", user: req.user },
      decision: req.body.decision,
      comment: req.body.comment,
    });

    res.status(200).json(request);
  } catch (err) {
    try { return fail(res, err); } catch (e) { next(e); }
  }
}

// ---- approval policies

function cleanPolicy(body, existing = {}) {
  const num = (v, fallback) => (v === undefined ? fallback : v === null || v === "" ? null : Number(v));
  const out = {};

  if (body.name !== undefined) out.name = String(body.name).trim();
  if (body.overrideType !== undefined) out.overrideType = body.overrideType;
  if (body.priority !== undefined) out.priority = Number(body.priority);
  if (body.effect !== undefined) out.effect = body.effect;
  if (body.maxDeltaPercent !== undefined) out.maxDeltaPercent = num(body.maxDeltaPercent);
  if (body.approverRoles !== undefined) out.approverRoles = body.approverRoles;
  if (body.slaHours !== undefined) out.slaHours = Number(body.slaHours);
  if (body.selfApprovalAllowed !== undefined) out.selfApprovalAllowed = body.selfApprovalAllowed === true;
  if (body.selfApprovalMaxPercent !== undefined) out.selfApprovalMaxPercent = num(body.selfApprovalMaxPercent);
  if (body.commentRequiredAbovePercent !== undefined) out.commentRequiredAbovePercent = num(body.commentRequiredAbovePercent);
  if (body.active !== undefined) out.active = body.active === true;

  return { ...existing, ...out };
}

async function validatePolicy(shop, data) {
  if (!data.name) return "A name is required";
  if (data.overrideType !== "ANY" && !OverrideRequest.TYPES.includes(data.overrideType)) return "Unknown exception type";
  if (!["route", "deny"].includes(data.effect)) return "effect must be route or deny";

  for (const field of ["priority", "slaHours"]) {
    if (!Number.isFinite(data[field])) return `${field} must be a number`;
  }
  for (const field of ["maxDeltaPercent", "selfApprovalMaxPercent", "commentRequiredAbovePercent"]) {
    if (data[field] !== null && data[field] !== undefined && !(Number(data[field]) >= 0 && Number(data[field]) <= 100)) {
      return `${field} must be between 0 and 100`;
    }
  }
  if (data.selfApprovalAllowed && (data.selfApprovalMaxPercent === null || data.selfApprovalMaxPercent === undefined)) {
    return "Set a size limit for self-approval";
  }

  if (!Array.isArray(data.approverRoles)) return "approverRoles must be a list";
  if (data.approverRoles.length) {
    const found = await Role.countDocuments({ shop, key: { $in: data.approverRoles }, status: "active" });
    if (found !== data.approverRoles.length) return "An approver role doesn't exist";
  }

  return null;
}

async function listPolicies(req, res, next) {
  try {
    const policies = await ApprovalPolicy.find({ shop: req.user.shop }).sort({ priority: 1, createdAt: 1 });
    res.status(200).json({ policies, types: OverrideRequest.TYPES });
  } catch (err) {
    next(err);
  }
}

async function createPolicy(req, res, next) {
  try {
    const data = cleanPolicy(req.body, {
      overrideType: "ANY",
      priority: 100,
      effect: "route",
      maxDeltaPercent: null,
      approverRoles: [],
      slaHours: 24,
      selfApprovalAllowed: false,
      selfApprovalMaxPercent: null,
      commentRequiredAbovePercent: null,
      active: true,
    });

    const problem = await validatePolicy(req.user.shop, data);
    if (problem) return res.status(400).json({ message: problem });

    const policy = await ApprovalPolicy.create({ shop: req.user.shop, ...data });
    await audit(req, AUDIT_ACTIONS.APPROVAL_POLICY_CREATED, { type: "approval_policy", id: policy._id }, { name: policy.name });

    res.status(201).json(policy);
  } catch (err) {
    next(err);
  }
}

async function updatePolicy(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Policy not found" });

    const policy = await ApprovalPolicy.findOne({ _id: req.params.id, shop: req.user.shop });
    if (!policy) return res.status(404).json({ message: "Policy not found" });

    const data = cleanPolicy(req.body, policy.toObject());
    const problem = await validatePolicy(req.user.shop, data);
    if (problem) return res.status(400).json({ message: problem });

    policy.set(data);
    policy.version += 1;
    await policy.save();
    await audit(req, AUDIT_ACTIONS.APPROVAL_POLICY_UPDATED, { type: "approval_policy", id: policy._id }, { name: policy.name, version: policy.version });

    res.status(200).json(policy);
  } catch (err) {
    next(err);
  }
}

async function deletePolicy(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Policy not found" });

    const policy = await ApprovalPolicy.findOneAndDelete({ _id: req.params.id, shop: req.user.shop });
    if (!policy) return res.status(404).json({ message: "Policy not found" });

    await audit(req, AUDIT_ACTIONS.APPROVAL_POLICY_DELETED, { type: "approval_policy", id: policy._id }, { name: policy.name });
    res.status(200).json({ message: "Policy deleted" });
  } catch (err) {
    next(err);
  }
}

// ---- module settings

async function getSettings(req, res, next) {
  try {
    res.status(200).json(await overrides.getSettings(req.user.shop));
  } catch (err) {
    next(err);
  }
}

async function updateSettings(req, res, next) {
  try {
    const update = {};

    if (req.body.hardFloorPercent !== undefined) {
      const v = req.body.hardFloorPercent === "" || req.body.hardFloorPercent === null ? null : Number(req.body.hardFloorPercent);
      if (v !== null && !(v >= 0 && v <= 100)) return res.status(400).json({ message: "hardFloorPercent must be between 0 and 100" });
      update.hardFloorPercent = v;
    }
    if (req.body.stepUpAbovePercent !== undefined) {
      const v = req.body.stepUpAbovePercent === "" || req.body.stepUpAbovePercent === null ? null : Number(req.body.stepUpAbovePercent);
      if (v !== null && !(v >= 0 && v <= 100)) return res.status(400).json({ message: "stepUpAbovePercent must be between 0 and 100" });
      update.stepUpAbovePercent = v;
    }
    if (req.body.quoteApprovalAbove !== undefined) {
      const v = req.body.quoteApprovalAbove === "" || req.body.quoteApprovalAbove === null ? null : Number(req.body.quoteApprovalAbove);
      if (v !== null && !(Number.isInteger(v) && v >= 0)) return res.status(400).json({ message: "quoteApprovalAbove must be a whole number of minor units" });
      update.quoteApprovalAbove = v;
    }
    for (const field of ["quoteValidDays", "quoteConvertDays", "paymentLinkValidHours"]) {
      if (req.body[field] !== undefined) {
        const v = Number(req.body[field]);
        if (!(Number.isInteger(v) && v >= 1 && v <= 365)) return res.status(400).json({ message: `${field} must be between 1 and 365` });
        update[field] = v;
      }
    }
    if (req.body.moduleEnabled !== undefined) update.moduleEnabled = req.body.moduleEnabled === true;
    if (req.body.offlineCaptureEnabled !== undefined) update.offlineCaptureEnabled = req.body.offlineCaptureEnabled === true;
    for (const [field, max] of [["offlineCaptureDays", 30], ["delegationMaxDays", 90]]) {
      if (req.body[field] === undefined) continue;
      const v = Number(req.body[field]);
      if (!(Number.isInteger(v) && v >= 1 && v <= max)) return res.status(400).json({ message: `${field} must be between 1 and ${max}` });
      update[field] = v;
    }
    if (req.body.substitutes !== undefined) {
      const list = Array.isArray(req.body.substitutes) ? req.body.substitutes : null;
      if (!list || list.length > 200) return res.status(400).json({ message: "substitutes must be a list of up to 200 rows" });
      const clean = [];
      const seen = new Set();
      for (const row of list) {
        const fromSku = String((row && row.fromSku) || "").trim();
        const toSku = String((row && row.toSku) || "").trim();
        if (!fromSku || !toSku) return res.status(400).json({ message: "Each substitute needs the SKU it replaces and the SKU to offer" });
        if (fromSku.toLowerCase() === toSku.toLowerCase()) return res.status(400).json({ message: "An item can't be its own substitute" });
        if (seen.has(fromSku.toLowerCase())) return res.status(400).json({ message: `${fromSku} has two substitutes; keep one` });
        seen.add(fromSku.toLowerCase());
        clean.push({ fromSku, toSku, note: String((row && row.note) || "").trim().slice(0, 200) || undefined });
      }
      update.substitutes = clean;
    }
    if (req.body.orderFailAlertAfter !== undefined) {
      const v = Number(req.body.orderFailAlertAfter);
      if (!(Number.isInteger(v) && v >= 1 && v <= 10)) return res.status(400).json({ message: "orderFailAlertAfter must be between 1 and 10" });
      update.orderFailAlertAfter = v;
    }
    if (req.body.retention !== undefined) {
      const r = req.body.retention || {};
      if (r.autoPurge !== undefined) update["retention.autoPurge"] = r.autoPurge === true;
      for (const field of ["contextsDays", "notificationsDays", "closedQuotesDays", "inactiveCartsDays"]) {
        if (r[field] === undefined) continue;
        const v = Number(r[field]);
        if (!(Number.isInteger(v) && v >= 30 && v <= 3650)) return res.status(400).json({ message: `${field} must be between 30 and 3650 days` });
        update["retention." + field] = v;
      }
    }
    if (req.body.contextAbsoluteMinutes !== undefined) {
      const v = Number(req.body.contextAbsoluteMinutes);
      if (!(Number.isInteger(v) && v >= 15 && v <= 1440)) return res.status(400).json({ message: "contextAbsoluteMinutes must be between 15 and 1440" });
      update.contextAbsoluteMinutes = v;
    }
    if (req.body.contextIdleMinutes !== undefined) {
      const v = req.body.contextIdleMinutes === "" || req.body.contextIdleMinutes === null ? null : Number(req.body.contextIdleMinutes);
      if (v !== null && !(Number.isInteger(v) && v >= 5 && v <= 1440)) return res.status(400).json({ message: "contextIdleMinutes must be between 5 and 1440" });
      update.contextIdleMinutes = v;
    }
    if (req.body.notificationTemplates !== undefined) {
      const t = req.body.notificationTemplates;
      if (!t || typeof t !== "object" || Array.isArray(t)) return res.status(400).json({ message: "notificationTemplates must be an object" });
      const clean = {};
      for (const [key, v] of Object.entries(t)) {
        if (!/^[a-z_.]+(\|[a-z]{2,3})?$/.test(key)) return res.status(400).json({ message: `"${key}" is not a notification type` });
        const title = String((v && v.title) || "").trim();
        const body = String((v && v.body) || "").trim();
        if (title.length > 200 || body.length > 2000) return res.status(400).json({ message: "A template title can be up to 200 characters and the body up to 2000" });
        if (title || body) clean[key] = { title, body };
      }
      update.notificationTemplates = clean;
    }
    if (req.body.integrationMappings !== undefined) {
      const list = Array.isArray(req.body.integrationMappings) ? req.body.integrationMappings : null;
      if (!list || list.length > 100) return res.status(400).json({ message: "integrationMappings must be a list of up to 100 rows" });
      const clean = [];
      for (const row of list) {
        const kind = row && row.kind;
        const from = String((row && row.from) || "").trim();
        const to = String((row && row.to) || "").trim();
        if (!["legalEntity", "channel", "territory"].includes(kind) || !from || !to) return res.status(400).json({ message: "Each mapping needs a kind (legalEntity, channel or territory), a name of ours and a name of theirs" });
        clean.push({ kind, from, to });
      }
      update.integrationMappings = clean;
    }
    if (req.body.inventoryMode !== undefined) {
      if (!["informational", "reserve_orders"].includes(req.body.inventoryMode)) {
        return res.status(400).json({ message: "inventoryMode must be informational or reserve_orders" });
      }
      update.inventoryMode = req.body.inventoryMode;
    }
    if (req.body.featuresOff !== undefined) {
      const known = Object.keys(require("../services/agentAccess.service").FEATURES);
      const off = Array.isArray(req.body.featuresOff) ? req.body.featuresOff.map(String) : null;
      if (!off || off.some((f) => !known.includes(f))) {
        return res.status(400).json({ message: `featuresOff must be a list of: ${known.join(", ")}` });
      }
      update.featuresOff = [...new Set(off)];
    }
    for (const field of ["alertsEnabled", "escalateApprovals", "digestEnabled"]) {
      if (req.body[field] !== undefined) update[field] = req.body[field] === true;
    }
    if (req.body.quoteReminderDays !== undefined) {
      const days = Array.isArray(req.body.quoteReminderDays) ? req.body.quoteReminderDays.map(Number) : null;
      if (!days || days.length > 5 || days.some((d) => !(Number.isInteger(d) && d >= 1 && d <= 60))) {
        return res.status(400).json({ message: "quoteReminderDays must be up to 5 whole numbers of days, from 1 to 60" });
      }
      update.quoteReminderDays = [...new Set(days)];
    }
    for (const field of ["quietHoursStart", "quietHoursEnd"]) {
      if (req.body[field] !== undefined) {
        const v = req.body[field] === "" || req.body[field] === null ? null : Number(req.body[field]);
        if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 23)) return res.status(400).json({ message: `${field} must be an hour from 0 to 23` });
        update[field] = v;
      }
    }
    if (req.body.businessTimezone !== undefined) {
      const zone = String(req.body.businessTimezone).trim();
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
      } catch {
        return res.status(400).json({ message: "businessTimezone is not a known time zone, for example Asia/Kolkata" });
      }
      update.businessTimezone = zone;
    }
    if (req.body.newCustomerTags !== undefined) {
      const tags = Array.isArray(req.body.newCustomerTags) ? req.body.newCustomerTags.map((t) => String(t).trim()).filter(Boolean) : null;
      if (!tags || tags.length > 10) return res.status(400).json({ message: "newCustomerTags must be a list of up to 10 tags" });
      update.newCustomerTags = tags;
    }
    if (req.body.provisionalOrdering !== undefined) {
      if (!["allow", "block"].includes(req.body.provisionalOrdering)) return res.status(400).json({ message: "provisionalOrdering must be allow or block" });
      update.provisionalOrdering = req.body.provisionalOrdering;
    }
    if (req.body.requireTaxId !== undefined) update.requireTaxId = req.body.requireTaxId === true;
    if (req.body.requestTtlHours !== undefined) {
      const v = Number(req.body.requestTtlHours);
      if (!(v >= 1 && v <= 24 * 30)) return res.status(400).json({ message: "requestTtlHours must be between 1 and 720" });
      update.requestTtlHours = v;
    }

    await overrides.getSettings(req.user.shop);
    const settings = await AgentSettings.findOneAndUpdate({ shop: req.user.shop }, { $set: update }, { new: true });
    require("../services/agentAccess.service").clearSwitchCache(req.user.shop);
    await audit(req, AUDIT_ACTIONS.SETTINGS_UPDATED, { type: "agent_settings", id: settings._id }, update);

    res.status(200).json(settings);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listApprovals,
  decideApproval,
  listPolicies,
  createPolicy,
  updatePolicy,
  deletePolicy,
  getSettings,
  updateSettings,
};
