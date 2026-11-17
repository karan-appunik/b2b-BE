const Customer = require("../models/customer.model");
const ContextSession = require("../models/contextSession.model");
const Quote = require("../models/quote.model");
const OverrideRequest = require("../models/overrideRequest.model");
const AgentCart = require("../models/agentCart.model");
const { isAgentRole, buildCustomerScopeFilter, roleFor } = require("./agentAccess.service");
const { getRole } = require("./role.service");
const { describe: describeMfa } = require("./mfa.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");

// The agents list (spec §4.1): who they are, how much they can reach, when they
// last worked, what they have open, and whether they may work today.

const OPEN_QUOTE = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "ACCEPTED", "CHANGES_REQUESTED"];

class AgentProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.statusCode = 400;
  }
}

// Active, or not yet / no longer within the dates the agent was given.
function activation(profile, now = new Date()) {
  const from = profile && profile.validFrom;
  const to = profile && profile.validTo;
  if (from && new Date(from) > now) return "scheduled";
  if (to && new Date(to) <= now) return "expired";
  return "active";
}

async function overview(shop, now = new Date()) {
  const agents = (await Customer.find({ shop, role: { $ne: "customer" } }).lean()).filter((a) => isAgentRole(a.role));
  if (!agents.length) return [];

  const ids = agents.map((a) => a._id);
  const [last, quotes, exceptions, carts] = await Promise.all([
    ContextSession.aggregate([{ $match: { shop, agent: { $in: ids } } }, { $group: { _id: "$agent", at: { $max: "$issuedAt" } } }]),
    Quote.aggregate([{ $match: { shop, ownerAgent: { $in: ids }, status: { $in: OPEN_QUOTE } } }, { $group: { _id: "$ownerAgent", n: { $sum: 1 } } }]),
    OverrideRequest.aggregate([{ $match: { shop, agent: { $in: ids }, status: "PENDING_APPROVAL" } }, { $group: { _id: "$agent", n: { $sum: 1 } } }]),
    AgentCart.aggregate([{ $match: { shop, agent: { $in: ids }, "items.0": { $exists: true } } }, { $group: { _id: "$agent", n: { $sum: 1 } } }]),
  ]);
  const by = (rows) => new Map(rows.map((r) => [String(r._id), r]));
  const lastBy = by(last), quotesBy = by(quotes), excBy = by(exceptions), cartsBy = by(carts);
  const names = new Map(agents.map((a) => [String(a._id), a.name]));

  // Each agent's reach is worked out at the same time, not one after another,
  // and each role is read once however many agents have it.
  const roleMemo = new Map();
  const rows = await Promise.all(agents.map(async (a) => {
    const filter = await buildCustomerScopeFilter(shop, { ...a, _id: a._id, role: a.role }, { roleMemo });
    const customerCount = filter ? await Customer.countDocuments({ $and: [{ shop, role: "customer", shopifyCustomerId: { $exists: true, $ne: null } }, filter] }) : 0;
    const role = await roleFor(shop, a.role, roleMemo);
    const mfa = describeMfa(a);

    const profile = a.agentProfile || {};
    return {
      id: a._id,
      name: a.name,
      email: a.email,
      role: a.role,
      territory: a.territory || null,
      status: activation(profile, now),
      validFrom: profile.validFrom || null,
      validTo: profile.validTo || null,
      locale: profile.locale || null,
      legalEntities: profile.legalEntities || [],
      lastLoginAt: profile.lastLoginAt || null,
      manager: profile.managerId ? names.get(String(profile.managerId)) || null : null,
      managerId: profile.managerId || null,
      customerCount,
      lastActiveAt: lastBy.get(String(a._id)) ? lastBy.get(String(a._id)).at : null,
      openWork: {
        quotes: (quotesBy.get(String(a._id)) || {}).n || 0,
        exceptions: (excBy.get(String(a._id)) || {}).n || 0,
        carts: (cartsBy.get(String(a._id)) || {}).n || 0,
      },
      mfa: !role || !role.requireMfa ? "not required" : mfa.enrolled ? "set up" : "not set up",
    };
  }));

  return rows.sort((x, y) => x.name.localeCompare(y.name));
}

// Manager, dates and language for an agent. A manager is another agent; the
// end date comes after the start date. Recorded in the audit trail.
async function updateProfile({ shop, agentId, input, user }) {
  const agent = await Customer.findOne({ _id: agentId, shop });
  if (!agent || !isAgentRole(agent.role)) throw Object.assign(new AgentProfileError("NOT_FOUND", "Agent not found"), { statusCode: 404 });

  const next = { ...(agent.agentProfile ? agent.agentProfile.toObject() : {}) };

  if (input.managerId !== undefined) {
    if (!input.managerId) next.managerId = undefined;
    else {
      const manager = await Customer.findOne({ _id: input.managerId, shop });
      if (!manager || !isAgentRole(manager.role) || String(manager._id) === String(agent._id)) {
        throw new AgentProfileError("INVALID_MANAGER", "A manager must be another sales agent");
      }
      next.managerId = manager._id;
    }
  }

  for (const [field, key] of [["validFrom", "validFrom"], ["validTo", "validTo"]]) {
    if (input[field] === undefined) continue;
    if (!input[field]) next[key] = undefined;
    else {
      const d = new Date(input[field]);
      if (Number.isNaN(d.getTime())) throw new AgentProfileError("INVALID_DATE", `${field} is not a valid date`);
      next[key] = d;
    }
  }
  if (next.validFrom && next.validTo && new Date(next.validTo) <= new Date(next.validFrom)) {
    throw new AgentProfileError("INVALID_DATES", "The end date must be after the start date");
  }

  if (input.legalEntities !== undefined) {
    const list = (Array.isArray(input.legalEntities) ? input.legalEntities : String(input.legalEntities || "").split(","))
      .map((e) => String(e).trim())
      .filter(Boolean);
    next.legalEntities = list.length ? [...new Set(list)] : undefined;
  }

  if (input.locale !== undefined) {
    const locale = String(input.locale || "").trim();
    if (locale && !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(locale)) throw new AgentProfileError("INVALID_LOCALE", "Locale looks like en or en-GB");
    next.locale = locale || undefined;
  }

  agent.agentProfile = next;
  await agent.save();

  await recordAudit({
    shop,
    actorType: "merchant_user",
    actor: user._id,
    customer: agent._id,
    action: AUDIT_ACTIONS.AGENT_PROFILE_UPDATED,
    objectType: "customer",
    objectId: String(agent._id),
    metadata: { legalEntities: next.legalEntities || [], managerId: next.managerId ? String(next.managerId) : null, validFrom: next.validFrom || null, validTo: next.validTo || null, locale: next.locale || null },
  });

  return agent;
}

const csvCell = (v) => {
  let t = v === undefined || v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};

function toCsv(rows) {
  const head = ["name", "email", "role", "territory", "status", "manager", "customers", "lastLogin", "lastActive", "openQuotes", "waitingExceptions", "savedCarts", "mfa"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push(
      [r.name, r.email, r.role, r.territory, r.status, r.manager, r.customerCount, r.lastLoginAt ? new Date(r.lastLoginAt).toISOString() : "", r.lastActiveAt ? new Date(r.lastActiveAt).toISOString() : "", r.openWork.quotes, r.openWork.exceptions, r.openWork.carts, r.mfa]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}

module.exports = { AgentProfileError, activation, overview, updateProfile, toCsv };
