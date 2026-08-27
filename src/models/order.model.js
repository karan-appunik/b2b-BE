const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    shopifyOrderId: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    orderedAt: { type: Date, required: true },
    totalPrice: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, trim: true, uppercase: true },
    financialStatus: { type: String, trim: true },
    fulfillmentStatus: { type: String, trim: true },
    shippingAddress: { type: String, trim: true },
    customerName: { type: String, trim: true },
    customerEmail: { type: String, trim: true },
    shopifyCustomerId: { type: String, trim: true },
    shop: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

orderSchema.index({ shop: 1, shopifyOrderId: 1 }, { unique: true });
orderSchema.index({ shop: 1, orderedAt: -1 });

module.exports = mongoose.model("Order", orderSchema);
