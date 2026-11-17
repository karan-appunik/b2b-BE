const Customer = require("../models/customer.model");
const OrderFailure = require("../models/orderFailure.model");
const AgentSettings = require("../models/agentSettings.model");
const { findAgentByShopifyId, isAgentRole, authorizeAgent } = require("./agentAccess.service");
const { notify } = require("./notification.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");
const { EVENT_TYPES, emitEvent } = require("./outbox.service");

// Failed orders (spec §10.2): the agent and their managers are told once an
// order has failed after the retry policy, which is "the agent may try again
// once; the second failure of the same order raises the alert".
const DEFAULT_ALERT_AFTER = 2;

async function managersOf(shop, agent) {
  const people = await Customer.find({ shop, role: { $ne: "customer" } });
  const out = [];
  for (const person of people) {
    if (!isAgentRole(person.role) || String(person._id) === String(agent._id)) continue;
    const decision = await authorizeAgent(shop, person, "approval.decide");
    if (decision && decision.allowed) out.push(person);
  }
  return out;
}

// The storefront reports each failure of an order (same `key` = same order).
async function recordFailure({ shop, agentShopifyCustomerId, customerId, key, code, message }) {
  const agent = await findAgentByShopifyId(shop, agentShopifyCustomerId);
  if (!agent || !key) return { recorded: false };

  const row = await OrderFailure.findOneAndUpdate(
    { shop, key: String(key) },
    {
      $inc: { attempts: 1 },
      $set: { agent: agent._id, customer: customerId || undefined, lastCode: String(code || "").slice(0, 60), lastError: String(message || "").slice(0, 300), seenAt: new Date() },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const settings = await AgentSettings.findOne({ shop }).select("orderFailAlertAfter").lean();
  const after = (settings && settings.orderFailAlertAfter) || DEFAULT_ALERT_AFTER;
  if (row.attempts < after || row.alertedAt) return { recorded: true, attempts: row.attempts, alerted: false };

  // Only the first request to cross the line raises the alert.
  const claimed = await OrderFailure.findOneAndUpdate({ _id: row._id, alertedAt: { $exists: false } }, { $set: { alertedAt: new Date() } });
  if (!claimed) return { recorded: true, attempts: row.attempts, alerted: false };

  const customer = customerId ? await Customer.findById(customerId).select("name company") : null;
  const who = customer ? customer.company || customer.name : "a customer";
  const reason = row.lastError ? ` The last error was: ${row.lastError}` : "";

  await notify({
    shop,
    recipient: agent,
    type: "order.failed",
    title: "An order could not be placed",
    body: `The order for ${who} failed ${row.attempts} times.${reason}`,
    link: "/account",
    dedupeKey: `orderfail:${row._id}:agent`,
  });
  for (const manager of await managersOf(shop, agent)) {
    await notify({
      shop,
      recipient: manager,
      type: "order.failed",
      title: "An agent's order could not be placed",
      body: `${agent.name}'s order for ${who} failed ${row.attempts} times.${reason}`,
      link: "/account",
      dedupeKey: `orderfail:${row._id}:${manager._id}`,
    });
  }

  await recordAudit({
    shop,
    actorType: "system",
    customer: customerId || undefined,
    action: AUDIT_ACTIONS.ORDER_FAILED,
    outcome: "failure",
    reasonCode: row.lastCode || undefined,
    objectType: "order_attempt",
    objectId: String(row._id),
    metadata: { agentId: String(agent._id), attempts: row.attempts, error: row.lastError },
  });
  await emitEvent(shop, EVENT_TYPES.ORDER_FAILED, {
    sales_agent_id: String(agent._id),
    customer_id: customerId ? String(customerId) : null,
    attempts: row.attempts,
    reason_code: row.lastCode || null,
  });

  return { recorded: true, attempts: row.attempts, alerted: true };
}

// A delivery to the merchant's system gave up after its retries: managers are
// told, once per event.
async function alertIntegrationFailure({ shop, eventId, type, error }) {
  const people = await Customer.find({ shop, role: { $ne: "customer" } });
  for (const person of people) {
    if (!isAgentRole(person.role)) continue;
    const decision = await authorizeAgent(shop, person, "approval.decide");
    if (!decision || !decision.allowed) continue;
    await notify({
      shop,
      recipient: person,
      type: "integration.failed",
      title: "A message to your other system could not be delivered",
      body: `"${type}" was tried several times and given up. ${error ? "The last error: " + error : ""}`.trim(),
      link: "/account",
      dedupeKey: `intfail:${eventId}`,
    });
  }
}

module.exports = { DEFAULT_ALERT_AFTER, recordFailure, alertIntegrationFailure };
