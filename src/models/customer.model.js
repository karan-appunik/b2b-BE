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
    priceList: { type: mongoose.Schema.Types.ObjectId, ref: "PriceList", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Customer", customerSchema);
