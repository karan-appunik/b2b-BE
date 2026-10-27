const mongoose = require("mongoose");

// A temporary permission given to one agent on top of their role (spec §2.4:
// "High-risk permissions should support time-bound grants"). It always has an
// end date, and it can be revoked early; the record stays as evidence.
const permissionGrantSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    permission: { type: String, required: true, trim: true },
    // Optional limits, same shape as on a role (e.g. { maxDeltaPercent: 10 }).
    constraints: { type: mongoose.Schema.Types.Mixed, default: undefined },
    reason: { type: String, required: true, trim: true },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

permissionGrantSchema.index({ shop: 1, agent: 1, permission: 1 });

module.exports = mongoose.model("PermissionGrant", permissionGrantSchema);
