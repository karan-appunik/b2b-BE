const mongoose = require("mongoose");

const priceListItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const shopifyItemDiscountSchema = new mongoose.Schema(
  {
    variantId: { type: String, trim: true, required: true },
    shopifyDiscountId: { type: String, trim: true, required: true },
  },
  { _id: false }
);

const priceListSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    handle: { type: String, trim: true, lowercase: true },
    currency: { type: String, trim: true, uppercase: true, default: "USD" },
    description: { type: String, trim: true },
    status: { type: String, enum: ["active", "draft"], default: "draft" },
    pricingType: { type: String, enum: ["manual", "automatic"], default: "manual" },
    automaticPricing: {
      discountType: { type: String, enum: ["percentage", "fixed"], default: "percentage" },
      discountValue: { type: Number, default: 0, min: 0 },
    },
    items: { type: [priceListItemSchema], default: [] },
    shopifyCatalogId: { type: String, trim: true },
    shopifyPriceListId: { type: String, trim: true },
    shopifyPushedAt: { type: Date },
    shopifyPushError: { type: String, trim: true },
    shopifyPushedVariantIds: { type: [String], default: [] },
    // shopifySegmentId / shopifyItemDiscounts: legacy — no longer written by
    // performShopifyPush (priceList.controller.js). Wholesale pricing is now
    // enforced at checkout time from the wholesale_price metafield instead of
    // a Shopify Segment + Automatic Discount. Left in place so price lists
    // pushed before this change keep their historical values.
    shopifySegmentId: { type: String, trim: true },
    shopifyPushedCustomerIds: { type: [String], default: [] },
    shopifyItemDiscounts: { type: [shopifyItemDiscountSchema], default: [] },
    shop: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

priceListSchema.index(
  { shop: 1, handle: 1 },
  { unique: true, partialFilterExpression: { handle: { $exists: true } } }
);

module.exports = mongoose.model("PriceList", priceListSchema);
