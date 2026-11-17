const mongoose = require("mongoose");

// Remembers one logical operation so a retry doesn't repeat its effect
// (spec §7.1 "Idempotency-Key", §12 "order request times out"). The same key
// with the same request returns the first result; the same key with a
// different request is a conflict.
const idempotencyKeySchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    // What the key is for (e.g. "checkout:<customer id>"), so unrelated
    // operations can't collide on the same key text.
    scope: { type: String, required: true, trim: true },
    key: { type: String, required: true, trim: true },
    requestHash: { type: String, required: true },
    status: { type: String, enum: ["in_progress", "completed"], default: "in_progress" },
    // What was returned the first time: { status, body }.
    response: { type: mongoose.Schema.Types.Mixed },
    startedAt: { type: Date, default: Date.now },
    // Records are only kept long enough to cover realistic retries.
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false, versionKey: false }
);

idempotencyKeySchema.index({ shop: 1, scope: 1, key: 1 }, { unique: true });
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("IdempotencyKey", idempotencyKeySchema);
