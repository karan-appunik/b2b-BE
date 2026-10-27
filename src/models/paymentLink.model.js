const mongoose = require("mongoose");

// A secure link that lets a buyer pay for an order on Shopify's hosted
// checkout (spec §9.4). The agent never sees or enters card details: they send
// this link, and the buyer pays on the hosted page. The link is bound to one
// customer, one order and one amount; it expires, can be withdrawn, and is
// replaced when the order's total changes. Money is in minor units.
const STATUSES = ["ACTIVE", "PAID", "EXPIRED", "REVOKED", "REPLACED"];

const activitySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    type: { type: String, required: true },
    comment: { type: String },
  },
  { _id: false }
);

const paymentLinkSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    // The opaque secret in the link the buyer receives.
    token: { type: String, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    quote: { type: mongoose.Schema.Types.ObjectId, ref: "Quote" },

    // What is being paid for: a Shopify draft order, and the hosted checkout
    // URL it came with. The URL is kept on the server only.
    draftOrderId: { type: String, required: true },
    invoiceUrl: { type: String, required: true, select: false },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    allowedMethods: { type: [String], default: ["card"] },
    // Where the order ships to. Tax depends on it, so when that address stops
    // being the customer's (it was changed in Shopify) the link is withdrawn
    // and a new one has to be sent (spec §12).
    shipTo: {
      zip: { type: String, trim: true },
      countryCode: { type: String, trim: true, uppercase: true },
      provinceCode: { type: String, trim: true, uppercase: true },
    },

    status: { type: String, enum: STATUSES, default: "ACTIVE", index: true },
    expiresAt: { type: Date, required: true },
    sentTo: { type: String },
    openedAt: { type: Date },
    openCount: { type: Number, default: 0 },
    revokedAt: { type: Date },
    replacedBy: { type: mongoose.Schema.Types.ObjectId },

    // Set when Shopify reports the order paid (reconciliation).
    paidAt: { type: Date },
    paidOrderId: { type: String },
    paidAmount: { type: Number },
    // "AMOUNT_MISMATCH" when what was paid differs from what the link asked.
    reconcileFlag: { type: String },
    activity: { type: [activitySchema], default: [] },
  },
  { timestamps: true }
);

paymentLinkSchema.index({ shop: 1, draftOrderId: 1, status: 1 });
paymentLinkSchema.index({ shop: 1, agent: 1, createdAt: -1 });

module.exports = mongoose.model("PaymentLink", paymentLinkSchema);
module.exports.STATUSES = STATUSES;
