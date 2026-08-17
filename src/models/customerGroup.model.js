const mongoose = require("mongoose");

const paymentMethodsSchema = new mongoose.Schema(
  {
    invoice: { type: Boolean, default: false },
    onAccount: { type: Boolean, default: false },
    cardAtCheckout: { type: Boolean, default: false },
  },
  { _id: false }
);

const orderLimitsSchema = new mongoose.Schema(
  {
    valueBased: {
      enabled: { type: Boolean, default: false },
      minValue: { type: Number, default: 0, min: 0 },
    },
    unitBased: {
      enabled: { type: Boolean, default: false },
      minUnits: { type: Number, default: 0, min: 0 },
    },
  },
  { _id: false }
);

const customerGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    isBase: { type: Boolean, default: false },
    shopifyTag: {
      type: String,
      trim: true,
      required: function () {
        return !this.isBase;
      },
    },
    priceList: { type: mongoose.Schema.Types.ObjectId, ref: "PriceList", default: null },
    // null means "inherit from the base group" for non-base groups.
    paymentMethods: { type: paymentMethodsSchema, default: null },
    orderLimits: { type: orderLimitsSchema, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CustomerGroup", customerGroupSchema);
