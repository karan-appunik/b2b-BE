const delegations = require("../services/delegation.service");
const { findAgentByShopifyId } = require("../services/agentAccess.service");

function fail(res, err) {
  if (err instanceof delegations.DelegationError) {
    return res.status(err.statusCode).json({ code: err.code, message: err.message });
  }
  throw err;
}

// ---- merchant panel

// GET /api/delegations?agentId=&status=
async function list(req, res, next) {
  try {
    res.status(200).json(await delegations.listDelegations({ shop: req.user.shop, agentId: req.query.agentId, status: req.query.status }));
  } catch (err) {
    next(err);
  }
}

// POST /api/delegations — { delegatorId, delegateId, startsAt?, endsAt, reason, coverAccess?, includeQuotes? }
async function create(req, res, next) {
  try {
    const doc = await delegations.createDelegation({
      shop: req.user.shop,
      delegatorId: req.body.delegatorId,
      delegateId: req.body.delegateId,
      startsAt: req.body.startsAt,
      endsAt: req.body.endsAt,
      reason: req.body.reason,
      coverAccess: req.body.coverAccess === true,
      includeQuotes: req.body.includeQuotes,
      actor: { kind: "merchant_user", user: req.user },
    });
    res.status(201).json({ id: String(doc._id), status: delegations.statusOf(doc) });
  } catch (err) {
    try { return fail(res, err); } catch (e) { next(e); }
  }
}

// POST /api/delegations/:id/revoke — { reason? }
async function revoke(req, res, next) {
  try {
    const doc = await delegations.revokeDelegation({ shop: req.user.shop, id: req.params.id, actor: { kind: "merchant_user", user: req.user }, reason: req.body && req.body.reason });
    res.status(200).json({ id: String(doc._id), status: delegations.statusOf(doc) });
  } catch (err) {
    try { return fail(res, err); } catch (e) { next(e); }
  }
}

// ---- an agent, from the storefront (internal API)

// GET /api/internal/agent/delegations — the ones this agent gave or received.
async function agentList(req, res, next) {
  try {
    const agent = await findAgentByShopifyId(req.query.shop, req.query.agentShopifyCustomerId);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    const rows = await delegations.listDelegations({ shop: req.query.shop, agentId: String(agent._id) });
    res.status(200).json({
      delegations: rows.map((r) => ({ ...r, direction: r.delegator.id === String(agent._id) ? "given" : "received" })),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/internal/agent/delegations — an agent hands their own approvals to
// a colleague: { delegateId, endsAt, reason, coverAccess?, includeQuotes? }
async function agentCreate(req, res, next) {
  try {
    const agent = await findAgentByShopifyId(req.body.shop, req.body.agentShopifyCustomerId);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    const doc = await delegations.createDelegation({
      shop: req.body.shop,
      delegatorId: String(agent._id),
      delegateId: req.body.delegateId,
      startsAt: req.body.startsAt,
      endsAt: req.body.endsAt,
      reason: req.body.reason,
      coverAccess: req.body.coverAccess === true,
      includeQuotes: req.body.includeQuotes,
      actor: { kind: "agent", agent },
    });
    res.status(201).json({ id: String(doc._id), status: delegations.statusOf(doc) });
  } catch (err) {
    try { return fail(res, err); } catch (e) { next(e); }
  }
}

// POST /api/internal/agent/delegations/:id/revoke
async function agentRevoke(req, res, next) {
  try {
    const agent = await findAgentByShopifyId(req.body.shop, req.body.agentShopifyCustomerId);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    const doc = await delegations.revokeDelegation({ shop: req.body.shop, id: req.params.id, actor: { kind: "agent", agent }, reason: req.body.reason });
    res.status(200).json({ id: String(doc._id), status: delegations.statusOf(doc) });
  } catch (err) {
    try { return fail(res, err); } catch (e) { next(e); }
  }
}

// GET /api/internal/agent/delegate-candidates — colleagues who can be chosen.
async function agentCandidates(req, res, next) {
  try {
    const agent = await findAgentByShopifyId(req.query.shop, req.query.agentShopifyCustomerId);
    if (!agent) return res.status(403).json({ message: "Not authorized" });

    const Customer = require("../models/customer.model");
    const { isAgentRole } = require("../services/agentAccess.service");
    const people = await Customer.find({ shop: req.query.shop, role: { $exists: true, $nin: ["customer", null] }, _id: { $ne: agent._id } }).select("name email role").limit(200);
    res.status(200).json({ agents: people.filter((p) => isAgentRole(p.role)).map((p) => ({ id: String(p._id), name: p.name || p.email })) });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, revoke, agentList, agentCreate, agentRevoke, agentCandidates };
