const mongoose = require("mongoose");

const addressSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    company: { type: String, trim: true },
    address1: { type: String, required: true, trim: true },
    address2: { type: String, trim: true },
    city: { type: String, required: true, trim: true },
    zip: { type: String, required: true, trim: true },
    country: { type: String, required: true, trim: true },
    province: { type: String, trim: true },
    phone: { type: String, trim: true },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    company: { type: String, trim: true },
    tags: { type: [String], default: [] },
    role: {
      type: String,
      enum: ["customer", "sales_agent", "sales_admin", "external_sales_rep"],
      default: "customer",
    },
    priceList: { type: mongoose.Schema.Types.ObjectId, ref: "PriceList", default: null },
    customerGroup: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerGroup", default: null },
    // Mirrors SparkLayer's `sparklayer.payment_on_account` customer metafield
    // ({ credit_limit, balance }) — null limit means "no credit limit set".
    creditLimit: { type: Number, default: null, min: 0 },
    creditBalance: { type: Number, default: 0, min: 0 },
    shopifyCustomerId: { type: String, trim: true },
    shopifyCompanyId: { type: String, trim: true },
    shopifyCompanyLocationId: { type: String, trim: true },
    shopifyCompanyName: { type: String, trim: true },
    addresses: { type: [addressSchema], default: [] },
    shop: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

customerSchema.index({ shop: 1, email: 1 }, { unique: true });
customerSchema.index(
  { shop: 1, shopifyCustomerId: 1 },
  { unique: true, partialFilterExpression: { shopifyCustomerId: { $exists: true } } }
);

module.exports = mongoose.model("Customer", customerSchema);
