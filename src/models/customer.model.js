const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
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
    shopifyCustomerId: { type: String, trim: true, unique: true, sparse: true },
    shopifyCompanyId: { type: String, trim: true },
    shopifyCompanyLocationId: { type: String, trim: true },
    shopifyCompanyName: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Customer", customerSchema);
