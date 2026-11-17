const mongoose = require("mongoose");

// An account an agent keeps at the top of their dashboard (spec §4.2 "pinned
// accounts"). Pinning gives no access: the account must still be one the agent
// may act for, and it is checked every time the list is shown.
const agentPinSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
  },
  { timestamps: true }
);

agentPinSchema.index({ shop: 1, agent: 1, customer: 1 }, { unique: true });

module.exports = mongoose.model("AgentPin", agentPinSchema);
