const mongoose = require("mongoose");

// An integration event waiting to be delivered (spec §6.3, §10.4). Business
// code only writes a row here; a separate dispatcher delivers it with
// retries, so a slow or failing receiver never affects the action that
// produced the event. Delivery is at-least-once: receivers must treat
// `eventId` as the key and ignore repeats.
const outboxEventSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    schemaVersion: { type: Number, default: 1 },
    occurredAt: { type: Date, required: true },
    correlationId: { type: String },
    // Stable ids and the minimum data needed — no secrets, no extra personal data.
    payload: { type: mongoose.Schema.Types.Mixed },
    status: { type: String, enum: ["pending", "sending", "delivered", "failed"], default: "pending" },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    // While "sending", the claim expires at this time so a crashed dispatcher
    // doesn't strand the event.
    lockedUntil: { type: Date },
    lastError: { type: String },
    deliveredAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

outboxEventSchema.index({ status: 1, nextAttemptAt: 1 });
outboxEventSchema.index({ shop: 1, createdAt: -1 });
// Old rows are cleared after 30 days whether delivered or not.
outboxEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model("OutboxEvent", outboxEventSchema);
