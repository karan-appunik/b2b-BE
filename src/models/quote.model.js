const mongoose = require("mongoose");

// A quote for one customer, owned by the sales agent who made it (spec §6.2
// `quotes`, §9.2). The quote itself is the shell — its status, owner and
// dates; what is quoted lives in immutable QuoteVersion records. Sending,
// approving or accepting a version locks it, and a change after that is a new
// version, never an edit.
const STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "SENT",
  "ACCEPTED",
  "DECLINED",
  "CHANGES_REQUESTED",
  "EXPIRED",
  "WITHDRAWN",
  "CONVERTED",
];

// Which status a quote may move to from each status (spec §9.2). Anything not
// listed is refused.
const TRANSITIONS = {
  DRAFT: ["PENDING_APPROVAL", "SENT", "WITHDRAWN"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "WITHDRAWN"],
  APPROVED: ["SENT", "WITHDRAWN", "DRAFT"],
  SENT: ["ACCEPTED", "DECLINED", "CHANGES_REQUESTED", "EXPIRED", "WITHDRAWN"],
  CHANGES_REQUESTED: ["DRAFT", "WITHDRAWN"],
  ACCEPTED: ["CONVERTED", "EXPIRED"],
  DECLINED: ["DRAFT"],
  EXPIRED: ["DRAFT"],
  REJECTED: ["DRAFT"],
  CONVERTED: [],
  WITHDRAWN: [],
};

const activitySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    type: { type: String, required: true },
    // Who did it: an agent, the buyer, a merchant-panel user, or the system.
    byKind: { type: String, enum: ["agent", "buyer", "merchant_user", "system"], default: "system" },
    by: { type: mongoose.Schema.Types.ObjectId },
    byName: { type: String },
    version: { type: Number },
    comment: { type: String },
  },
  { _id: false }
);

const quoteSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    // Human-readable number, e.g. Q-0042.
    number: { type: String, required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    ownerAgent: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    status: { type: String, enum: STATUSES, default: "DRAFT", index: true },
    currentVersion: { type: Number, default: 1 },
    // NONE: not needed or not asked yet.
    approvalState: { type: String, enum: ["NONE", "PENDING", "APPROVED", "REJECTED"], default: "NONE" },
    // When a sent quote stops being acceptable.
    expiresAt: { type: Date },
    sentAt: { type: Date },
    acceptedAt: { type: Date },
    // After acceptance, how long the agent has to turn it into an order.
    convertBy: { type: Date },
    convertedOrderId: { type: String },
    activity: { type: [activitySchema], default: [] },
  },
  { timestamps: true }
);

quoteSchema.index({ shop: 1, number: 1 }, { unique: true });
quoteSchema.index({ shop: 1, ownerAgent: 1, updatedAt: -1 });
quoteSchema.index({ shop: 1, customer: 1, status: 1 });

module.exports = mongoose.model("Quote", quoteSchema);
module.exports.STATUSES = STATUSES;
module.exports.TRANSITIONS = TRANSITIONS;
