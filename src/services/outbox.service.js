const crypto = require("crypto");

const OutboxEvent = require("../models/outboxEvent.model");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");

// Event types (spec Appendix B). Only those whose feature exists are emitted
// today; the rest are listed so consumers see the full vocabulary.
const EVENT_TYPES = {
  CONTEXT_ENTERED: "sales_agent.context.entered",
  CONTEXT_DENIED: "sales_agent.context.denied",
  OVERRIDE_REQUESTED: "sales_agent.override.requested",
  OVERRIDE_DECIDED: "sales_agent.override.decided",
  QUOTE_SENT: "sales_agent.quote.sent",
  QUOTE_RESPONDED: "sales_agent.quote.responded",
  ORDER_CREATED: "sales_agent.order.created",
  PAYMENT_COMPLETED: "sales_agent.payment.completed",
  CUSTOMER_CREATED: "sales_agent.customer.created",
  INTEGRATION_FAILED: "sales_agent.integration.failed",
  ORDER_FAILED: "sales_agent.order.failed",
};

const MAX_ATTEMPTS = 10;
const CLAIM_MS = 60 * 1000;
const BATCH_SIZE = 20;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

// Adds how our legal entity, channel and territory are named in the merchant's
// other systems (Module settings > integration mappings), when they have said.
async function withExternalNames(shop, payload) {
  // Analytics can follow an agent by this code instead of their identity.
  const agentId = payload && (payload.sales_agent_id || payload.agent_id);
  if (agentId && !payload.agent_pseudonym) {
    payload = { ...payload, agent_pseudonym: require("./pseudonym.service").agentPseudonym(shop, agentId) };
  }
  if (!payload || (!payload.legal_entity_id && !payload.channel_id && !payload.territory)) return payload;
  const settings = await require("../models/agentSettings.model").findOne({ shop }).select("integrationMappings").lean();
  const maps = (settings && settings.integrationMappings) || [];
  if (!maps.length) return payload;
  const find = (kind, value) => {
    const m = value ? maps.find((x) => x.kind === kind && x.from === value) : null;
    return m ? m.to : undefined;
  };
  const external = {};
  const le = find("legalEntity", payload.legal_entity_id);
  const ch = find("channel", payload.channel_id);
  const tr = find("territory", payload.territory);
  if (le !== undefined) external.legal_entity = le;
  if (ch !== undefined) external.channel = ch;
  if (tr !== undefined) external.territory = tr;
  return Object.keys(external).length ? { ...payload, external } : payload;
}

// Queues an event. Called right after the change it describes. Failure to
// queue is logged and swallowed — it must never undo or block the action.
async function emitEvent(shop, type, payload, { correlationId } = {}) {
  try {
    payload = await withExternalNames(shop, payload);
    await OutboxEvent.create({
      shop,
      eventId: crypto.randomUUID(),
      type,
      occurredAt: new Date(),
      correlationId,
      payload,
    });
  } catch (err) {
    console.error("[outbox] failed to queue event", type, err);
  }
}

function webhookConfig() {
  const url = process.env.AGENT_EVENTS_WEBHOOK_URL;
  if (!url) return null;
  return { url, secret: process.env.AGENT_EVENTS_WEBHOOK_SECRET || "" };
}

// The body receivers get. Stable ids, a schema version, the time it happened
// and a correlation id (spec §10.4).
function envelope(event) {
  return {
    event_id: event.eventId,
    type: event.type,
    schema_version: event.schemaVersion,
    occurred_at: event.occurredAt.toISOString(),
    correlation_id: event.correlationId || null,
    shop: event.shop,
    data: event.payload || {},
  };
}

function sign(body, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

// Next try after 10s, 20s, 40s … capped at an hour.
function backoffMs(attempts) {
  return Math.min(10 * 1000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

// Takes up to BATCH_SIZE due events, marking each "sending" so another
// dispatcher can't take the same one. Events whose claim lapsed (a dispatcher
// died mid-send) count as due again.
async function claimDue(now) {
  const claimed = [];

  for (let i = 0; i < BATCH_SIZE; i++) {
    const event = await OutboxEvent.findOneAndUpdate(
      {
        $or: [
          { status: "pending", nextAttemptAt: { $lte: now } },
          { status: "sending", lockedUntil: { $lt: now } },
        ],
      },
      { $set: { status: "sending", lockedUntil: new Date(now.getTime() + CLAIM_MS) } },
      { sort: { occurredAt: 1 }, new: true }
    );
    if (!event) break;
    claimed.push(event);
  }

  return claimed;
}

async function deliver(event, config, fetchImpl) {
  const body = JSON.stringify(envelope(event));

  const res = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SparkLayer-Event-Id": event.eventId,
      "X-SparkLayer-Event-Type": event.type,
      "X-SparkLayer-Signature": sign(body, config.secret),
    },
    body,
  });

  if (!res.ok) throw new Error(`Receiver answered ${res.status}`);
}

// Delivers whatever is due. Returns counts so callers (and tests) can see
// what happened. Does nothing until a webhook URL is configured — events
// simply wait.
async function dispatchDue({ fetchImpl = fetch, now = new Date() } = {}) {
  const config = webhookConfig();
  if (!config) return { delivered: 0, retried: 0, failed: 0, skipped: true };

  const result = { delivered: 0, retried: 0, failed: 0, skipped: false };

  for (const event of await claimDue(now)) {
    try {
      await deliver(event, config, fetchImpl);
      await OutboxEvent.updateOne(
        { _id: event._id },
        { $set: { status: "delivered", deliveredAt: new Date(), lastError: null }, $unset: { lockedUntil: 1 } }
      );
      result.delivered += 1;
    } catch (err) {
      const attempts = event.attempts + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;

      await OutboxEvent.updateOne(
        { _id: event._id },
        {
          $set: {
            status: exhausted ? "failed" : "pending",
            attempts,
            lastError: String(err.message || err).slice(0, 500),
            nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
          },
          $unset: { lockedUntil: 1 },
        }
      );

      if (exhausted) {
        result.failed += 1;
        await recordAudit({
          shop: event.shop,
          actorType: "system",
          action: AUDIT_ACTIONS.INTEGRATION_FAILED,
          outcome: "failure",
          objectType: "outbox_event",
          objectId: event.eventId,
          metadata: { type: event.type, attempts, error: String(err.message || err).slice(0, 200) },
        });
        // Managers are told, once, that this message was given up on.
        require("./orderFailure.service")
          .alertIntegrationFailure({ shop: event.shop, eventId: event.eventId, type: event.type, error: String(err.message || err).slice(0, 200) })
          .catch((e) => console.error("[outbox] could not alert managers", e));
      } else {
        result.retried += 1;
      }
    }
  }

  return result;
}

let timer = null;

// Runs the dispatcher on an interval (started once by server.js).
function startOutboxDispatcher(intervalMs = 5000) {
  if (timer) return;

  timer = setInterval(() => {
    dispatchDue().catch((err) => console.error("[outbox] dispatch sweep failed:", err.message));
  }, intervalMs);
  timer.unref();
}

module.exports = {
  EVENT_TYPES,
  MAX_ATTEMPTS,
  emitEvent,
  envelope,
  sign,
  dispatchDue,
  startOutboxDispatcher,
};
