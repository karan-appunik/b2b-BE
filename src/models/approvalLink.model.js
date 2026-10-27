const mongoose = require("mongoose");

// A link emailed to one approver for one exception (spec §8.4: "Approval links
// expire, are single-use, and require authenticated access"). Only a hash of
// the secret is kept. Using the link to decide uses it up; it also dies when
// it expires or the request is decided some other way.
const approvalLinkSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    request: { type: mongoose.Schema.Types.ObjectId, ref: "OverrideRequest", required: true, index: true },
    // The only person who may use it, and only while signed in as themselves.
    approver: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ApprovalLink", approvalLinkSchema);
