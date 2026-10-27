const mongoose = require("mongoose");

// A rule for routing exceptions to approvers (spec §4.1 "Approval policies":
// rule priority, metric, threshold, approver chain, SLA, self-approval).
// Rules are ordered by `priority`; the first one that fits an exception
// decides it, and a `deny` rule refuses it outright (spec §8.4 "first explicit
// deny wins"). Each change bumps `version`.
const approvalPolicySchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    // One override type, or "ANY".
    overrideType: { type: String, default: "ANY" },
    // Lower numbers are checked first.
    priority: { type: Number, default: 100 },
    // "route" sends it for approval; "deny" refuses it.
    effect: { type: String, enum: ["route", "deny"], default: "route" },
    // The rule fits exceptions up to this many percent below the baseline
    // (null: any size).
    maxDeltaPercent: { type: Number, default: null, min: 0 },
    // Roles whose holders may approve (empty: anyone allowed to approve whose
    // own limit covers it).
    approverRoles: { type: [String], default: [] },
    slaHours: { type: Number, default: 24, min: 1 },
    // Whether an agent may approve their own exception, and up to what size.
    selfApprovalAllowed: { type: Boolean, default: false },
    selfApprovalMaxPercent: { type: Number, default: null, min: 0 },
    // Approving something larger than this needs a written comment (rejecting
    // always does).
    commentRequiredAbovePercent: { type: Number, default: null, min: 0 },
    active: { type: Boolean, default: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

approvalPolicySchema.index({ shop: 1, active: 1, priority: 1 });

module.exports = mongoose.model("ApprovalPolicy", approvalPolicySchema);
