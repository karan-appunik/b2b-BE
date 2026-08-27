const mongoose = require("mongoose");

const paymentMethodsSchema = new mongoose.Schema(
  {
    invoice: { type: Boolean, default: false },
    onAccount: { type: Boolean, default: false },
    cardAtCheckout: { type: Boolean, default: false },
    requestForQuote: { type: Boolean, default: false },
  },
  { _id: false }
);

const totalLimitSchema = new mongoose.Schema(
  {
    currency: { type: String, required: true, trim: true, uppercase: true },
    min: { type: Number, default: null, min: 0 },
    max: { type: Number, default: null, min: 0 },
  },
  { _id: false }
);

const orderLimitsSchema = new mongoose.Schema(
  {
    // null means "no limit" — there's no separate enabled flag.
    quantity: {
      min: { type: Number, default: null, min: 0 },
      max: { type: Number, default: null, min: 0 },
    },
    // One row per currency — a store selling in multiple currencies needs a
    // separate min/max per currency rather than one amount that's wrong for
    // every currency but one.
    total: { type: [totalLimitSchema], default: [] },
  },
  { _id: false }
);

const stockDisplaySchema = new mongoose.Schema(
  {
    showAvailability: { type: Boolean, default: true },
    hidePreOrder: { type: Boolean, default: false },
    showUnitsOfStock: { type: Boolean, default: false },
    max: { type: Number, default: 9999, min: 0 },
    low: { type: Number, default: 20, min: 0 },
    last: { type: Number, default: 5, min: 0 },
  },
  { _id: false }
);

const addressManagementSchema = new mongoose.Schema(
  {
    allowAddressEditing: { type: Boolean, default: true },
    allowBillingAddress: { type: Boolean, default: true },
  },
  { _id: false }
);

const creditSettingsSchema = new mongoose.Schema(
  {
    preventOrderIfExceeded: { type: Boolean, default: false },
  },
  { _id: false }
);

const checkoutAccessSchema = new mongoose.Schema(
  {
    disableCheckout: { type: Boolean, default: false },
  },
  { _id: false }
);

const customerGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    handle: { type: String, required: true, trim: true, lowercase: true },
    isBase: { type: Boolean, default: false },
    shopifyTag: {
      type: String,
      trim: true,
      required: function () {
        return !this.isBase;
      },
    },
    // Ordered — for a product carried on more than one list, the first list
    // in this array wins (see docs.sparklayer.io/customers).
    priceLists: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "PriceList" }], default: [] },
    // null means "inherit from the base group" for non-base groups.
    paymentMethods: { type: paymentMethodsSchema, default: null },
    orderLimits: { type: orderLimitsSchema, default: null },
    stockDisplay: { type: stockDisplaySchema, default: null },
    addressManagement: { type: addressManagementSchema, default: null },
    creditSettings: { type: creditSettingsSchema, default: null },
    checkoutAccess: { type: checkoutAccessSchema, default: null },
    shop: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

customerGroupSchema.index(
  { shop: 1, isBase: 1 },
  { unique: true, partialFilterExpression: { isBase: true } }
);
customerGroupSchema.index({ shop: 1, handle: 1 }, { unique: true });

module.exports = mongoose.model("CustomerGroup", customerGroupSchema);
