const Customer = require("../models/customer.model");
const AgentScopeGrant = require("../models/agentScopeGrant.model");
const { buildCustomerScopeFilter } = require("./agentAccess.service");

// Before an access rule is saved, the administrator can see what it would do
// (spec §4.1 Assignments "conflict preview"): how many customers it covers,
// which of them the agent already reaches, which an existing rule blocks, and
// whether it clashes with a rule already there.

const BASE = (shop) => ({ shop, role: "customer", shopifyCustomerId: { $exists: true, $ne: null } });

// The customers a rule covers.
function scopeFilter(scopeType, scopeId) {
  if (scopeType === "customer") return { _id: scopeId };
  if (scopeType === "group") return { customerGroup: scopeId };
  if (scopeType === "territory") return { territory: scopeId };
  return {};
}

const count = (shop, ...filters) => Customer.countDocuments({ $and: [BASE(shop), ...filters] });

async function previewGrant({ shop, agent, grant }) {
  const mine = scopeFilter(grant.scopeType, grant.scopeId);
  const covered = await count(shop, mine);
  const sample = (await Customer.find({ $and: [BASE(shop), mine] }).select("name company").limit(5).lean()).map((c) => c.company || c.name);

  const existing = await AgentScopeGrant.find({ shop, agent: agent._id }).lean();
  const conflicts = [];
  const same = (g) => g.scopeType === grant.scopeType && String(g.scopeId || "") === String(grant.scopeId || "");

  if (existing.some((g) => same(g) && g.effect === grant.effect)) {
    conflicts.push({ code: "DUPLICATE", message: "This agent already has this rule." });
  }
  if (existing.some((g) => same(g) && g.effect !== grant.effect)) {
    conflicts.push({ code: "OPPOSITE_SAME_SCOPE", message: `This agent already has the opposite rule for the same ${grant.scopeType === "all" ? "scope" : grant.scopeType}. A deny always wins.` });
  }
  if (grant.validTo && new Date(grant.validTo) <= new Date()) {
    conflicts.push({ code: "ALREADY_EXPIRED", message: "The end date has already passed, so this rule would never apply." });
  }

  const result = { customersCovered: covered, sample, conflicts, alreadyReached: 0, blockedByDeny: 0, willBeAdded: 0, willBeRemoved: 0 };

  const currentFilter = await buildCustomerScopeFilter(shop, agent);

  if (grant.effect === "allow") {
    result.alreadyReached = currentFilter ? await count(shop, mine, currentFilter) : 0;

    // Customers an existing deny rule keeps out whatever this rule says.
    const denyIds = new Set();
    for (const d of existing.filter((g) => g.effect === "deny")) {
      const blocked = await count(shop, mine, scopeFilter(d.scopeType, d.scopeId));
      if (blocked > 0) {
        denyIds.add(String(d._id));
        conflicts.push({ code: "BLOCKED_BY_DENY", count: blocked, message: `${blocked} of these customers are kept out by a deny rule (${d.scopeType === "all" ? "everyone" : d.scopeType + " " + d.scopeId}).` });
      }
    }
    if (denyIds.size) {
      const denyFilters = existing.filter((g) => denyIds.has(String(g._id))).map((d) => scopeFilter(d.scopeType, d.scopeId));
      result.blockedByDeny = await count(shop, mine, { $or: denyFilters });
    }
    result.willBeAdded = Math.max(covered - result.alreadyReached - result.blockedByDeny, 0);

    // Other agents who already have the same rule: shared coverage.
    const others = await AgentScopeGrant.find({ shop, agent: { $ne: agent._id }, scopeType: grant.scopeType, scopeId: grant.scopeId || null, effect: "allow" }).populate("agent", "name").lean();
    if (others.length) {
      conflicts.push({
        code: "OTHER_AGENTS_SAME_SCOPE",
        message: `${others.map((o) => (o.agent ? o.agent.name : "Another agent")).join(", ")} can already work with these customers.`,
        info: true,
      });
    }
  } else {
    // A deny takes access away from whoever this agent can reach now.
    result.willBeRemoved = currentFilter ? await count(shop, mine, currentFilter) : 0;
    if (result.willBeRemoved > 0) {
      conflicts.push({ code: "REMOVES_ACCESS", count: result.willBeRemoved, message: `${result.willBeRemoved} customers this agent can reach now would be taken away.`, info: true });
    }
  }

  return result;
}

module.exports = { previewGrant };
