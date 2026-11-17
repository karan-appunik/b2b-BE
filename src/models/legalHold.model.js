const mongoose = require("mongoose");

// A legal hold (spec §11.2): while it stands, nothing about the customer (or,
// for a shop-wide hold, nothing at all) is deleted by a retention schedule or
// a data-subject request. Holds are never removed, only released, so who held
// what, and until when, stays on record.
const legalHoldSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true, index: true },
    scope: { type: String, enum: ["shop", "customer"], required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    placedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    releasedAt: { type: Date, default: null },
    releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

legalHoldSchema.index({ shop: 1, releasedAt: 1, scope: 1 });

module.exports = mongoose.model("LegalHold", legalHoldSchema);
