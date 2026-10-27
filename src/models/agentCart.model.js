const mongoose = require("mongoose");

// The cart an agent is building for one customer (spec §4.6, §9.1). Kept on
// the server so it survives a browser close, a device change, or switching
// to another customer and back. One live cart per agent + customer: the
// customer always comes from a validated context, never from the request.
const cartItemSchema = new mongoose.Schema(
  {
    variantId: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const agentCartSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    currency: { type: String, trim: true, uppercase: true },
    items: { type: [cartItemSchema], default: [] },
    // Bumped on every save so two devices can't silently overwrite each other.
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

agentCartSchema.index({ shop: 1, agent: 1, customer: 1 }, { unique: true });

module.exports = mongoose.model("AgentCart", agentCartSchema);
