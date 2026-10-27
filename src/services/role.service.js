const Role = require("../models/role.model");
const Customer = require("../models/customer.model");
const {
  SYSTEM_ROLES,
  CUSTOMER_ROLE,
  DEFAULTS_VERSION,
  PERMISSION_ADDED_IN,
} = require("../config/permissions");

// Makes sure the built-in roles exist for a shop. Existing roles are never
// overwritten — an administrator's edits to a system role must survive.
async function ensureSystemRoles(shop) {
  const existing = await Role.find({ shop, isSystem: true }).select("key");
  const have = new Set(existing.map((r) => r.key));

  // A role that used to be built in but no longer is (e.g. the old External
  // Sales Representative): if anyone still holds it, keep it as a custom role
  // so their access doesn't change; otherwise remove it.
  const builtInKeys = new Set(SYSTEM_ROLES.map((r) => r.key));
  for (const stale of existing.filter((r) => !builtInKeys.has(r.key))) {
    const members = await Customer.countDocuments({ shop, role: stale.key });
    if (members > 0) {
      await Role.updateOne({ _id: stale._id }, { $set: { isSystem: false } });
    } else {
      await Role.deleteOne({ _id: stale._id });
    }
  }

  // Bring existing built-in roles up to the current defaults: add permissions
  // introduced since they were seeded, never touching what is already there.
  const outdated = await Role.find({
    shop,
    isSystem: true,
    key: { $in: [...builtInKeys] },
    $or: [{ seededVersion: { $lt: DEFAULTS_VERSION } }, { seededVersion: { $exists: false } }],
  });
  for (const role of outdated) {
    const from = role.seededVersion || 1;
    const defaults = SYSTEM_ROLES.find((r) => r.key === role.key);
    const added = [];

    for (const [permissionKey, version] of Object.entries(PERMISSION_ADDED_IN)) {
      if (version <= from) continue;
      if (role.permissions.some((p) => p.key === permissionKey)) continue;

      const entry = defaults.permissions.find((p) => p.key === permissionKey);
      if (entry) {
        role.permissions.push(entry);
        added.push(permissionKey);
      }
    }

    role.seededVersion = DEFAULTS_VERSION;
    if (added.length) role.version += 1;
    await role.save();
  }

  for (const role of SYSTEM_ROLES) {
    if (have.has(role.key)) continue;

    try {
      await Role.create({ shop, ...role, isSystem: true, seededVersion: DEFAULTS_VERSION });
    } catch (err) {
      // A concurrent request created it first.
      if (err.code !== 11000) throw err;
    }
  }
}

const MAX_INHERIT_DEPTH = 5;

// Walks the inheritance chain from `role` upward (nearest parent first).
// Stops at a missing/archived parent, a cycle, or the depth limit.
async function loadAncestors(shop, role) {
  const ancestors = [];
  const seen = new Set([role.key]);
  let parentKey = role.inheritsFrom;

  while (parentKey && ancestors.length < MAX_INHERIT_DEPTH && !seen.has(parentKey)) {
    const parent = await Role.findOne({ shop, key: parentKey, status: "active" });
    if (!parent) break;

    ancestors.push(parent);
    seen.add(parent.key);
    parentKey = parent.inheritsFrom;
  }

  return ancestors;
}

// A role's own permissions layered over its ancestors': the nearest role
// that mentions a permission decides it, so a child can both add to and
// override (even deny) what it inherits.
function mergePermissions(role, ancestors) {
  const merged = new Map();

  for (const source of [...ancestors].reverse().concat(role)) {
    const byKey = new Map();
    for (const p of source.permissions) {
      if (!byKey.has(p.key)) byKey.set(p.key, []);
      byKey.get(p.key).push(p);
    }
    for (const [key, entries] of byKey) merged.set(key, entries);
  }

  return [...merged.values()].flat();
}

// The role with its inherited permissions folded in, ready for evaluate().
async function getRole(shop, key) {
  if (!key || key === CUSTOMER_ROLE) return null;

  await ensureSystemRoles(shop);
  const role = await Role.findOne({ shop, key, status: "active" });
  if (!role) return null;

  const ancestors = await loadAncestors(shop, role);
  return {
    key: role.key,
    name: role.name,
    version: role.version,
    // Required if the role, or any role it inherits from, requires it.
    requireMfa: role.requireMfa || ancestors.some((a) => a.requireMfa),
    permissions: mergePermissions(role, ancestors),
  };
}

// Evaluates one permission for a role. Deny by default; an explicit deny
// beats an allow. Returns `{ allowed, constraints }`.
function evaluate(role, permissionKey) {
  if (!role) return { allowed: false };

  const entries = role.permissions.filter((p) => p.key === permissionKey);
  if (entries.some((p) => p.effect === "deny")) return { allowed: false, denied: true };

  const grant = entries.find((p) => p.effect === "allow");
  if (!grant) return { allowed: false };

  return { allowed: true, constraints: grant.constraints || null };
}

// Whether the role may act for every customer rather than only assigned
// ones (spec §2.3: global access only for roles explicitly configured).
function hasGlobalScope(role) {
  const { allowed, constraints } = evaluate(role, "customer.context.enter");
  return allowed && !!constraints && constraints.scope === "all";
}

module.exports = { ensureSystemRoles, getRole, loadAncestors, evaluate, hasGlobalScope };
