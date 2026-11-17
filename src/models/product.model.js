const mongoose = require("mongoose");

const productOptionSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    value: { type: String, trim: true, required: true },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, trim: true },
    msrp: { type: Number, required: true, min: 0 },
    shopifyProductId: { type: String, trim: true },
    shopifyVariantId: { type: String, trim: true },
    productTitle: { type: String, trim: true },
    productHandle: { type: String, trim: true },
    variantTitle: { type: String, trim: true },
    image: { type: String, trim: true, default: null },
    options: { type: [productOptionSchema], default: [] },
    shop: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

// Not unique: Shopify assigns the same placeholder SKU (e.g. "sku-untracked-1")
// to multiple untracked-inventory variants — shopifyVariantId below is the
// real identity key for upserts/dedup.
productSchema.index({ shop: 1, sku: 1 });
productSchema.index(
  { shop: 1, shopifyVariantId: 1 },
  { unique: true, partialFilterExpression: { shopifyVariantId: { $exists: true } } }
);

module.exports = mongoose.model("Product", productSchema);
