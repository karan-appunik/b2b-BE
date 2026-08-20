const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, trim: true },
    msrp: { type: Number, required: true, min: 0 },
    shopifyProductId: { type: String, trim: true },
    shopifyVariantId: { type: String, trim: true },
    shop: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

productSchema.index({ shop: 1, sku: 1 }, { unique: true });
productSchema.index(
  { shop: 1, shopifyVariantId: 1 },
  { unique: true, partialFilterExpression: { shopifyVariantId: { $exists: true } } }
);

module.exports = mongoose.model("Product", productSchema);
