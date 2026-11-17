const mongoose = require("mongoose");

// A person asking what we hold on them, or asking us to remove it (spec
// §11.2). The request and its outcome are kept as evidence; the data that was
// returned or removed is not.
const dataSubjectRequestSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    type: { type: String, enum: ["access", "erasure"], required: true },
    status: { type: String, enum: ["completed", "refused"], required: true },
    // LEGAL_HOLD | AGENT_ACCOUNT | ALREADY_ERASED
    refusedReason: { type: String },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // What was removed or returned, as counts only.
    summary: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DataSubjectRequest", dataSubjectRequestSchema);
