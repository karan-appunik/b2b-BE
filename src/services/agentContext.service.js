const Customer = require("../models/customer.model");
const ContextSession = require("../models/contextSession.model");
const {
  accessFingerprint,
  findAgentByShopifyId,
  checkCustomerAccess,
} = require("./agentAccess.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");
const { EVENT_TYPES, emitEvent } = require("./outbox.service");
const { getRole } = require("./role.service");
const { describe: describeMfa } = require("./mfa.service");

// Absolute lifetime of a context. Spec §15.4 leaves idle vs absolute TTL as a
// configuration decision; start with a single absolute TTL.
// Actions that change something for the customer. On a STALE context these are
// refused until the agent refreshes it; reading carries on.
const SENSITIVE_PERMISSIONS = [
  "order.submit", "quote.create", "payment_link.send", "price.override", "discount.override",
  "quantity_rule.override", "shipping.override", "custom_line.create", "address.override", "credit.override",
];

const CONTEXT_TTL_MINUTES = Number(process.env.AGENT_CONTEXT_TTL_MINUTES) || 480;
const AgentSettings = require("../models/agentSettings.model");

// How long a context lives: the shop's setting, or the default.
async function contextLimits(shop) {
  const s = await AgentSettings.findOne({ shop }).select("contextAbsoluteMinutes contextIdleMinutes").lean();
  return {
    absolute: (s && s.contextAbsoluteMinutes) || CONTEXT_TTL_MINUTES,
    idle: (s && s.contextIdleMinutes) || null,
  };
}

function contextStatus(session, now = new Date()) {
  if (session.revokedAt) return "REVOKED";
  if (session.expiresAt <= now) return "EXPIRED";
  return "ACTIVE";
}

function agentActor(agent) {
  return {
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
  };
}

async function revokeSession(session, reason) {
  if (session.revokedAt) return session;

  session.revokedAt = new Date();
  session.revokedReason = reason;
  await session.save();

  await recordAudit({
    shop: session.shop,
    actorType: "sales_agent",
    actor: session.agent,
    customer: session.customer,
    contextId: session._id,
    action: reason === "EXIT" ? AUDIT_ACTIONS.CONTEXT_EXITED : AUDIT_ACTIONS.CONTEXT_REVOKED,
    reasonCode: reason,
    objectType: "context_session",
    objectId: String(session._id),
  });

  return session;
}

// Ends every live context for an agent — used when switching customers or
// when the agent is disabled / loses their role.
async function revokeAgentContexts(shop, agentId, reason) {
  const now = new Date();

  const result = await ContextSession.updateMany(
    { shop, agent: agentId, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now, revokedReason: reason } }
  );

  if (result.modifiedCount > 0) {
    await recordAudit({
      shop,
      actorType: "sales_agent",
      actor: agentId,
      action: AUDIT_ACTIONS.CONTEXT_REVOKED,
      reasonCode: reason,
      metadata: { revokedCount: result.modifiedCount },
    });
  }

  return result;
}

function customerSummary(customer) {
  return {
    id: customer._id,
    name: customer.name,
    email: customer.email,
    company: customer.company || null,
    code: customer.accountCode || null,
    legalEntity: customer.legalEntity || null,
    shopifyCustomerId: customer.shopifyCustomerId,
  };
}

// Authorizes the agent for `customerId` and issues a new context, ending any
// context they already had (switching never leaves two live at once).
// Returns `{ ok: false }` for every kind of denial so callers can answer with
// one generic error and never reveal whether the customer exists.
async function enterContext({ shop, agentShopifyCustomerId, customerId, channel, meta = {} }) {
  const agent = await findAgentByShopifyId(shop, agentShopifyCustomerId);
  if (!agent) {
    await recordAudit({
      shop,
      actorType: "sales_agent",
      actorShopifyCustomerId: String(agentShopifyCustomerId),
      action: AUDIT_ACTIONS.CONTEXT_DENIED,
      outcome: "denied",
      reasonCode: "NOT_AN_AGENT",
      metadata: { requestedCustomerId: String(customerId), clientIp: meta.clientIp },
    });
    await emitEvent(shop, EVENT_TYPES.CONTEXT_DENIED, {
      agent_id: null,
      reason_code: "NOT_AN_AGENT",
      risk_metadata: { client_ip: meta.clientIp || null },
    });
    return { ok: false, reason: "NOT_AN_AGENT" };
  }

  // Roles that require MFA must have passed the authenticator check first.
  const role = await getRole(shop, agent.role);
  if (role && role.requireMfa && !describeMfa(agent).verified) {
    await recordAudit({
      shop,
      ...agentActor(agent),
      action: AUDIT_ACTIONS.CONTEXT_DENIED,
      outcome: "denied",
      reasonCode: "MFA_REQUIRED",
      metadata: { requestedCustomerId: String(customerId), clientIp: meta.clientIp },
    });
    return { ok: false, reason: "MFA_REQUIRED", agent };
  }

  const customer = await Customer.findOne({
    _id: customerId,
    shop,
    shopifyCustomerId: { $exists: true, $ne: null },
  });
  let decision = customer
    ? await checkCustomerAccess(shop, agent, customer, { channel: channel || "b2b_web" })
    : { allowed: false, reason: "CUSTOMER_NOT_FOUND" };

  // Suspended and merged accounts are refused whatever access the agent has.
  if (decision.allowed && customer.accountStatus && customer.accountStatus !== "active") {
    decision = { allowed: false, reason: customer.accountStatus === "merged" ? "ACCOUNT_MERGED" : "ACCOUNT_SUSPENDED" };
  }

  if (!decision.allowed) {
    await recordAudit({
      shop,
      ...agentActor(agent),
      customer: customer ? customer._id : undefined,
      action: AUDIT_ACTIONS.CONTEXT_DENIED,
      outcome: "denied",
      reasonCode: decision.reason,
      metadata: { requestedCustomerId: String(customerId), clientIp: meta.clientIp },
    });
    await emitEvent(shop, EVENT_TYPES.CONTEXT_DENIED, {
      agent_id: String(agent._id),
      reason_code: decision.reason,
      risk_metadata: { client_ip: meta.clientIp || null },
    });
    return { ok: false, reason: decision.reason, agent, customer };
  }

  await revokeAgentContexts(shop, agent._id, "SWITCHED");

  const issuedAt = new Date();
  const limits = await contextLimits(shop);
  const session = await ContextSession.create({
    shop,
    agent: agent._id,
    customer: customer._id,
    channel: channel || "b2b_web",
    legalEntity: customer.legalEntity || undefined,
    issuedAt,
    lastActivityAt: issuedAt,
    expiresAt: new Date(issuedAt.getTime() + limits.absolute * 60 * 1000),
    authzSnapshot: {
      source: decision.source,
      agentRole: agent.role,
      clientIp: meta.clientIp,
      userAgent: meta.userAgent,
      ...(await accessFingerprint(shop, agent)),
      refreshedAt: issuedAt,
    },
  });

  await recordAudit({
    shop,
    ...agentActor(agent),
    customer: customer._id,
    contextId: session._id,
    action: AUDIT_ACTIONS.CONTEXT_ENTERED,
    objectType: "context_session",
    objectId: String(session._id),
    metadata: {
      assignmentSource: decision.source,
      agentRole: agent.role,
      channel: session.channel,
      expiresAt: session.expiresAt,
      clientIp: meta.clientIp,
    },
  });

  await emitEvent(shop, EVENT_TYPES.CONTEXT_ENTERED, {
    agent_id: String(agent._id),
    customer_id: String(customer._id),
    context_id: String(session._id),
    assignment_source: decision.source,
  });

  return { ok: true, session, agent, customer };
}

// Checks that a context is still usable: not revoked or expired, the agent
// is still an agent, and the grant that allowed it still holds. Access is
// re-evaluated on every call (spec §2.2 "recheck assignment on every
// request"), so removing a grant ends the context on the next request.
// `touch: false` is for a screen that only looks (the drawer asking now and
// then whether the session is still on): it must not count as the agent being
// active, or the idle limit would never be reached.
async function validateContext({ shop, contextId, agentShopifyCustomerId, sensitive = false, touch = true }) {
  const agent = await findAgentByShopifyId(shop, agentShopifyCustomerId);
  if (!agent) return { valid: false, reason: "CONTEXT_REQUIRED" };

  const session = await ContextSession.findOne({ _id: contextId, shop, agent: agent._id });
  if (!session) return { valid: false, reason: "CONTEXT_REQUIRED", agent };

  // If the role requires MFA and the agent's check has lapsed, the context
  // pauses (it is not ended): they pass the check again and carry on.
  const role = await getRole(shop, agent.role);
  if (role && role.requireMfa && !describeMfa(agent).verified) {
    return { valid: false, reason: "MFA_REQUIRED", agent, session };
  }

  const status = contextStatus(session);
  if (status === "REVOKED") return { valid: false, reason: "CONTEXT_REVOKED", agent, session };
  if (status === "EXPIRED") return { valid: false, reason: "CONTEXT_EXPIRED", agent, session };

  // Nothing done for longer than the idle limit: the context ends, and the
  // agent starts again (spec §15.4 idle vs absolute TTL).
  const { idle } = await contextLimits(shop);
  const last = session.lastActivityAt || session.issuedAt;
  if (idle && Date.now() - new Date(last).getTime() > idle * 60 * 1000) {
    session.expiresAt = new Date();
    await session.save();
    return { valid: false, reason: "CONTEXT_EXPIRED", agent, session };
  }
  // Noted at most every half minute, so reading stays cheap.
  if (touch && (!session.lastActivityAt || Date.now() - new Date(session.lastActivityAt).getTime() > 30 * 1000)) {
    await ContextSession.updateOne({ _id: session._id }, { $set: { lastActivityAt: new Date() } });
  }

  const customer = await Customer.findOne({ _id: session.customer, shop });
  const decision = customer
    ? await checkCustomerAccess(shop, agent, customer, { channel: session.channel })
    : { allowed: false, reason: "CUSTOMER_NOT_FOUND" };

  // An account suspended or merged while the context was open ends it.
  if (decision.allowed && customer.accountStatus && customer.accountStatus !== "active") {
    await revokeSession(session, "ACCOUNT_" + customer.accountStatus.toUpperCase());
    return { valid: false, reason: "CONTEXT_REVOKED", agent, session };
  }

  if (!decision.allowed) {
    await revokeSession(session, "ACCESS_LOST");
    return { valid: false, reason: "CONTEXT_REVOKED", agent, session };
  }

  // Has what lets this agent act changed since the context was issued? Reads
  // carry on; changes to the customer's records wait for a refresh.
  const snap = session.authzSnapshot || {};
  let stale = false;
  if (snap.roleVersion !== undefined && snap.roleVersion !== null) {
    const fp = await accessFingerprint(shop, agent);
    stale = snap.roleVersion !== fp.roleVersion || snap.grantsHash !== fp.grantsHash || snap.policyStamp !== fp.policyStamp;
  }
  if (stale && sensitive) return { valid: false, reason: "CONTEXT_STALE", agent, session, customer };

  return { valid: true, stale, agent, session, customer };
}

// The agent confirms they are still allowed to carry on: access is checked
// again (it may end the context), and the context is marked fresh.
async function refreshContext({ shop, contextId, agentShopifyCustomerId }) {
  const result = await validateContext({ shop, contextId, agentShopifyCustomerId });
  if (!result.valid) return result;

  const fp = await accessFingerprint(shop, result.agent);
  result.session.authzSnapshot = { ...(result.session.authzSnapshot ? result.session.authzSnapshot.toObject() : {}), ...fp, refreshedAt: new Date() };
  await result.session.save();

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: result.agent._id,
    actorShopifyCustomerId: result.agent.shopifyCustomerId,
    customer: result.customer._id,
    contextId: result.session._id,
    action: AUDIT_ACTIONS.CONTEXT_REFRESHED,
    objectType: "context_session",
    objectId: String(result.session._id),
    metadata: fp,
  });

  return { ...result, stale: false };
}

// The agent's current live context, if any.
async function getCurrentContext({ shop, agentShopifyCustomerId }) {
  const agent = await findAgentByShopifyId(shop, agentShopifyCustomerId);
  if (!agent) return { valid: false, reason: "CONTEXT_REQUIRED" };

  const session = await ContextSession.findOne({
    shop,
    agent: agent._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ issuedAt: -1 });

  if (!session) return { valid: false, reason: "CONTEXT_REQUIRED", agent };

  return validateContext({ shop, contextId: session._id, agentShopifyCustomerId, touch: false });
}

module.exports = {
  SENSITIVE_PERMISSIONS,
  refreshContext,
  CONTEXT_TTL_MINUTES,
  contextStatus,
  customerSummary,
  revokeSession,
  revokeAgentContexts,
  enterContext,
  validateContext,
  getCurrentContext,
};
