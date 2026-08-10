const mongoose = require("mongoose");

const priceListItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    price: { type: Number, required: true, min: 0 },
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
  },
  { timestamps: true }
);

module.exports = mongoose.model("PriceList", priceListSchema);
