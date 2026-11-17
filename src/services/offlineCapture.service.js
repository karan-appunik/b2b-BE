const mongoose = require("mongoose");

const OfflineCapture = require("../models/offlineCapture.model");
const Customer = require("../models/customer.model");
const AgentSettings = require("../models/agentSettings.model");
const { checkCustomerAccess, authorizeAgent } = require("./agentAccess.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");

// Phase 4: offline capture (see the model). The server never trusts a device:
// access is checked again here, nothing is priced, and the captured list only
// becomes part of a cart when the agent opens it and the usual checks pass.

const MAX_CAPTURES_PER_CALL = 50;
const MAX_LINES = 100;
const DAY_MS = 24 * 3600 * 1000;
const FUTURE_SLACK_MS = 10 * 60 * 1000;

async function settingsFor(shop) {
  const s = await AgentSettings.findOne({ shop }).select("offlineCaptureEnabled offlineCaptureDays").lean();
  return { enabled: !!(s && s.offlineCaptureEnabled), days: (s && s.offlineCaptureDays) || 7 };
}

function cleanLines(input) {
  if (!Array.isArray(input) || !input.length) return { error: "NO_LINES" };
  if (input.length > MAX_LINES) return { error: "TOO_MANY_LINES" };

  const lines = [];
  for (const row of input) {
    const quantity = Number(row && row.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) return { error: "BAD_QUANTITY" };
    const sku = String((row && row.sku) || "").trim().slice(0, 100);
    const barcode = String((row && row.barcode) || "").trim().slice(0, 100);
    const variantId = String((row && row.variantId) || "").trim().slice(0, 64);
    if (!sku && !barcode && !variantId) return { error: "NO_ITEM" };
    lines.push({ sku: sku || undefined, barcode: barcode || undefined, variantId: variantId || undefined, title: String((row && row.title) || "").trim().slice(0, 200) || undefined, quantity });
  }
  return { lines };
}

const REJECT_TEXT = {
  NO_LINES: "Nothing was captured",
  TOO_MANY_LINES: `A capture can have up to ${MAX_LINES} lines`,
  BAD_QUANTITY: "Quantities must be whole numbers of at least 1",
  NO_ITEM: "Each line needs a SKU, barcode or item",
  BAD_ID: "The capture has no id",
  BAD_DATE: "The capture date is not valid",
  STALE: "This capture is too old to be kept",
  CUSTOMER_NOT_FOUND: "That customer is not available to you",
  ACCESS_DENIED: "You no longer have access to that customer",
  ACCOUNT_INACTIVE: "That account is suspended, merged or closed",
  PERMISSION_DENIED: "Your role doesn't allow building a cart",
};

// Receives what a device saved while offline. Answers each capture on its own,
// so one bad row never blocks the rest, and a resend returns the first result.
async function receive({ shop, agent, captures }) {
  const settings = await settingsFor(shop);
  if (!settings.enabled) {
    const err = new Error("Offline capture is switched off");
    err.statusCode = 403;
    err.code = "OFFLINE_DISABLED";
    throw err;
  }
  if (!Array.isArray(captures) || !captures.length || captures.length > MAX_CAPTURES_PER_CALL) {
    const err = new Error(`Send between 1 and ${MAX_CAPTURES_PER_CALL} captures`);
    err.statusCode = 400;
    err.code = "BAD_REQUEST";
    throw err;
  }

  const may = await authorizeAgent(shop, agent, "cart.write");
  const now = new Date();
  const results = [];

  for (const input of captures) {
    const clientId = String((input && input.clientId) || "").trim().slice(0, 80);
    const reject = (code) => results.push({ clientId, status: "rejected", code, message: REJECT_TEXT[code] || code });

    if (!clientId) { reject("BAD_ID"); continue; }

    const existing = await OfflineCapture.findOne({ shop, agent: agent._id, clientId });
    if (existing) {
      results.push({ clientId, status: "duplicate", id: String(existing._id), captureStatus: existing.status });
      continue;
    }

    const capturedAt = new Date(input.capturedAt);
    if (Number.isNaN(capturedAt.getTime()) || capturedAt.getTime() > now.getTime() + FUTURE_SLACK_MS) { reject("BAD_DATE"); continue; }
    if (now.getTime() - capturedAt.getTime() > settings.days * DAY_MS) { reject("STALE"); continue; }

    if (!may.allowed) { reject("PERMISSION_DENIED"); continue; }

    const cleaned = cleanLines(input.lines);
    if (cleaned.error) { reject(cleaned.error); continue; }

    const customer = mongoose.isValidObjectId(input.customerId) ? await Customer.findOne({ _id: input.customerId, shop }) : null;
    if (!customer) { reject("CUSTOMER_NOT_FOUND"); continue; }
    // Suspended, merged and erased accounts can't be ordered for (spec §5.3).
    if ((customer.accountStatus && customer.accountStatus !== "active") || customer.erasedAt || customer.mergedInto) { reject("ACCOUNT_INACTIVE"); continue; }
    const access = await checkCustomerAccess(shop, agent, customer);
    if (!access.allowed) { reject("ACCESS_DENIED"); continue; }

    let doc;
    try {
      doc = await OfflineCapture.create({
        shop,
        agent: agent._id,
        customer: customer._id,
        clientId,
        capturedAt,
        receivedAt: now,
        lines: cleaned.lines,
        note: String(input.note || "").trim().slice(0, 500) || undefined,
        po: String(input.po || "").trim().slice(0, 64) || undefined,
      });
    } catch (err) {
      // Two sends of the same capture at once: the second is a repeat.
      if (err && err.code === 11000) {
        results.push({ clientId, status: "duplicate" });
        continue;
      }
      throw err;
    }

    await recordAudit({
      shop,
      actorType: "sales_agent",
      actor: agent._id,
      actorShopifyCustomerId: agent.shopifyCustomerId,
      customer: customer._id,
      action: AUDIT_ACTIONS.OFFLINE_CAPTURE_RECEIVED,
      objectType: "offline_capture",
      objectId: String(doc._id),
      metadata: { clientId, lines: doc.lines.length, capturedAt, delayMinutes: Math.round((now.getTime() - capturedAt.getTime()) / 60000) },
    });

    results.push({ clientId, status: "accepted", id: String(doc._id) });
  }

  return results;
}

async function listPending({ shop, agent }) {
  const rows = await OfflineCapture.find({ shop, agent: agent._id, status: "PENDING_REVIEW" }).sort({ capturedAt: -1 }).limit(100).lean();
  const ids = [...new Set(rows.map((r) => String(r.customer)))];
  const customers = await Customer.find({ shop, _id: { $in: ids } }).select("name company").lean();
  const byId = new Map(customers.map((c) => [String(c._id), c]));

  const out = [];
  for (const r of rows) {
    const c = byId.get(String(r.customer));
    const customer = c ? await Customer.findOne({ _id: r.customer, shop }) : null;
    // A customer the agent can no longer act for is not shown.
    if (!customer || !(await checkCustomerAccess(shop, agent, customer)).allowed) continue;
    out.push({
      id: String(r._id),
      customerId: String(r.customer),
      customerName: c.company || c.name,
      capturedAt: r.capturedAt,
      receivedAt: r.receivedAt,
      lines: r.lines,
      note: r.note || null,
      po: r.po || null,
    });
  }
  return out;
}

async function resolve({ shop, agent, id, outcome }) {
  if (!mongoose.isValidObjectId(id) || !["ADDED", "DISCARDED"].includes(outcome)) {
    const err = new Error("Not found");
    err.statusCode = 404;
    err.code = "NOT_FOUND";
    throw err;
  }

  const doc = await OfflineCapture.findOneAndUpdate(
    { _id: id, shop, agent: agent._id, status: "PENDING_REVIEW" },
    { $set: { status: outcome, resolvedAt: new Date() } },
    { new: true }
  );
  if (!doc) {
    const err = new Error("Not found");
    err.statusCode = 404;
    err.code = "NOT_FOUND";
    throw err;
  }

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
    customer: doc.customer,
    action: AUDIT_ACTIONS.OFFLINE_CAPTURE_RESOLVED,
    reasonCode: outcome,
    objectType: "offline_capture",
    objectId: String(doc._id),
  });

  return doc;
}

// Retention: a capture nobody reviewed goes after the configured days.
async function purgeOld(shop, now = new Date()) {
  const settings = await settingsFor(shop);
  const cutoff = new Date(now.getTime() - Math.max(settings.days, 1) * 4 * DAY_MS);
  const res = await OfflineCapture.deleteMany({ shop, receivedAt: { $lt: cutoff } });
  return res.deletedCount || 0;
}

module.exports = { receive, listPending, resolve, purgeOld, settingsFor };
