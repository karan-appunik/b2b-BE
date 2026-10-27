const crypto = require("crypto");

const AuditEvent = require("../models/auditEvent.model");

// Stable action codes so reports and alerts can rely on them.
const AUDIT_ACTIONS = {
  CONTEXT_ENTERED: "context.entered",
  CONTEXT_DENIED: "context.denied",
  CONTEXT_EXITED: "context.exited",
  CONTEXT_REVOKED: "context.revoked",
  CONTEXT_REFRESHED: "context.refreshed",
  GRANT_CREATED: "grant.created",
  GRANT_DELETED: "grant.deleted",
  ORDER_ATTRIBUTED: "order.attributed",
  ORDER_ATTRIBUTION_REJECTED: "order.attribution_rejected",
  ROLE_CREATED: "role.created",
  ROLE_UPDATED: "role.updated",
  ROLE_DELETED: "role.deleted",
  AGENT_ROLE_CHANGED: "agent.role_changed",
  INTEGRATION_FAILED: "integration.failed",
  OVERRIDE_REQUESTED: "override.requested",
  OVERRIDE_DECIDED: "override.decided",
  OVERRIDE_CANCELLED: "override.cancelled",
  OVERRIDE_INVALIDATED: "override.invalidated",
  OVERRIDE_APPLIED: "override.applied",
  APPROVAL_POLICY_CREATED: "approval_policy.created",
  APPROVAL_POLICY_UPDATED: "approval_policy.updated",
  APPROVAL_POLICY_DELETED: "approval_policy.deleted",
  SETTINGS_UPDATED: "settings.updated",
  QUOTE_CREATED: "quote.created",
  QUOTE_REVISED: "quote.revised",
  QUOTE_SUBMITTED: "quote.submitted",
  QUOTE_DECIDED: "quote.decided",
  QUOTE_SENT: "quote.sent",
  QUOTE_RESPONDED: "quote.responded",
  QUOTE_WITHDRAWN: "quote.withdrawn",
  QUOTE_EXPIRED: "quote.expired",
  QUOTE_CONVERTED: "quote.converted",
  OVERRIDE_ESCALATED: "override.escalated",
  AUDIT_EXPORTED: "audit.exported",
  CUSTOMER_NOTES_UPDATED: "customer.notes_updated",
  AGENT_PROFILE_UPDATED: "agent.profile_updated",
  ACCOUNT_STATUS_CHANGED: "customer.status_changed",
  AGENT_WORK_REASSIGNED: "agent.work_reassigned",
  TERRITORY_RULE_CREATED: "territory_rule.created",
  TERRITORY_RULE_UPDATED: "territory_rule.updated",
  TERRITORY_RULE_DELETED: "territory_rule.deleted",
  TERRITORY_APPLIED: "territory.rules_applied",
  SHOPPING_LIST_CREATED: "shopping_list.created",
  SHOPPING_LIST_DELETED: "shopping_list.deleted",
  CUSTOMER_CREATED: "customer.created",
  CUSTOMER_CREATE_DENIED: "customer.create_denied",
  CUSTOMER_APPROVED: "customer.approved",
  ADDRESS_CREATED: "address.created",
  PAYMENT_LINK_CREATED: "payment_link.created",
  PAYMENT_LINK_REPLACED: "payment_link.replaced",
  PAYMENT_LINK_REVOKED: "payment_link.revoked",
  PAYMENT_LINK_PAID: "payment_link.paid",
  PAYMENT_LINK_MISMATCH: "payment_link.mismatch",
  ORDER_FAILED: "order.failed",
  CUSTOMER_MERGED: "customer.merged",
  RETENTION_RUN: "retention.run",
  LEGAL_HOLD_PLACED: "legal_hold.placed",
  LEGAL_HOLD_RELEASED: "legal_hold.released",
  DSR_COMPLETED: "data_subject_request.completed",
  DSR_REFUSED: "data_subject_request.refused",
  MFA_ENROLLED: "mfa.enrolled",
  MFA_VERIFIED: "mfa.verified",
  MFA_FAILED: "mfa.failed",
  MFA_RESET: "mfa.reset",
  PERMISSION_GRANT_CREATED: "permission_grant.created",
  PERMISSION_GRANT_REVOKED: "permission_grant.revoked",
  DELEGATION_CREATED: "delegation.created",
  DELEGATION_REVOKED: "delegation.revoked",
  OFFLINE_CAPTURE_RECEIVED: "offline_capture.received",
  OFFLINE_CAPTURE_RESOLVED: "offline_capture.resolved",
  COMMISSION_FEED_EXPORTED: "commission_feed.exported",
  CRM_FEED_EXPORTED: "crm_feed.exported",
};

const GENESIS_HASH = "GENESIS";

// The fields a row's hash covers. Anything that describes what happened is
// in; the hash fields themselves and database bookkeeping are not.
const HASHED_FIELDS = [
  "shop",
  "occurredAt",
  "actorType",
  "actor",
  "actorShopifyCustomerId",
  "customer",
  "contextId",
  "action",
  "outcome",
  "reasonCode",
  "objectType",
  "objectId",
  "metadata",
];

// A stable text form of a value: object keys sorted, dates as ISO strings,
// ObjectIds as hex, undefined dropped — so a row hashes the same before it
// is saved and after it is read back.
function canonical(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    if (typeof value.toHexString === "function") return value.toHexString();
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

function computeHash(row, prevHash) {
  const body = {};
  for (const field of HASHED_FIELDS) body[field] = canonical(row[field]);

  return crypto.createHash("sha256").update(`${prevHash}|${JSON.stringify(body)}`).digest("hex");
}

// Writes are chained per shop: each row stores the previous row's hash and
// its own, so changing or removing any earlier row breaks every hash after it
// (spec §10.1 "hash chaining"). Writes for one shop are queued so the chain
// can't fork inside this process.
const queues = new Map();

async function appendToChain(event) {
  const last = await AuditEvent.findOne({ shop: event.shop, hash: { $exists: true } })
    .sort({ _id: -1 })
    .select("hash")
    .lean();
  const prevHash = last ? last.hash : GENESIS_HASH;

  const row = new AuditEvent({ ...event, occurredAt: event.occurredAt || new Date(), prevHash });
  row.hash = computeHash(row.toObject(), prevHash);
  await row.save();
}

// Records one audit event. A logging failure must never break the business
// action it describes, so errors are reported to the console and swallowed.
function recordAudit(event) {
  const previous = queues.get(event.shop) || Promise.resolve();

  const next = previous
    .then(() => appendToChain(event))
    .catch((err) => {
      console.error("[audit] failed to record event", event.action, err);
    });

  queues.set(event.shop, next);
  return next;
}

// Re-computes a shop's chain from the start and reports whether it is intact.
// Rows written before chaining existed carry no hash and are counted, not
// checked. Returns `{ checked, unchained, intact, firstBreak }`.
async function verifyChain(shop) {
  const unchained = await AuditEvent.countDocuments({ shop, hash: { $exists: false } });
  const cursor = AuditEvent.find({ shop, hash: { $exists: true } }).sort({ _id: 1 }).lean().cursor();

  let expectedPrev = GENESIS_HASH;
  let checked = 0;

  for await (const row of cursor) {
    const problem =
      row.prevHash !== expectedPrev
        ? "The chain is broken here: a row before this one was changed or removed."
        : row.hash !== computeHash(row, row.prevHash)
          ? "This row's contents no longer match its hash: it was altered."
          : null;

    if (problem) {
      return {
        checked,
        unchained,
        intact: false,
        firstBreak: { id: row._id, action: row.action, occurredAt: row.occurredAt, problem },
      };
    }

    expectedPrev = row.hash;
    checked += 1;
  }

  return { checked, unchained, intact: true, firstBreak: null };
}

module.exports = { AUDIT_ACTIONS, recordAudit, verifyChain, computeHash };
