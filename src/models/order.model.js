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
    // Set only for orders placed by a sales agent on a customer's behalf, so
    // the customer (shopifyCustomerId) stays the owner while the agent stays
    // on record as the actor (spec §9.3). Unset for self-service orders.
    source: { type: String, enum: ["sales_agent"] },
    placedByAgent: {
      agent: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
      context: { type: mongoose.Schema.Types.ObjectId, ref: "ContextSession" },
      // The exceptions (and so the approvals) this order used, and the quote
      // it came from (spec §9.3, AC10).
      overrides: [{ type: mongoose.Schema.Types.ObjectId, ref: "OverrideRequest" }],
      quote: { type: mongoose.Schema.Types.ObjectId, ref: "Quote" },
    },
    // The buyer's purchase order number and the delivery date they asked for.
    poNumber: { type: String, trim: true },
    requestedDeliveryDate: { type: String, trim: true },
    // What the agent wrote for the team about this order (spec §11.2). It is
    // never shown to the customer; the note the customer can read is the
    // order's own note on Shopify.
    internalNote: { type: String, trim: true, maxlength: 500 },
    shop: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

orderSchema.index({ shop: 1, shopifyOrderId: 1 }, { unique: true });
orderSchema.index({ shop: 1, orderedAt: -1 });
orderSchema.index({ shop: 1, "placedByAgent.agent": 1, orderedAt: -1 });

module.exports = mongoose.model("Order", orderSchema);
