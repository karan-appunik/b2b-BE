const mongoose = require("mongoose");

// Append-only evidence of who did what for which customer (spec §10.1).
// Rows can be created and read but never changed or removed — the hooks
// below reject every update/delete path Mongoose exposes.
const auditEventSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    occurredAt: { type: Date, required: true, default: Date.now },
    // Who performed the action: a sales agent (a Customer record) or a
    // merchant-panel user. `actorShopifyCustomerId` is kept even when the
    // agent couldn't be resolved, so denied attempts are still traceable.
    actorType: { type: String, enum: ["sales_agent", "merchant_user", "buyer", "system"], required: true },
    actor: { type: mongoose.Schema.Types.ObjectId },
    actorShopifyCustomerId: { type: String },
    // The customer being represented, when there is one.
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    contextId: { type: mongoose.Schema.Types.ObjectId, ref: "ContextSession" },
    action: { type: String, required: true },
    outcome: { type: String, enum: ["success", "denied", "failure"], default: "success" },
    reasonCode: { type: String },
    objectType: { type: String },
    objectId: { type: String },
    // Small, allow-listed facts only — never secrets, tokens or payment data.
    metadata: { type: mongoose.Schema.Types.Mixed },
    // Hash chain (per shop): this row's hash covers its own content plus the
    // previous row's hash, so any later change or deletion is detectable.
    prevHash: { type: String },
    hash: { type: String },
  },
  { timestamps: false, versionKey: false }
);

auditEventSchema.index({ shop: 1, occurredAt: -1 });
auditEventSchema.index({ shop: 1, actor: 1, occurredAt: -1 });
auditEventSchema.index({ shop: 1, customer: 1, occurredAt: -1 });
auditEventSchema.index({ shop: 1, action: 1, occurredAt: -1 });

function rejectChange(next) {
  next(new Error("Audit events are append-only"));
}

[
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
].forEach((op) => auditEventSchema.pre(op, rejectChange));

auditEventSchema.pre("save", function (next) {
  if (!this.isNew) return rejectChange(next);
  next();
});

module.exports = mongoose.model("AuditEvent", auditEventSchema);
