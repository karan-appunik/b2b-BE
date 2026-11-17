const mongoose = require("mongoose");

// A server-side "acting for customer" session (spec §5). It is an
// authorization claim, not a login: the agent stays the authenticated actor
// and this record only says which customer they currently represent. Rows
// are never deleted — they double as evidence of who acted for whom.
const contextSessionSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    channel: { type: String, default: "b2b_web", trim: true },
    // The customer's legal entity when the context was issued (spec §5.1).
    legalEntity: { type: String, trim: true },
    issuedAt: { type: Date, required: true },
    // Last time the agent used it, for the idle limit.
    lastActivityAt: { type: Date },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    // EXIT | SWITCHED | ACCESS_LOST | AGENT_DISABLED
    revokedReason: { type: String, default: null },
    // Why access was granted at the time, kept for later audit.
    authzSnapshot: {
      source: { type: String },
      agentRole: { type: String },
      // What the access looked like when the context was issued or last
      // refreshed. If it has changed since, the context is STALE (spec §5.2).
      roleVersion: { type: Number },
      grantsHash: { type: String },
      policyStamp: { type: String },
      refreshedAt: { type: Date },
      clientIp: { type: String },
      userAgent: { type: String },
    },
  },
  { timestamps: true }
);

contextSessionSchema.index({ shop: 1, agent: 1, revokedAt: 1, expiresAt: 1 });

module.exports = mongoose.model("ContextSession", contextSessionSchema);
