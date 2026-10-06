const mongoose = require("mongoose");

const formEntrySchema = new mongoose.Schema(
  {
    form: { type: mongoose.Schema.Types.ObjectId, ref: "Form", required: true, index: true },
    // Keyed by the field's _id (as a string) -> submitted value.
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Keyed by internal field _id -> admin-entered value. Never seen by,
    // or collected from, the customer.
    internalData: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["unread", "read"], default: "unread" },
    reviewStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    shop: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

formEntrySchema.index({ form: 1, createdAt: -1 });

module.exports = mongoose.model("FormEntry", formEntrySchema);
