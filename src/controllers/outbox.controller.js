const mongoose = require("mongoose");

const OutboxEvent = require("../models/outboxEvent.model");

const STATUSES = ["pending", "sending", "delivered", "failed"];

// GET /api/outbox?status=failed&limit=50 — the integration event queue, so a
// merchant can see what is waiting, delivered, or stuck (spec §11.4 outbox
// backlog / failed integrations).
async function listEvents(req, res, next) {
  try {
    const filter = { shop: req.user.shop };

    if (req.query.status) {
      if (!STATUSES.includes(req.query.status)) {
        return res.status(400).json({ message: `status must be one of: ${STATUSES.join(", ")}` });
      }
      filter.status = req.query.status;
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    const [events, counts] = await Promise.all([
      OutboxEvent.find(filter).sort({ occurredAt: -1 }).limit(limit).lean(),
      OutboxEvent.aggregate([
        { $match: { shop: req.user.shop } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    res.status(200).json({
      counts: Object.fromEntries(counts.map((c) => [c._id, c.count])),
      events,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/outbox/:id/retry — puts a failed event back in the queue.
async function retryEvent(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Event not found" });
    }

    const event = await OutboxEvent.findOneAndUpdate(
      { _id: req.params.id, shop: req.user.shop, status: "failed" },
      { $set: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null } },
      { new: true }
    );

    if (!event) return res.status(404).json({ message: "No failed event with that id" });

    res.status(200).json(event);
  } catch (err) {
    next(err);
  }
}

module.exports = { listEvents, retryEvent };
