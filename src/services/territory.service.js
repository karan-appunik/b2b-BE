const TerritoryRule = require("../models/territoryRule.model");
const Customer = require("../models/customer.model");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");

class TerritoryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.statusCode = status;
  }
}

const norm = (v) => String(v ?? "").trim();
const upper = (v) => norm(v).toUpperCase();
const zipKey = (v) => upper(v).replace(/[\s-]/g, "");

// A rule's own checks, cleaned. At least one is required, so a rule can never
// match everybody by accident.
function cleanRule(input) {
  const list = (v, fn) => [...new Set((Array.isArray(v) ? v : []).map(fn).filter(Boolean))];

  const rule = {
    name: norm(input.name),
    territory: norm(input.territory),
    countryCodes: list(input.countryCodes, upper),
    provinceCodes: list(input.provinceCodes, upper),
    zipPrefixes: list(input.zipPrefixes, zipKey),
    tags: list(input.tags, (t) => norm(t).toLowerCase()),
    priority: input.priority === undefined || input.priority === "" ? 100 : Number(input.priority),
    active: input.active !== false,
  };

  if (!rule.name) throw new TerritoryError("NAME_REQUIRED", "Give the rule a name");
  if (rule.name.length > 80) throw new TerritoryError("NAME_TOO_LONG", "The name can be up to 80 characters");
  if (!rule.territory) throw new TerritoryError("TERRITORY_REQUIRED", "Say which territory customers go into");
  if (rule.territory.length > 60) throw new TerritoryError("TERRITORY_TOO_LONG", "The territory can be up to 60 characters");
  if (!Number.isFinite(rule.priority) || rule.priority < 0 || rule.priority > 100000) {
    throw new TerritoryError("INVALID_PRIORITY", "Priority is a number from 0 to 100000");
  }
  if (rule.countryCodes.some((c) => !/^[A-Z]{2}$/.test(c))) throw new TerritoryError("INVALID_COUNTRY", "Countries are 2-letter codes, like US");
  if (!rule.countryCodes.length && !rule.provinceCodes.length && !rule.zipPrefixes.length && !rule.tags.length) {
    throw new TerritoryError("NO_CONDITION", "Add at least one country, state, postal prefix or tag");
  }

  return rule;
}

// Does this customer fit the rule? Not case sensitive. Zip codes ignore spaces
// and dashes, so "K2P 2L8" fits the prefix "K2P".
function matches(rule, customer) {
  const region = customer.region || {};
  const tags = (customer.tags || []).map((t) => String(t).toLowerCase());

  if (rule.countryCodes.length && !rule.countryCodes.includes(upper(region.countryCode))) return false;
  if (rule.provinceCodes.length && !rule.provinceCodes.includes(upper(region.provinceCode))) return false;
  if (rule.zipPrefixes.length) {
    const zip = zipKey(region.zip);
    if (!zip || !rule.zipPrefixes.some((p) => zip.startsWith(p))) return false;
  }
  if (rule.tags.length && !rule.tags.some((t) => tags.includes(t))) return false;
  return true;
}

// The territory the rules give this customer, or null.
function territoryFor(customer, rules) {
  const hit = rules.find((r) => r.active !== false && matches(r, customer));
  return hit ? hit.territory : null;
}

// Fills in territories from the rules. Anything set by hand is never touched,
// and neither is an agent. A customer the rules gave a territory to loses it
// again when no rule fits any more. With dryRun nothing is saved: the answer
// shows what would change.
async function applyRules(shop, { dryRun = false, actor } = {}) {
  const rules = await TerritoryRule.find({ shop, active: true }).sort({ priority: 1, createdAt: 1 }).lean();

  const customers = await Customer.find({
    shop,
    role: "customer",
    $or: [{ territorySource: "rule" }, { territory: null }, { territory: { $exists: false } }, { territory: "" }],
  }).select("name territory territorySource region tags");

  const changes = [];
  for (const c of customers) {
    const next = territoryFor(c, rules);
    const current = c.territory || null;
    if (next === current) {
      if (next && c.territorySource !== "rule") changes.push({ id: c._id, name: c.name, from: current, to: next, quiet: true });
      continue;
    }
    changes.push({ id: c._id, name: c.name, from: current, to: next });
  }

  const real = changes.filter((c) => !c.quiet);
  if (!dryRun && changes.length) {
    await Customer.bulkWrite(
      changes.map((c) => ({
        updateOne: {
          filter: { _id: c.id },
          update: c.to ? { $set: { territory: c.to, territorySource: "rule" } } : { $set: { territory: null }, $unset: { territorySource: 1 } },
        },
      }))
    );

    if (real.length) {
      await recordAudit({
        shop,
        actorType: actor ? "merchant_user" : "system",
        actor: actor ? actor._id : undefined,
        action: AUDIT_ACTIONS.TERRITORY_APPLIED,
        objectType: "territory_rules",
        metadata: { assigned: real.filter((c) => c.to).length, cleared: real.filter((c) => !c.to).length },
      });
    }
  }

  const byTerritory = {};
  for (const c of real) if (c.to) byTerritory[c.to] = (byTerritory[c.to] || 0) + 1;

  return {
    dryRun,
    checked: customers.length,
    changed: real.length,
    assigned: real.filter((c) => c.to).length,
    cleared: real.filter((c) => !c.to).length,
    byTerritory,
    samples: real.slice(0, 20).map((c) => ({ name: c.name, from: c.from, to: c.to })),
  };
}

async function listRules(shop) {
  const rules = await TerritoryRule.find({ shop }).sort({ priority: 1, createdAt: 1 }).lean();
  const counts = await Customer.aggregate([
    { $match: { shop, role: "customer", territory: { $nin: [null, ""] } } },
    { $group: { _id: "$territory", count: { $sum: 1 } } },
  ]);
  return { rules, customersByTerritory: Object.fromEntries(counts.map((c) => [c._id, c.count])) };
}

async function saveRule({ shop, id, input, user }) {
  const data = cleanRule(input);
  const clash = await TerritoryRule.findOne({ shop, name: new RegExp(`^${data.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), ...(id ? { _id: { $ne: id } } : {}) });
  if (clash) throw new TerritoryError("NAME_TAKEN", "A rule with this name already exists", 409);

  let rule;
  if (id) {
    rule = await TerritoryRule.findOneAndUpdate({ _id: id, shop }, data, { new: true, runValidators: true });
    if (!rule) throw new TerritoryError("NOT_FOUND", "Rule not found", 404);
  } else {
    if ((await TerritoryRule.countDocuments({ shop })) >= 100) throw new TerritoryError("TOO_MANY", "Up to 100 rules");
    rule = await TerritoryRule.create({ shop, ...data });
  }

  await recordAudit({
    shop,
    actorType: "merchant_user",
    actor: user._id,
    action: id ? AUDIT_ACTIONS.TERRITORY_RULE_UPDATED : AUDIT_ACTIONS.TERRITORY_RULE_CREATED,
    objectType: "territory_rule",
    objectId: String(rule._id),
    metadata: { name: rule.name, territory: rule.territory },
  });

  return rule;
}

async function deleteRule({ shop, id, user }) {
  const rule = await TerritoryRule.findOneAndDelete({ _id: id, shop });
  if (!rule) throw new TerritoryError("NOT_FOUND", "Rule not found", 404);

  await recordAudit({
    shop,
    actorType: "merchant_user",
    actor: user._id,
    action: AUDIT_ACTIONS.TERRITORY_RULE_DELETED,
    objectType: "territory_rule",
    objectId: String(rule._id),
    metadata: { name: rule.name },
  });
}

module.exports = { TerritoryError, cleanRule, matches, territoryFor, applyRules, listRules, saveRule, deleteRule };
