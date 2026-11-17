const Customer = require("../models/customer.model");
const AgentScopeGrant = require("../models/agentScopeGrant.model");
const PermissionGrant = require("../models/permissionGrant.model");
const { CUSTOMER_ROLE } = require("../config/permissions");
const { getRole, evaluate, hasGlobalScope } = require("./role.service");
const { PERMISSION_CATALOG } = require("../config/permissions");
const { describe: describeMfa } = require("./mfa.service");
const AgentSettings = require("../models/agentSettings.model");

// Capabilities that can be switched off one by one (spec §15.2 step 6: "enable
// advanced overrides and customer creation only after policy and support
// maturity"), and the permissions each one covers.
const FEATURES = {
  overrides: ["price.override", "discount.override", "quantity_rule.override", "shipping.override", "custom_line.create"],
  quotes: ["quote.create"],
  payment_links: ["payment_link.send"],
  customer_creation: ["customer.create"],
};

// Settings are read on nearly every request, so they are kept for a few
// seconds. A change made here is seen at once (see clearSwitchCache).
const SWITCH_TTL_MS = 5000;
const switchCache = new Map();

async function switchesFor(shop) {
  const hit = switchCache.get(shop);
  if (hit && Date.now() - hit.at < SWITCH_TTL_MS) return hit.value;

  const settings = await AgentSettings.findOne({ shop }).select("moduleEnabled featuresOff").lean();
  const value = { moduleEnabled: !settings || settings.moduleEnabled !== false, featuresOff: (settings && settings.featuresOff) || [] };
  switchCache.set(shop, { at: Date.now(), value });
  return value;
}

// A short fingerprint of what lets this agent act: the version of their role,
// the access they have been given, and the module's settings. When it changes,
// a context opened earlier is STALE until it is refreshed.
async function accessFingerprint(shop, agent) {
  const role = await getRole(shop, agent.role);
  const grants = await loadActiveGrants(shop, agent._id);
  const stamp = grants.map((g) => `${g.scopeType}:${g.scopeId}:${g.effect}`).sort().join("|");
  // Only the settings that change what an agent may do count (not alert times).
  const settings = await AgentSettings.findOne({ shop })
    .select("hardFloorPercent stepUpAbovePercent quoteApprovalAbove moduleEnabled featuresOff provisionalOrdering requireTaxId")
    .lean();

  return {
    roleVersion: role ? role.version : 0,
    grantsHash: require("crypto").createHash("sha1").update(stamp).digest("hex").slice(0, 16),
    // Missing settings and settings with their defaults are the same thing, so a
    // shop whose settings are first saved is not suddenly "changed".
    policyStamp: require("crypto")
      .createHash("sha1")
      .update(
        JSON.stringify({
          hardFloorPercent: settings && settings.hardFloorPercent !== undefined ? settings.hardFloorPercent : null,
          stepUpAbovePercent: settings && settings.stepUpAbovePercent !== undefined ? settings.stepUpAbovePercent : 10,
          quoteApprovalAbove: settings && settings.quoteApprovalAbove !== undefined ? settings.quoteApprovalAbove : null,
          moduleEnabled: !settings || settings.moduleEnabled !== false,
          featuresOff: (settings && settings.featuresOff) || [],
          provisionalOrdering: (settings && settings.provisionalOrdering) || "allow",
          requireTaxId: !!(settings && settings.requireTaxId),
        })
      )
      .digest("hex")
      .slice(0, 16),
  };
}

function clearSwitchCache(shop) {
  if (shop) switchCache.delete(shop);
  else switchCache.clear();
}

// Any role other than the plain "customer" role is a sales role; what it may
// actually do comes from the permissions on its Role record.
function isAgentRole(role) {
  return !!role && role !== CUSTOMER_ROLE;
}

async function findAgentByShopifyId(shop, shopifyCustomerId) {
  if (!shop || !shopifyCustomerId) return null;

  return Customer.findOne({
    shop,
    shopifyCustomerId: String(shopifyCustomerId),
    role: { $exists: true, $nin: [CUSTOMER_ROLE, null] },
  });
}

// Checks one permission for an agent, evaluated on the server from their
// role (spec §2.2). Returns `{ allowed, constraints, role }`.
// High-risk permissions on a role that requires MFA also need a fresh
// authenticator check (step-up, spec §2.4) before they are usable.
function stepUpBlocks(role, agent, permissionKey) {
  const highRisk = PERMISSION_CATALOG.find((p) => p.key === permissionKey)?.highRisk;
  if (!highRisk || !role || !role.requireMfa) return false;
  return !describeMfa(agent).stepUpValid;
}

// `valueBasedStepUp`: leave the step-up check to the caller, who decides it
// from the size of what is being asked (price exceptions, spec §11.1
// "high-value overrides") instead of asking every time.
async function authorizeAgent(shop, agent, permissionKey, { valueBasedStepUp = false, roleMemo } = {}) {
  // The kill switch and a switched-off capability come before everything else.
  const switches = await switchesFor(shop);
  if (!switches.moduleEnabled) return { allowed: false, denied: true, reason: "MODULE_DISABLED" };
  const off = Object.entries(FEATURES).find(([name, keys]) => switches.featuresOff.includes(name) && keys.includes(permissionKey));
  if (off) return { allowed: false, denied: true, reason: "FEATURE_DISABLED", feature: off[0] };

  // Outside the dates they were given, an agent can't work (spec §4.1).
  const profile = agent && agent.agentProfile;
  if (profile && ((profile.validFrom && new Date(profile.validFrom) > new Date()) || (profile.validTo && new Date(profile.validTo) <= new Date()))) {
    return { allowed: false, denied: true, reason: "AGENT_NOT_ACTIVE" };
  }

  const decision = await authorizeAgentBase(shop, agent, permissionKey, roleMemo);

  if (!valueBasedStepUp && decision.allowed && stepUpBlocks(decision.role, agent, permissionKey)) {
    return { ...decision, allowed: false, stepUpRequired: true };
  }

  return decision;
}

// Looks a role up, once per key when a memo is given.
async function roleFor(shop, key, memo) {
  if (!memo) return getRole(shop, key);
  if (!memo.has(key)) memo.set(key, getRole(shop, key));
  return memo.get(key);
}

async function authorizeAgentBase(shop, agent, permissionKey, roleMemo) {
  const role = await roleFor(shop, agent.role, roleMemo);
  const fromRole = evaluate(role, permissionKey);

  // A role that says "always deny" can't be bypassed by a temporary grant.
  if (fromRole.allowed || fromRole.denied) return { ...fromRole, role };

  const now = new Date();
  const temporary = await PermissionGrant.findOne({
    shop,
    agent: agent._id,
    permission: permissionKey,
    revokedAt: null,
    validFrom: { $lte: now },
    validTo: { $gt: now },
  }).sort({ validTo: -1 });

  if (temporary) {
    return { allowed: true, constraints: temporary.constraints || null, role, temporary: true };
  }

  return { ...fromRole, role };
}

// Grants whose validity window covers `now`.
async function loadActiveGrants(shop, agentId, now = new Date()) {
  const own = await AgentScopeGrant.find({
    shop,
    agent: agentId,
    $and: [
      { $or: [{ validFrom: null }, { validFrom: { $lte: now } }] },
      { $or: [{ validTo: null }, { validTo: { $gt: now } }] },
    ],
  });

  // Temporary access (Phase 4): while a delegation covers access, the
  // delegator's own customer, group and territory grants count too.
  const covered = await require("./delegation.service").coverGrantsFor(shop, agentId, now);
  return covered.length ? own.concat(covered) : own;
}

function splitGrants(grants) {
  const buckets = {
    allow: { customer: [], group: [], territory: [], all: false },
    deny: { customer: [], group: [], territory: [], all: false },
  };

  for (const grant of grants) {
    const bucket = buckets[grant.effect];
    if (grant.scopeType === "all") bucket.all = true;
    else bucket[grant.scopeType].push(grant.scopeId);
  }

  return buckets;
}

// Mongo filter selecting the customers this agent may act for, or null when
// the agent has no access at all. Precedence (spec §2.3): explicit deny
// wins, then direct customer grant, then group / territory, then global.
async function buildCustomerScopeFilter(shop, agent, { roleMemo } = {}) {
  const { allowed, role } = await authorizeAgent(shop, agent, "customer.context.enter", { roleMemo });
  if (!allowed) return null;

  const grants = await loadActiveGrants(shop, agent._id);
  const { allow, deny } = splitGrants(grants);

  // A blanket deny overrides every allow, including a global role.
  if (deny.all) return null;

  const hasGlobal = hasGlobalScope(role);
  const allowClauses = [];

  if (allow.customer.length) allowClauses.push({ _id: { $in: allow.customer } });
  if (allow.group.length) allowClauses.push({ customerGroup: { $in: allow.group } });
  if (allow.territory.length) allowClauses.push({ territory: { $in: allow.territory } });

  if (!hasGlobal && allowClauses.length === 0) return null;

  const filter = { shop };
  const and = [];

  if (!hasGlobal) and.push({ $or: allowClauses });
  if (deny.customer.length) and.push({ _id: { $nin: deny.customer } });
  if (deny.group.length) and.push({ customerGroup: { $nin: deny.group } });
  if (deny.territory.length) and.push({ territory: { $nin: deny.territory } });
  if (and.length) filter.$and = and;

  return filter;
}

// Single-customer check used before entering a customer context. Returns
// `{ allowed, reason, source }` so the caller can audit why it was decided.
async function checkCustomerAccess(shop, agent, customer, { channel } = {}) {
  if (!customer || customer.shop !== shop) {
    return { allowed: false, reason: "CUSTOMER_NOT_FOUND" };
  }

  // Legal entity and channel come with the account (spec §2.3 step 2): an agent
  // who sells for certain entities can't act for another entity's customer, and
  // a customer can be limited to certain channels.
  const entities = (agent.agentProfile && agent.agentProfile.legalEntities) || [];
  if (entities.length && customer.legalEntity && !entities.includes(customer.legalEntity)) {
    return { allowed: false, reason: "LEGAL_ENTITY_MISMATCH" };
  }
  const channels = customer.allowedChannels || [];
  if (channel && channels.length && !channels.includes(channel)) {
    return { allowed: false, reason: "CHANNEL_RESTRICTED" };
  }

  const { allowed: mayEnter, role } = await authorizeAgent(shop, agent, "customer.context.enter");
  if (!mayEnter) return { allowed: false, reason: "PERMISSION_DENIED" };

  const grants = await loadActiveGrants(shop, agent._id);
  const { allow, deny } = splitGrants(grants);

  const customerId = String(customer._id);
  const groupId = customer.customerGroup ? String(customer.customerGroup) : null;
  const territory = customer.territory || null;

  if (
    deny.all ||
    deny.customer.includes(customerId) ||
    (groupId && deny.group.includes(groupId)) ||
    (territory && deny.territory.includes(territory))
  ) {
    return { allowed: false, reason: "EXPLICIT_DENY" };
  }

  if (allow.customer.includes(customerId)) return { allowed: true, source: "customer" };
  if (groupId && allow.group.includes(groupId)) return { allowed: true, source: "group" };
  if (territory && allow.territory.includes(territory)) return { allowed: true, source: "territory" };
  if (hasGlobalScope(role)) return { allowed: true, source: "global" };

  return { allowed: false, reason: "NO_GRANT" };
}

module.exports = {
  roleFor,
  accessFingerprint,
  FEATURES,
  clearSwitchCache,
  isAgentRole,
  findAgentByShopifyId,
  authorizeAgent,
  buildCustomerScopeFilter,
  checkCustomerAccess,
};
