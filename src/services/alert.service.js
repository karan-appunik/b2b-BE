const OverrideRequest = require("../models/overrideRequest.model");
const Quote = require("../models/quote.model");
const Customer = require("../models/customer.model");
const Order = require("../models/order.model");
const AgentCart = require("../models/agentCart.model");
const overrides = require("./override.service");
const { isAgentRole, buildCustomerScopeFilter } = require("./agentAccess.service");
const { notify, sendPendingEmails } = require("./notification.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");

// The timed alerts (spec §10.2, §4.2, §11.4): an approval that waits past its
// SLA is escalated, a sent quote gets reminders as it nears expiry, and each
// agent gets one daily summary of what needs their attention. Every alert is
// made once (dedupe keys); emails wait out quiet hours.

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const dayKey = (now, timeZone) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

const money = (minor, currency) => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${minor / 100} ${currency}`;
  }
};

// A request still waiting after its SLA goes to everyone who can decide it,
// and is recorded as escalated. The original request, route and history stay
// as they were (spec §8.4).
async function escalateApprovals(shop, settings, now) {
  if (!settings.escalateApprovals) return 0;

  const waiting = await OverrideRequest.find({ shop, status: "PENDING_APPROVAL", escalatedAt: null });
  const agents = await Customer.find({ shop, role: { $ne: "customer" } });
  let escalated = 0;

  for (const request of waiting) {
    const sla = (request.route && request.route.slaHours) || 24;
    if (now.getTime() - request.createdAt.getTime() <= sla * HOUR) continue;

    const claimed = await OverrideRequest.findOneAndUpdate({ _id: request._id, escalatedAt: null }, { $set: { escalatedAt: now } });
    if (!claimed) continue;

    const requester = agents.find((a) => String(a._id) === String(request.agent));
    for (const agent of agents) {
      if (!isAgentRole(agent.role)) continue;
      const block = await overrides.approvalBlock({ shop, request, approver: { kind: "agent", agent } });
      if (block !== null && block !== "STEP_UP_REQUIRED") continue;

      await notify({
        shop,
        recipient: agent,
        type: "approval.overdue",
        title: "An approval is overdue",
        body: `${requester ? requester.name : "An agent"}'s ${request.type.split("_").join(" ").toLowerCase()} has waited more than ${sla} hour(s) for a decision.`,
        link: "/account",
        dedupeKey: `esc:${request._id}`,
      });
    }

    await recordAudit({
      shop,
      actorType: "system",
      customer: request.customer,
      action: AUDIT_ACTIONS.OVERRIDE_ESCALATED,
      objectType: "override_request",
      objectId: String(request._id),
      metadata: { slaHours: sla },
    });
    escalated += 1;
  }

  return escalated;
}

// As a sent quote nears expiry the owner and the buyer are reminded, on the
// days the shop chose. If several days were skipped only the latest one is sent.
async function remindQuotes(shop, settings, now) {
  const days = [...settings.quoteReminderDays].sort((a, b) => a - b);
  if (!days.length) return 0;

  const quotes = await Quote.find({ shop, status: "SENT", expiresAt: { $gt: now } });
  let sent = 0;

  for (const quote of quotes) {
    const left = quote.expiresAt.getTime() - now.getTime();
    const due = days.find((d) => left <= d * DAY);
    if (due === undefined) continue;

    const [owner, buyer] = await Promise.all([Customer.findById(quote.ownerAgent), Customer.findById(quote.customer)]);
    const when = quote.expiresAt.toDateString();
    const key = `quote-exp:${quote._id}:${due}`;

    if (owner) {
      const r = await notify({ shop, recipient: owner, type: "quote.expiring", title: `Quote ${quote.number} expires soon`, body: `${buyer ? buyer.name : "The customer"} hasn't answered. It expires on ${when}.`, link: "/account", dedupeKey: key });
      if (r.created) sent += 1;
    }
    if (buyer) {
      await notify({ shop, recipient: buyer, type: "quote.expiring", title: `Your quote ${quote.number} expires on ${when}`, body: "Open My Account to accept it or ask for changes.", link: "/account", dedupeKey: key, inApp: false });
    }
  }

  return sent;
}

// One summary a day per agent: customers who ordered by themselves, accounts
// that have gone quiet, credit running out, and carts left behind (spec §4.2,
// §10.2 "in-app or digest to avoid noise"). Nothing to say, nothing sent.
async function sendDigests(shop, settings, now) {
  if (!settings.digestEnabled) return 0;

  const today = dayKey(now, settings.businessTimezone);
  const agents = (await Customer.find({ shop, role: { $ne: "customer" } })).filter((a) => isAgentRole(a.role));
  const recentBuyers = await Order.distinct("shopifyCustomerId", { shop, orderedAt: { $gte: new Date(now.getTime() - 90 * DAY) } });
  const recentSet = new Set(recentBuyers);
  let sent = 0;

  for (const agent of agents) {
    const filter = await buildCustomerScopeFilter(shop, agent);
    if (!filter) continue;

    const accounts = await Customer.find({ $and: [{ shop, role: "customer" }, filter] })
      .select("name shopifyCustomerId createdAt creditLimit creditBalance")
      .limit(5000)
      .lean();
    if (!accounts.length) continue;

    const ids = accounts.map((a) => a.shopifyCustomerId).filter(Boolean);
    const selfService = await Order.countDocuments({
      shop,
      shopifyCustomerId: { $in: ids },
      source: { $ne: "sales_agent" },
      orderedAt: { $gte: new Date(now.getTime() - DAY) },
    });
    const quiet = accounts.filter((a) => a.shopifyCustomerId && !recentSet.has(a.shopifyCustomerId) && now - new Date(a.createdAt) > 90 * DAY).length;
    const lowCredit = accounts.filter((a) => a.creditLimit > 0 && a.creditBalance >= a.creditLimit * 0.9).length;
    const staleCarts = await AgentCart.countDocuments({ shop, agent: agent._id, "items.0": { $exists: true }, updatedAt: { $lt: new Date(now.getTime() - 7 * DAY) } });

    const lines = [];
    if (selfService) lines.push(`${selfService} of your customers ordered by themselves in the last day.`);
    if (quiet) lines.push(`${quiet} account(s) haven't ordered in 90 days.`);
    if (lowCredit) lines.push(`${lowCredit} account(s) have used 90% or more of their credit.`);
    if (staleCarts) lines.push(`${staleCarts} saved cart(s) haven't been touched for a week.`);
    if (!lines.length) continue;

    const r = await notify({ shop, recipient: agent, type: "digest.daily", title: "Your daily summary", body: lines.join(" "), link: "/account", dedupeKey: `digest:${today}` });
    if (r.created) sent += 1;
  }

  return sent;
}

async function sweepShop(shop, now) {
  const settings = await overrides.getSettings(shop);
  if (settings.alertsEnabled === false) return { escalated: 0, reminders: 0, digests: 0 };

  return {
    escalated: await escalateApprovals(shop, settings, now),
    reminders: await remindQuotes(shop, settings, now),
    digests: await sendDigests(shop, settings, now),
  };
}

// One pass over every shop, then the emails that are due.
async function runSweep(now = new Date()) {
  const shops = await Customer.distinct("shop");
  const result = { escalated: 0, reminders: 0, digests: 0 };

  for (const shop of shops) {
    try {
      const r = await sweepShop(shop, now);
      result.escalated += r.escalated;
      result.reminders += r.reminders;
      result.digests += r.digests;
    } catch (err) {
      console.error("[alerts] sweep failed for", shop, err);
    }
  }

  result.emails = await sendPendingEmails(now);
  return result;
}

let timer = null;

function startAlertSweeper(intervalMs = 5 * 60 * 1000) {
  if (timer) return;
  timer = setInterval(() => {
    runSweep().catch((err) => console.error("[alerts] sweep failed:", err.message));
  }, intervalMs);
  timer.unref();
}

module.exports = { escalateApprovals, remindQuotes, sendDigests, runSweep, startAlertSweeper, money };
