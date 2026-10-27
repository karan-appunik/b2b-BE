const mongoose = require("mongoose");

// Phase 4: delegation and temporary access (spec §8.4 "escalation and
// delegation preserve the original chain and audit history", §2.4 "time-bound
// grants"). One row lets `delegate` decide approvals with the authority of
// `delegator` for a fixed period, and optionally cover the delegator's
// customers. The delegator's own authority is untouched; every decision made
// through a delegation names both people.
const approvalDelegationSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    delegator: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    delegate: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    reason: { type: String, trim: true, maxlength: 300 },
    // Also lets the delegate work for the customers the delegator was given
    // by name, group or territory (temporary access).
    coverAccess: { type: Boolean, default: false },
    // Whether quote approvals are included (exceptions always are).
    includeQuotes: { type: Boolean, default: true },
    status: { type: String, enum: ["ACTIVE", "REVOKED"], default: "ACTIVE" },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, trim: true, maxlength: 200 },
    createdBy: {
      kind: { type: String, enum: ["merchant_user", "agent"] },
      id: { type: mongoose.Schema.Types.ObjectId },
    },
    useCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

approvalDelegationSchema.index({ shop: 1, delegate: 1, status: 1, endsAt: 1 });
approvalDelegationSchema.index({ shop: 1, delegator: 1, status: 1 });

module.exports = mongoose.model("ApprovalDelegation", approvalDelegationSchema);
