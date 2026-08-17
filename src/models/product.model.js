const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, unique: true, trim: true },
    msrp: { type: Number, required: true, min: 0 },
    shopifyProductId: { type: String, trim: true },
    shopifyVariantId: { type: String, trim: true, unique: true, sparse: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Product", productSchema);
