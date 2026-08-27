const Order = require("../models/order.model");

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
              shop,
            },
          },
          upsert: true,
        },
      }));

    if (ops.length === 0) {
      return res.status(400).json({ message: "No valid rows to import" });
    }

    const result = await Order.bulkWrite(ops, { ordered: false });

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
