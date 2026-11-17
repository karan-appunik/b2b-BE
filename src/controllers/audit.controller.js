const mongoose = require("mongoose");

const AuditEvent = require("../models/auditEvent.model");
const { verifyChain, recordAudit, AUDIT_ACTIONS } = require("../services/audit.service");

const MAX_LIMIT = 200;

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// Newest first. Filter by agent (`agentId`), represented customer
// (`customerId`), `action`, `outcome` and a `from` / `to` window; page with
// `before` (the `occurredAt` of the last row received).
async function getAuditEvents(req, res, next) {
  try {
    const { agentId, customerId, action, outcome } = req.query;
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    const before = parseDate(req.query.before);

    if (from === undefined || to === undefined || before === undefined) {
      return res.status(400).json({ message: "from, to and before must be valid dates" });
    }
    for (const [name, value] of [["agentId", agentId], ["customerId", customerId]]) {
      if (value && !mongoose.isValidObjectId(value)) {
        return res.status(400).json({ message: `${name} must be a valid id` });
      }
    }

    const filter = { shop: req.user.shop };
    if (agentId) filter.actor = agentId;
    if (customerId) filter.customer = customerId;
    if (action) filter.action = String(action);
    if (outcome) filter.outcome = String(outcome);

    const occurredAt = {};
    if (from) occurredAt.$gte = from;
    if (to) occurredAt.$lte = to;
    if (before) occurredAt.$lt = before;
    if (Object.keys(occurredAt).length) filter.occurredAt = occurredAt;

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_LIMIT);

    const events = await AuditEvent.find(filter).sort({ occurredAt: -1 }).limit(limit);
    res.status(200).json(events.map((e) => ({ ...e.toObject(), metadata: scrub(e.metadata) })));
  } catch (err) {
    next(err);
  }
}

// What a record may carry out of the system (spec §10.1 "privacy", AC14): no
// secrets, tokens or card data, whatever a field is called.
const SECRET_KEY = /secret|token|password|passcode|authorization|card|pan|cvv|cvc|iban|account.?number|key/i;

function scrub(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[removed]" : scrub(v, depth + 1)])
  );
}

// A spreadsheet runs text that starts with = + - or @ as a formula; a leading
// quote makes it plain text.
function csvCell(value) {
  // Ids are written as plain text; other objects (the details) as JSON.
  const isId = value && typeof value === "object" && value._bsontype;
  let text = value === undefined || value === null ? "" : isId ? String(value) : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

const EXPORT_LIMIT = 10000;
const EXPORT_COLUMNS = ["occurredAt", "actorType", "actor", "actorShopifyCustomerId", "customer", "action", "outcome", "reasonCode", "objectType", "objectId", "metadata"];

// GET /api/audit/export — the same filters as the list, as a CSV file. The
// export itself is recorded (who, which filters, how many rows).
async function exportAuditEvents(req, res, next) {
  try {
    const { agentId, customerId, action, outcome } = req.query;
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);

    if (from === undefined || to === undefined) {
      return res.status(400).json({ message: "from and to must be valid dates" });
    }
    for (const [name, value] of [["agentId", agentId], ["customerId", customerId]]) {
      if (value && !mongoose.isValidObjectId(value)) return res.status(400).json({ message: `${name} must be a valid id` });
    }

    const filter = { shop: req.user.shop };
    if (agentId) filter.actor = agentId;
    if (customerId) filter.customer = customerId;
    if (action) filter.action = String(action);
    if (outcome) filter.outcome = String(outcome);
    const occurredAt = {};
    if (from) occurredAt.$gte = from;
    if (to) occurredAt.$lte = to;
    if (Object.keys(occurredAt).length) filter.occurredAt = occurredAt;

    const events = await AuditEvent.find(filter).sort({ occurredAt: -1 }).limit(EXPORT_LIMIT).lean();

    // The export is written down before it is handed over.
    await recordAudit({
      shop: req.user.shop,
      actorType: "merchant_user",
      actor: req.user._id,
      action: AUDIT_ACTIONS.AUDIT_EXPORTED,
      objectType: "audit_export",
      metadata: { rows: events.length, truncated: events.length === EXPORT_LIMIT, filters: { agentId, customerId, action, outcome, from: req.query.from, to: req.query.to } },
    });

    const lines = [EXPORT_COLUMNS.join(",")];
    for (const e of events) {
      lines.push(EXPORT_COLUMNS.map((c) => csvCell(c === "metadata" ? scrub(e.metadata) : e[c] instanceof Date ? e[c].toISOString() : e[c])).join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="agent-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.status(200).send(lines.join("\r\n") + "\r\n");
  } catch (err) {
    next(err);
  }
}

// GET /api/audit/verify — checks the shop's audit trail hasn't been altered.
async function verifyAuditTrail(req, res, next) {
  try {
    res.status(200).json(await verifyChain(req.user.shop));
  } catch (err) {
    next(err);
  }
}

module.exports = {
  exportAuditEvents, getAuditEvents, verifyAuditTrail };
