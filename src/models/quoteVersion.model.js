const mongoose = require("mongoose");

// One version of a quote's content (spec §6.2 `quote_versions`). Once it has
// been sent, sent for approval, or accepted it is locked and never changed;
// a revision is a new version. Money is in minor units (cents).
const itemSchema = new mongoose.Schema(
  {
    variantId: { type: String, required: true },
    title: { type: String, default: "" },
    sku: { type: String, default: "" },
    quantity: { type: Number, required: true, min: 1 },
    // The price the customer would pay with no exception, and the price
    // quoted (they differ when an approved price exception is included).
    baselineUnit: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    overrideId: { type: mongoose.Schema.Types.ObjectId, ref: "OverrideRequest" },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const quoteVersionSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    quote: { type: mongoose.Schema.Types.ObjectId, ref: "Quote", required: true },
    version: { type: Number, required: true },
    currency: { type: String, required: true, uppercase: true, trim: true },
    items: { type: [itemSchema], default: [] },
    totals: {
      subtotal: { type: Number, required: true, min: 0 },
      // What the quote saves compared with the baseline prices.
      savings: { type: Number, default: 0, min: 0 },
    },
    terms: {
      // Days the buyer has to accept once it is sent.
      validDays: { type: Number, default: 14, min: 1 },
      // Shown to the customer.
      notes: { type: String, default: "" },
      // Never shown to the customer.
      internalNotes: { type: String, default: "" },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId },
    // Set when the version stops being editable.
    lockedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

quoteVersionSchema.index({ quote: 1, version: 1 }, { unique: true });

module.exports = mongoose.model("QuoteVersion", quoteVersionSchema);
