const mongoose = require("mongoose");

// One row per access rule for a sales agent (spec §6.2 `agent_scope_grants`).
// An agent can only act for a customer that an active "allow" grant covers
// and no active "deny" grant excludes. Agents themselves are Customer
// records with an agent `role`, so `agent` points at Customer.
const SCOPE_TYPES = ["customer", "group", "territory", "all"];
const EFFECTS = ["allow", "deny"];

const agentScopeGrantSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    scopeType: { type: String, enum: SCOPE_TYPES, required: true },
    // customer -> Customer _id, group -> CustomerGroup _id, territory ->
    // territory name, all -> null. Stored as a string so one field fits all.
    scopeId: { type: String, trim: true, default: null },
    effect: { type: String, enum: EFFECTS, default: "allow" },
    // null means "no start / no end" — the grant is open-ended on that side.
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

agentScopeGrantSchema.index({ shop: 1, agent: 1 });

module.exports = mongoose.model("AgentScopeGrant", agentScopeGrantSchema);
module.exports.SCOPE_TYPES = SCOPE_TYPES;
module.exports.EFFECTS = EFFECTS;
