const mongoose = require("mongoose");

const ApprovalDelegation = require("../models/approvalDelegation.model");
const Customer = require("../models/customer.model");
const { isAgentRole, authorizeAgent } = require("./agentAccess.service");
const { getRole } = require("./role.service");
const { describe: describeMfa } = require("./mfa.service");
const { notify } = require("./notification.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");

// Phase 4: delegation and temporary access (spec §8.4, §2.4).
//
// A delegation lets one agent (the delegate) decide approvals with the
// authority of another (the delegator) for a fixed time. Nothing is copied or
// widened: every check is made against the delegator's own role and limits, the
// delegate still needs their own step-up code when that role asks for one, a
// person can never approve their own request through a delegation, and a
// delegate cannot pass the delegation on. Every decision made this way records
// both people (the original chain is kept).

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DAYS = 30;

class DelegationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function nameOf(agent) {
  return (agent && (agent.name || agent.email)) || "an agent";
}

function statusOf(d, now = new Date()) {
  if (d.status === "REVOKED") return "revoked";
  if (d.startsAt > now) return "scheduled";
  if (d.endsAt <= now) return "expired";
  return "active";
}

async function maxDays(shop) {
  const settings = await require("../models/agentSettings.model").findOne({ shop }).select("delegationMaxDays").lean();
  return (settings && settings.delegationMaxDays) || DEFAULT_MAX_DAYS;
}

// Delegations in force for this delegate right now.
async function activeFor(shop, delegateId, now = new Date()) {
  return ApprovalDelegation.find({
    shop,
    delegate: delegateId,
    status: "ACTIVE",
    startsAt: { $lte: now },
    endsAt: { $gt: now },
  });
}

// Whether `delegate` may decide something through a delegation. `check` is run
// for each delegator and returns null when that person could decide it
// themselves (or "STEP_UP_REQUIRED", which is their own code and no concern of
// the delegate's). Returns { delegation, delegator } or { block }.
// `memo` is an object kept for one request (the approver): a list of waiting
// requests is checked one by one, and most people have no delegation, so what is
// looked up is looked up once.
async function authorityFor({ shop, delegate, check, scope = "override", now = new Date(), memo = {} }) {
  if (!delegate) return { block: null };

  if (memo.rows === undefined) {
    // The delegate must themselves be allowed to work right now.
    const own = await authorizeAgent(shop, delegate, "customer.search");
    memo.rows = own.reason === "MODULE_DISABLED" || own.reason === "AGENT_NOT_ACTIVE" ? [] : await activeFor(shop, delegate._id, now);
    memo.delegators = new Map();
  }
  if (!memo.rows.length) return { block: null };

  let stepUp = false;

  for (const d of memo.rows) {
    if (scope === "quote" && !d.includeQuotes) continue;

    const key = String(d.delegator);
    if (!memo.delegators.has(key)) {
      const person = await Customer.findOne({ _id: d.delegator, shop });
      const role = person && isAgentRole(person.role) ? await getRole(shop, person.role) : null;
      memo.delegators.set(key, person && isAgentRole(person.role) ? { person, role } : null);
    }
    const found = memo.delegators.get(key);
    if (!found) continue;
    const delegator = found.person;
    if (String(delegator._id) === String(delegate._id)) continue;

    const block = await check(delegator);
    if (block !== null && block !== "STEP_UP_REQUIRED") continue;

    // The delegate proves who they are when the delegator's role asks for it.
    const role = found.role;
    if (role && role.requireMfa && !describeMfa(delegate).stepUpValid) {
      stepUp = true;
      continue;
    }

    return { delegation: d, delegator };
  }

  return { block: stepUp ? "STEP_UP_REQUIRED" : null };
}

// The customers a delegate may also work for while a delegation covers access:
// the delegator's own grants by customer, group or territory (allow only; a
// "global" role scope is not passed on).
async function coverGrantsFor(shop, agentId, now = new Date()) {
  const AgentScopeGrant = require("../models/agentScopeGrant.model");
  const rows = await ApprovalDelegation.find({
    shop,
    delegate: agentId,
    status: "ACTIVE",
    coverAccess: true,
    startsAt: { $lte: now },
    endsAt: { $gt: now },
  }).lean();
  if (!rows.length) return [];

  const out = [];
  for (const d of rows) {
    const grants = await AgentScopeGrant.find({
      shop,
      agent: d.delegator,
      effect: "allow",
      scopeType: { $in: ["customer", "group", "territory"] },
      $and: [
        { $or: [{ validFrom: null }, { validFrom: { $lte: now } }] },
        { $or: [{ validTo: null }, { validTo: { $gt: now } }] },
      ],
    }).lean();
    for (const g of grants) out.push({ shop, agent: agentId, scopeType: g.scopeType, scopeId: g.scopeId, effect: "allow", viaDelegation: d._id });
  }
  return out;
}

async function loadAgent(shop, id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const agent = await Customer.findOne({ _id: id, shop });
  return agent && isAgentRole(agent.role) ? agent : null;
}

function actorFields(actor) {
  return actor.kind === "merchant_user"
    ? { actorType: "merchant_user", actor: actor.user._id }
    : { actorType: "sales_agent", actor: actor.agent._id, actorShopifyCustomerId: actor.agent.shopifyCustomerId };
}

// `actor` is { kind: "merchant_user", user } or { kind: "agent", agent }.
// An agent can only delegate their own authority.
async function createDelegation({ shop, delegatorId, delegateId, startsAt, endsAt, reason, coverAccess, includeQuotes, actor }) {
  const delegator = await loadAgent(shop, delegatorId);
  const delegate = await loadAgent(shop, delegateId);
  if (!delegator) throw new DelegationError("DELEGATOR_NOT_FOUND", "The person delegating must be a sales agent", 404);
  if (!delegate) throw new DelegationError("DELEGATE_NOT_FOUND", "Choose another sales agent to delegate to", 404);
  if (String(delegator._id) === String(delegate._id)) throw new DelegationError("SAME_PERSON", "You can't delegate to yourself");

  if (actor.kind === "agent" && String(actor.agent._id) !== String(delegator._id)) {
    throw new DelegationError("NOT_YOUR_AUTHORITY", "You can only delegate your own approvals", 403);
  }

  // The delegator must have approval authority to hand over.
  const auth = await authorizeAgent(shop, delegator, "approval.decide");
  if (!auth.allowed && !auth.stepUpRequired) {
    throw new DelegationError("NOTHING_TO_DELEGATE", "This person has no approval authority to delegate", 400);
  }

  const now = new Date();
  const start = startsAt ? new Date(startsAt) : now;
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new DelegationError("INVALID_DATES", "Start and end must be valid dates");
  if (end <= now) throw new DelegationError("INVALID_DATES", "The end must be in the future");
  if (end <= start) throw new DelegationError("INVALID_DATES", "The end must be after the start");

  const limit = await maxDays(shop);
  if (end.getTime() - start.getTime() > limit * DAY_MS) {
    throw new DelegationError("TOO_LONG", `A delegation can last at most ${limit} days`);
  }

  const text = String(reason || "").trim();
  if (!text) throw new DelegationError("REASON_REQUIRED", "A reason is required");

  const overlap = await ApprovalDelegation.findOne({
    shop,
    delegator: delegator._id,
    delegate: delegate._id,
    status: "ACTIVE",
    startsAt: { $lt: end },
    endsAt: { $gt: start },
  });
  if (overlap) throw new DelegationError("OVERLAPS", "These two people already have a delegation for part of this time", 409);

  const doc = await ApprovalDelegation.create({
    shop,
    delegator: delegator._id,
    delegate: delegate._id,
    startsAt: start,
    endsAt: end,
    reason: text,
    coverAccess: !!coverAccess,
    includeQuotes: includeQuotes !== false,
    createdBy: actor.kind === "merchant_user" ? { kind: "merchant_user", id: actor.user._id } : { kind: "agent", id: actor.agent._id },
  });

  await recordAudit({
    shop,
    ...actorFields(actor),
    action: AUDIT_ACTIONS.DELEGATION_CREATED,
    objectType: "approval_delegation",
    objectId: String(doc._id),
    metadata: { delegator: String(delegator._id), delegate: String(delegate._id), startsAt: start, endsAt: end, coverAccess: doc.coverAccess, includeQuotes: doc.includeQuotes, reason: text },
  });

  notify({
    shop,
    recipient: delegate,
    type: "delegation.started",
    title: `${nameOf(delegator)} has delegated approvals to you`,
    body: `Until ${end.toISOString().slice(0, 10)}${doc.coverAccess ? ", with access to their customers" : ""}. Reason: ${text}`,
    link: "/account",
    dedupeKey: `deleg-start:${doc._id}`,
  }).catch(() => {});

  return doc;
}

async function revokeDelegation({ shop, id, actor, reason }) {
  if (!mongoose.isValidObjectId(id)) throw new DelegationError("NOT_FOUND", "Delegation not found", 404);

  const filter = { _id: id, shop, status: "ACTIVE" };
  if (actor.kind === "agent") {
    // The delegator can take it back; the delegate can hand it back.
    filter.$or = [{ delegator: actor.agent._id }, { delegate: actor.agent._id }];
  }

  const doc = await ApprovalDelegation.findOneAndUpdate(
    filter,
    { $set: { status: "REVOKED", revokedAt: new Date(), revokedReason: String(reason || "").slice(0, 200) } },
    { new: true }
  );
  if (!doc) throw new DelegationError("NOT_FOUND", "Delegation not found", 404);

  await recordAudit({
    shop,
    ...actorFields(actor),
    action: AUDIT_ACTIONS.DELEGATION_REVOKED,
    objectType: "approval_delegation",
    objectId: String(doc._id),
    metadata: { delegator: String(doc.delegator), delegate: String(doc.delegate), reason: doc.revokedReason || undefined, usedTimes: doc.useCount },
  });

  const delegate = await Customer.findById(doc.delegate);
  if (delegate) {
    notify({
      shop,
      recipient: delegate,
      type: "delegation.ended",
      title: "A delegation to you has ended",
      link: "/account",
      dedupeKey: `deleg-end:${doc._id}`,
    }).catch(() => {});
  }

  return doc;
}

// Everything that goes with an agent leaving: delegations they gave and
// received end at once.
async function endForAgent({ shop, agentId, reason, actor }) {
  const rows = await ApprovalDelegation.find({ shop, status: "ACTIVE", $or: [{ delegator: agentId }, { delegate: agentId }] });
  for (const d of rows) {
    d.status = "REVOKED";
    d.revokedAt = new Date();
    d.revokedReason = reason || "An agent was disabled";
    await d.save();
    await recordAudit({
      shop,
      actorType: actor && actor.actorType ? actor.actorType : "system",
      actor: actor && actor.actor ? actor.actor : undefined,
      action: AUDIT_ACTIONS.DELEGATION_REVOKED,
      objectType: "approval_delegation",
      objectId: String(d._id),
      metadata: { delegator: String(d.delegator), delegate: String(d.delegate), reason: d.revokedReason },
    });
  }
  return rows.length;
}

async function recordUse(delegation) {
  await ApprovalDelegation.updateOne({ _id: delegation._id }, { $inc: { useCount: 1 } });
}

async function listDelegations({ shop, agentId, status }) {
  const filter = { shop };
  if (agentId && mongoose.isValidObjectId(agentId)) filter.$or = [{ delegator: agentId }, { delegate: agentId }];

  const rows = await ApprovalDelegation.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  const ids = [...new Set(rows.flatMap((r) => [String(r.delegator), String(r.delegate)]))];
  const people = await Customer.find({ shop, _id: { $in: ids } }).select("name email").lean();
  const byId = new Map(people.map((p) => [String(p._id), p]));
  const now = new Date();

  const out = rows.map((r) => ({
    id: String(r._id),
    delegator: { id: String(r.delegator), name: nameOf(byId.get(String(r.delegator))) },
    delegate: { id: String(r.delegate), name: nameOf(byId.get(String(r.delegate))) },
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    reason: r.reason,
    coverAccess: r.coverAccess,
    includeQuotes: r.includeQuotes,
    status: statusOf(r, now),
    usedTimes: r.useCount || 0,
    revokedAt: r.revokedAt,
    revokedReason: r.revokedReason,
  }));

  return status ? out.filter((x) => x.status === status) : out;
}

module.exports = {
  DelegationError,
  authorityFor,
  activeFor,
  coverGrantsFor,
  createDelegation,
  revokeDelegation,
  endForAgent,
  recordUse,
  listDelegations,
  statusOf,
};
