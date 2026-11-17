const mongoose = require("mongoose");

// How many times placing one order has failed (spec §10.2 "order failed"). The
// agent tries again (the same idempotency key), and only when it keeps failing
// are the agent and their managers told, so a single hiccup is not an alarm.
// The record disappears by itself after a week.
const orderFailureSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    key: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    lastCode: { type: String },
    lastError: { type: String },
    alertedAt: { type: Date },
    seenAt: { type: Date, default: Date.now, expires: 7 * 24 * 60 * 60 },
  },
  { timestamps: true }
);

orderFailureSchema.index({ shop: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("OrderFailure", orderFailureSchema);
