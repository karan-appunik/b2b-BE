const mongoose = require("mongoose");

const Order = require("../models/order.model");
const Customer = require("../models/customer.model");
const ContextSession = require("../models/contextSession.model");
const OverrideRequest = require("../models/overrideRequest.model");
const Quote = require("../models/quote.model");
const { AUDIT_ACTIONS, recordAudit } = require("../services/audit.service");
const { EVENT_TYPES, emitEvent } = require("../services/outbox.service");
const { sendAgentOrderPlacedEmails } = require("../services/email.service");

function parseDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return 7;
  return Math.min(days, 365);
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

// List of B2B orders for the activity feed — newest first, optionally
// windowed to the last N days (same window the stats endpoint uses).
async function getOrders(req, res, next) {
  try {
    const shop = req.user.shop;
    const days = parseDays(req.query.days);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const orders = await Order.find({ shop, orderedAt: { $gte: since } })
      .sort({ orderedAt: -1 })
      .limit(200);

    res.status(200).json(orders);
  } catch (err) {
    next(err);
  }
}

// Orders count / total sales / average order value for the selected window,
// each compared against the immediately preceding window of the same length
// (so "last 7 days" is compared against the 7 days before that) — plus a
// day-by-day series for both windows, aligned by day-offset, for the
// dashboard's overlaid current-vs-previous line chart.
async function getOrderStats(req, res, next) {
  try {
    const shop = req.user.shop;
    const days = parseDays(req.query.days);
    const now = new Date();
    const currentStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const previousStart = new Date(currentStart.getTime() - days * 24 * 60 * 60 * 1000);

    const orders = await Order.find({
      shop,
      orderedAt: { $gte: previousStart, $lte: now },
    }).select("orderedAt totalPrice");

    const currentOrders = [];
    const previousOrders = [];
    for (const order of orders) {
      if (order.orderedAt >= currentStart) currentOrders.push(order);
      else previousOrders.push(order);
    }

    const sum = (list) => list.reduce((total, o) => total + o.totalPrice, 0);
    const currentSales = sum(currentOrders);
    const previousSales = sum(previousOrders);
    const currentAvg = currentOrders.length ? currentSales / currentOrders.length : 0;
    const previousAvg = previousOrders.length ? previousSales / previousOrders.length : 0;

    function changePct(current, previous) {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    }

    // Bucket each window's orders by day, then align previous[i] with
    // current[i] (day 1 of this window vs day 1 of the prior window) rather
    // than by calendar date, so the two lines overlay meaningfully.
    function dailyTotals(list, start) {
      const totals = new Map();
      for (let i = 0; i < days; i++) {
        const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
        totals.set(dayKey(d), 0);
      }
      for (const order of list) {
        const key = dayKey(order.orderedAt);
        if (totals.has(key)) totals.set(key, totals.get(key) + order.totalPrice);
      }
      return Array.from(totals.entries()).map(([date, total]) => ({ date, total }));
    }

    const currentDaily = dailyTotals(currentOrders, currentStart);
    const previousDaily = dailyTotals(previousOrders, previousStart);

    const series = currentDaily.map((point, i) => ({
      date: point.date,
      current: point.total,
      previous: previousDaily[i]?.total ?? 0,
    }));

    res.status(200).json({
      orders: { value: currentOrders.length, changePct: changePct(currentOrders.length, previousOrders.length) },
      totalSales: { value: currentSales, changePct: changePct(currentSales, previousSales) },
      averageOrderValue: { value: currentAvg, changePct: changePct(currentAvg, previousAvg) },
      series,
    });
  } catch (err) {
    next(err);
  }
}

// Works out which orders in a sync batch were placed by an agent, keyed by
// shopifyOrderId. Attribution is only accepted when the claimed context
// really exists, belongs to that agent, and was for the order's customer —
// the order's note attributes alone are never trusted. Rejected claims are
// audited and the order is stored as a normal customer order.
async function resolveAgentAttribution(shop, orders) {
  const claims = orders.filter((o) => o.placedByAgent && o.placedByAgent.contextId);
  const attribution = new Map();
  // Orders newly attributed in this batch, so the people involved can be told.
  const notices = [];
  if (claims.length === 0) return { attribution, notices };

  const contextIds = [
    ...new Set(
      claims.map((o) => o.placedByAgent.contextId).filter((id) => mongoose.isValidObjectId(id))
    ),
  ];
  const sessions = await ContextSession.find({ shop, _id: { $in: contextIds } });
  const sessionById = new Map(sessions.map((s) => [String(s._id), s]));

  const agentGids = [...new Set(claims.map((o) => String(o.placedByAgent.agentShopifyCustomerId)))];
  const [agents, customers] = await Promise.all([
    Customer.find({ shop, shopifyCustomerId: { $in: agentGids } }),
    Customer.find({
      shop,
      _id: { $in: sessions.map((s) => s.customer) },
    }),
  ]);
  const agentByGid = new Map(agents.map((a) => [a.shopifyCustomerId, a]));
  const customerById = new Map(customers.map((c) => [String(c._id), c]));

  for (const order of claims) {
    const claim = order.placedByAgent;
    const session = sessionById.get(String(claim.contextId));
    const agent = agentByGid.get(String(claim.agentShopifyCustomerId));
    const customer = session ? customerById.get(String(session.customer)) : null;

    const valid =
      session &&
      agent &&
      String(session.agent) === String(agent._id) &&
      customer &&
      customer.shopifyCustomerId === order.shopifyCustomerId;

    if (valid) {
      // Which exceptions and which quote this order rests on. Only ones that
      // really belong to this agent and this customer are kept; the order's
      // note attributes are a claim, not proof.
      const claimedOverrides = (claim.overrideIds || []).filter((id) => mongoose.isValidObjectId(id));
      const overrides = claimedOverrides.length
        ? await OverrideRequest.find({ _id: { $in: claimedOverrides }, shop, agent: agent._id, customer: customer._id }).select("_id")
        : [];
      const quote = claim.quoteId && mongoose.isValidObjectId(claim.quoteId)
        ? await Quote.findOne({ _id: claim.quoteId, shop, customer: customer._id }).select("_id")
        : null;

      attribution.set(String(order.shopifyOrderId), {
        agent: agent._id,
        context: session._id,
        overrides: overrides.map((o) => o._id),
        ...(quote ? { quote: quote._id } : {}),
      });
      await emitEvent(shop, EVENT_TYPES.ORDER_CREATED, {
        order_id: String(order.shopifyOrderId),
        customer_id: String(customer._id),
        sales_agent_id: String(agent._id),
        source: "sales_agent",
        legal_entity_id: customer.legalEntity || null,
        channel_id: "b2b_web",
        territory: customer.territory || null,
        override_ids: overrides.map((o) => String(o._id)),
        quote_id: quote ? String(quote._id) : null,
        totals: { amount: order.totalPrice, currency: order.currency },
        external_refs: { shopify_order_id: String(order.shopifyOrderId), order_name: order.name },
      });
      notices.push({
        order: { name: order.name, totalPrice: order.totalPrice, currency: order.currency },
        agent: { name: agent.name, email: agent.email },
        customer: { name: customer.name, email: customer.email },
      });
      await recordAudit({
        shop,
        actorType: "sales_agent",
        actor: agent._id,
        actorShopifyCustomerId: agent.shopifyCustomerId,
        customer: customer._id,
        contextId: session._id,
        action: AUDIT_ACTIONS.ORDER_ATTRIBUTED,
        objectType: "order",
        objectId: String(order.shopifyOrderId),
        metadata: {
          orderName: order.name,
          totalPrice: order.totalPrice,
          currency: order.currency,
          overrides: overrides.map((o) => String(o._id)),
          quote: quote ? String(quote._id) : undefined,
        },
      });
    } else {
      await recordAudit({
        shop,
        actorType: "system",
        action: AUDIT_ACTIONS.ORDER_ATTRIBUTION_REJECTED,
        outcome: "denied",
        reasonCode: "CONTEXT_MISMATCH",
        objectType: "order",
        objectId: String(order.shopifyOrderId),
        metadata: { claimedContextId: String(claim.contextId) },
      });
    }
  }

  return { attribution, notices };
}

// Fire-and-forget: a mail problem must never fail or delay the order sync.
function notifyAgentOrders(notices) {
  for (const notice of notices) {
    sendAgentOrderPlacedEmails(notice).catch((err) => {
      console.error("[email] agent order notification failed", err);
    });
  }
}

// Called from admin-frontend's order sync (bulk on install + webhooks on
// orders/create and orders/updated) — upserts by shopifyOrderId so a status
// change (e.g. paid, fulfilled) updates the existing row instead of
// duplicating it.
async function bulkImportOrders(req, res, next) {
  try {
    const { shop, orders } = req.body;

    if (!shop || !Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ message: "shop and a non-empty orders array are required" });
    }

    // The same order is synced several times (checkout, orders/create,
    // orders/updated); only record attribution the first time it is claimed
    // so a repeat sync doesn't duplicate the audit trail.
    const existingAttributed = new Set(
      (
        await Order.find({
          shop,
          shopifyOrderId: { $in: orders.map((o) => String(o.shopifyOrderId)) },
          "placedByAgent.agent": { $exists: true },
        }).select("shopifyOrderId")
      ).map((o) => o.shopifyOrderId)
    );
    const { attribution, notices } = await resolveAgentAttribution(
      shop,
      orders.filter((o) => !existingAttributed.has(String(o.shopifyOrderId)))
    );

    const ops = orders
      .filter((o) => o.shopifyOrderId && o.name && o.orderedAt && o.totalPrice != null)
      .map((o) => ({
        updateOne: {
          filter: { shop, shopifyOrderId: String(o.shopifyOrderId) },
          update: {
            $set: {
              name: o.name,
              orderedAt: new Date(o.orderedAt),
              totalPrice: Number(o.totalPrice),
              currency: o.currency || "USD",
              financialStatus: o.financialStatus || null,
              fulfillmentStatus: o.fulfillmentStatus || null,
              shippingAddress: o.shippingAddress || null,
              customerName: o.customerName || null,
              customerEmail: o.customerEmail || null,
              shopifyCustomerId: o.shopifyCustomerId || null,
              ...(o.poNumber ? { poNumber: String(o.poNumber).slice(0, 64) } : {}),
              ...(o.requestedDeliveryDate ? { requestedDeliveryDate: String(o.requestedDeliveryDate).slice(0, 10) } : {}),
              ...(o.internalNote ? { internalNote: String(o.internalNote).slice(0, 500) } : {}),
              shop,
              // Only written when attribution was proven; later syncs that
              // carry no attribution (e.g. the bulk install import) must not
              // wipe it.
              ...(attribution.has(String(o.shopifyOrderId))
                ? { source: "sales_agent", placedByAgent: attribution.get(String(o.shopifyOrderId)) }
                : {}),
            },
          },
          upsert: true,
        },
      }));

    if (ops.length === 0) {
      return res.status(400).json({ message: "No valid rows to import" });
    }

    const result = await Order.bulkWrite(ops, { ordered: false });

    notifyAgentOrders(notices);

    res.status(200).json({
      received: orders.length,
      imported: ops.length,
      created: result.upsertedCount,
      updated: result.modifiedCount,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getOrders,
  getOrderStats,
  bulkImportOrders,
};
