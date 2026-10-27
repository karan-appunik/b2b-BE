const Role = require("../models/role.model");
const Customer = require("../models/customer.model");
const { PERMISSION_CATALOG, PERMISSION_KEYS, SYSTEM_ROLES, CUSTOMER_ROLE } = require("../config/permissions");
const { ensureSystemRoles, loadAncestors } = require("../services/role.service");
const { AUDIT_ACTIONS, recordAudit } = require("../services/audit.service");

const PERCENT_FIELDS = ["maxDeltaPercent", "maxPercent"];

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Checks the permission list a role editor sends and returns the cleaned
// list, or an error message. Unknown keys, duplicates and bad constraint
// values are rejected rather than silently dropped.
function validatePermissions(input) {
  if (!Array.isArray(input)) return { error: "permissions must be an array" };

  const seen = new Set();
  const clean = [];

  for (const entry of input) {
    const key = entry && entry.key;
    if (!PERMISSION_KEYS.includes(key)) return { error: `Unknown permission: ${key}` };
    if (seen.has(key)) return { error: `Permission listed twice: ${key}` };
    seen.add(key);

    const effect = entry.effect === "deny" ? "deny" : "allow";
    const item = { key, effect };

    const spec = PERMISSION_CATALOG.find((p) => p.key === key).constraint;
    const constraints = entry.constraints;

    if (effect === "allow" && spec && constraints && constraints[spec.field] !== undefined && constraints[spec.field] !== "") {
      const value = constraints[spec.field];

      if (spec.type === "select") {
        if (!spec.options.includes(value)) return { error: `${key}: ${spec.field} must be one of ${spec.options.join(", ")}` };
      } else {
        const number = Number(value);
        const max = PERCENT_FIELDS.includes(spec.field) ? 100 : Infinity;
        if (!Number.isFinite(number) || number < 0 || number > max) {
          return { error: `${key}: ${spec.field} must be a number between 0 and ${max === Infinity ? "∞" : max}` };
        }
        item.constraints = { [spec.field]: number };
        clean.push(item);
        continue;
      }

      item.constraints = { [spec.field]: value };
    }

    clean.push(item);
  }

  return { permissions: clean };
}

function summarize(role) {
  const own = role.permissions.map((p) => `${p.key}:${p.effect}${p.constraints ? JSON.stringify(p.constraints) : ""}`);
  const flags = [];
  if (role.inheritsFrom) flags.push(`inherits:${role.inheritsFrom}`);
  if (role.requireMfa) flags.push("requireMfa");
  return [...flags, ...own];
}

// Checks a requested parent: it must be a real active role, not the role
// itself, and must not (directly or further up) inherit from this role —
// otherwise permissions would loop. Returns { inheritsFrom } or { error }.
async function validateParent(shop, roleKey, requested) {
  const parentKey = requested ? String(requested).trim().toLowerCase() : null;
  if (!parentKey) return { inheritsFrom: null };

  if (parentKey === CUSTOMER_ROLE) return { error: "A role cannot inherit from the customer role" };
  if (parentKey === roleKey) return { error: "A role cannot inherit from itself" };

  const parent = await Role.findOne({ shop, key: parentKey, status: "active" });
  if (!parent) return { error: "Parent role not found" };

  const ancestors = await loadAncestors(shop, parent);
  if (ancestors.some((a) => a.key === roleKey)) {
    return { error: "That would make the roles inherit from each other" };
  }

  return { inheritsFrom: parentKey };
}

function roleAudit(req, role, action, extra = {}) {
  return recordAudit({
    shop: req.user.shop,
    actorType: "merchant_user",
    actor: req.user._id,
    action,
    objectType: "role",
    objectId: role.key,
    metadata: { version: role.version, ...extra },
  });
}

// GET /api/roles — every role with how many people hold it, plus the
// permission catalog the role editor draws its checkboxes from.
async function listRoles(req, res, next) {
  try {
    const shop = req.user.shop;
    await ensureSystemRoles(shop);

    const [roles, counts] = await Promise.all([
      Role.find({ shop, status: "active" }).sort({ isSystem: -1, name: 1 }),
      Customer.aggregate([
        { $match: { shop } },
        { $group: { _id: "$role", count: { $sum: 1 } } },
      ]),
    ]);

    const countByRole = new Map(counts.map((c) => [c._id, c.count]));

    // Built-in roles in their natural order (agent, manager, administrator),
    // then custom roles by name.
    const builtInOrder = SYSTEM_ROLES.map((r) => r.key);
    const rank = (r) => (builtInOrder.includes(r.key) ? builtInOrder.indexOf(r.key) : builtInOrder.length);
    roles.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

    res.status(200).json({
      catalog: PERMISSION_CATALOG,
      roles: roles.map((r) => ({ ...r.toObject(), memberCount: countByRole.get(r.key) || 0 })),
    });
  } catch (err) {
    next(err);
  }
}

async function createRole(req, res, next) {
  try {
    const shop = req.user.shop;
    const name = String(req.body.name || "").trim();
    // The handle is the role's id; it defaults to the name but can be chosen.
    const key = req.body.key ? String(req.body.key).trim().toLowerCase() : slugify(name);

    if (!name || !key) return res.status(400).json({ message: "name is required" });
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      return res.status(400).json({ message: "The handle can only use lowercase letters, numbers, - and _" });
    }
    if (key === CUSTOMER_ROLE) return res.status(400).json({ message: "That name is reserved" });

    const checked = validatePermissions(req.body.permissions || []);
    if (checked.error) return res.status(400).json({ message: checked.error });

    if (await Role.findOne({ shop, key })) {
      return res.status(400).json({ message: "A role with that name already exists" });
    }

    const parent = await validateParent(shop, key, req.body.inheritsFrom);
    if (parent.error) return res.status(400).json({ message: parent.error });

    const role = await Role.create({
      shop,
      key,
      name,
      description: String(req.body.description || "").trim(),
      inheritsFrom: parent.inheritsFrom,
      requireMfa: req.body.requireMfa === true,
      permissions: checked.permissions,
    });

    await roleAudit(req, role, AUDIT_ACTIONS.ROLE_CREATED, { permissions: summarize(role) });

    res.status(201).json(role);
  } catch (err) {
    next(err);
  }
}

async function updateRole(req, res, next) {
  try {
    const role = await Role.findOne({ shop: req.user.shop, key: req.params.key, status: "active" });
    if (!role) return res.status(404).json({ message: "Role not found" });

    const before = summarize(role);

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ message: "name cannot be empty" });
      role.name = name;
    }
    if (req.body.description !== undefined) role.description = String(req.body.description).trim();

    if (req.body.permissions !== undefined) {
      const checked = validatePermissions(req.body.permissions);
      if (checked.error) return res.status(400).json({ message: checked.error });
      role.permissions = checked.permissions;
    }

    if (req.body.inheritsFrom !== undefined) {
      const parent = await validateParent(req.user.shop, role.key, req.body.inheritsFrom);
      if (parent.error) return res.status(400).json({ message: parent.error });
      role.inheritsFrom = parent.inheritsFrom;
    }

    if (req.body.requireMfa !== undefined) role.requireMfa = req.body.requireMfa === true;

    role.version += 1;
    await role.save();

    await roleAudit(req, role, AUDIT_ACTIONS.ROLE_UPDATED, { before, after: summarize(role) });

    res.status(200).json(role);
  } catch (err) {
    next(err);
  }
}

async function deleteRole(req, res, next) {
  try {
    const shop = req.user.shop;
    const role = await Role.findOne({ shop, key: req.params.key, status: "active" });
    if (!role) return res.status(404).json({ message: "Role not found" });
    if (role.isSystem) return res.status(400).json({ message: "Built-in roles cannot be deleted" });

    const children = await Role.find({ shop, inheritsFrom: role.key, status: "active" }).select("name");
    if (children.length > 0) {
      return res.status(409).json({
        message: `These roles inherit from it: ${children.map((c) => c.name).join(", ")}. Change them first.`,
      });
    }

    const members = await Customer.countDocuments({ shop, role: role.key });
    if (members > 0) {
      return res.status(409).json({ message: `${members} people still have this role. Move them to another role first.` });
    }

    await role.deleteOne();
    await roleAudit(req, role, AUDIT_ACTIONS.ROLE_DELETED, { permissions: summarize(role) });

    res.status(200).json({ message: "Role deleted" });
  } catch (err) {
    next(err);
  }
}

// GET /api/roles/:key/members — who a change to this role (or to a role
// that inherits from it) would affect, so the editor can show it before saving.
async function getRoleMembers(req, res, next) {
  try {
    const shop = req.user.shop;
    const role = await Role.findOne({ shop, key: req.params.key, status: "active" });
    if (!role) return res.status(404).json({ message: "Role not found" });

    // This role plus every role that inherits from it, directly or further down.
    const affectedKeys = new Set([role.key]);
    let frontier = [role.key];
    while (frontier.length) {
      const next = await Role.find({ shop, inheritsFrom: { $in: frontier }, status: "active" }).select("key");
      frontier = next.map((r) => r.key).filter((k) => !affectedKeys.has(k));
      frontier.forEach((k) => affectedKeys.add(k));
    }

    const [people, inheritingRoles] = await Promise.all([
      Customer.find({ shop, role: { $in: [...affectedKeys] } })
        .select("name email role")
        .sort({ name: 1 })
        .limit(100),
      Role.find({ shop, key: { $in: [...affectedKeys].filter((k) => k !== role.key) } }).select("name key"),
    ]);

    res.status(200).json({
      people: people.map((p) => ({ id: p._id, name: p.name, email: p.email, role: p.role })),
      inheritingRoles: inheritingRoles.map((r) => ({ key: r.key, name: r.name })),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listRoles, createRole, updateRole, deleteRole, getRoleMembers };
