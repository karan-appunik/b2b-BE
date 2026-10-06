const mongoose = require("mongoose");

// One row per (discount, customer, order) — lets "usage limits" on a
// Discount (Discount.usageLimitPerCustomer) be enforced by counting rows
// instead of maintaining a running counter, which would drift if an order
// gets cancelled/edited later.
const discountRedemptionSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true, index: true },
    discount: { type: mongoose.Schema.Types.ObjectId, ref: "Discount", required: true },
    shopifyCustomerId: { type: String, required: true, trim: true },
    orderId: { type: String, trim: true },
    // docs.sparklayer.io/discounts "Data Tracking" — order-level analytics,
    // best-effort: null when the checkout proxy couldn't compute a dollar
    // amount for this reward type (e.g. free_product/line_item), never
    // required so older/undecorated redemption calls keep working.
    preDiscountTotal: { type: Number, default: null },
    savingsAmount: { type: Number, default: null },
    currency: { type: String, trim: true, uppercase: true, default: null },
    // The coupon code that earned this redemption, resolved from the
    // Discount doc at record time (first saved code) rather than stored
    // redundantly by the caller — null for automatic discounts.
    couponCode: { type: String, trim: true, uppercase: true, default: null },
  },
  { timestamps: true }
);

discountRedemptionSchema.index({ shop: 1, discount: 1, shopifyCustomerId: 1 });

module.exports = mongoose.model("DiscountRedemption", discountRedemptionSchema);
