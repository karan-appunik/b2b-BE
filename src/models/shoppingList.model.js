const mongoose = require("mongoose");

// A saved list of items a customer orders again and again (spec §3.2 "shopping
// list"). It belongs to the customer, so whoever is allowed to order for them
// sees the same lists. Only variant ids and quantities are trusted; the title
// and SKU are kept so the list can be read without a catalogue lookup.
const itemSchema = new mongoose.Schema(
  {
    variantId: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1, max: 9999 },
    title: { type: String, trim: true, maxlength: 200 },
    sku: { type: String, trim: true, maxlength: 64 },
  },
  { _id: false }
);

const shoppingListSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    items: { type: [itemSchema], default: [] },
    // Who made it: the customer, or an agent acting for them.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    createdByAgent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

shoppingListSchema.index({ shop: 1, customer: 1, createdAt: -1 });

module.exports = mongoose.model("ShoppingList", shoppingListSchema);
