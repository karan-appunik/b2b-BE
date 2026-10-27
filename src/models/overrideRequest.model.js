const mongoose = require("mongoose");

// One exception an agent asks for on a customer's order — a different unit
// price, an extra discount, a relaxed quantity rule, a shipping price or a
// custom line (spec §6.2 `override_requests`, §6.4, Appendix A.2). It keeps
// the baseline it was measured against, the reason, who decided and why.
// Money is stored in minor units (cents).
const TYPES = ["UNIT_PRICE", "ORDER_DISCOUNT", "QUANTITY_RULE", "SHIPPING_PRICE", "CUSTOM_LINE", "ADDRESS", "CREDIT_LIMIT", "ORDER_APPROVAL"];

const STATUSES = [
  "REQUESTED",
  "AUTO_APPROVED",
  "PENDING_APPROVAL",
  "DENIED",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "APPLIED",
  "INVALIDATED",
];

const moneySchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
  },
  { _id: false }
);

const decisionSchema = new mongoose.Schema(
  {
    // An agent with approval rights, or a merchant-panel user.
    kind: { type: String, enum: ["agent", "merchant_user"], required: true },
    by: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String },
    decision: { type: String, enum: ["approve", "reject"], required: true },
    comment: { type: String, trim: true },
    at: { type: Date, default: Date.now },
    // Phase 4: decided through a delegation: whose authority was used.
    onBehalfOf: { type: mongoose.Schema.Types.ObjectId },
    onBehalfOfName: { type: String },
  },
  { _id: false }
);

const overrideRequestSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    context: { type: mongoose.Schema.Types.ObjectId, ref: "ContextSession" },
    cart: { type: mongoose.Schema.Types.ObjectId, ref: "AgentCart" },

    type: { type: String, enum: TYPES, required: true },
    // The role permission this was checked against.
    permission: { type: String, required: true },

    // The cart line it applies to (unit price, quantity rule, custom line);
    // blank for order-level exceptions (discount, shipping).
    lineVariantId: { type: String },
    // The line as it was when the request was made. A later change to this
    // line makes the request stale (INVALIDATED): approvals bind to exactly
    // what was asked about (spec §8.4).
    snapshot: {
      variantId: { type: String },
      quantity: { type: Number },
      // For whole-order exceptions: a fingerprint of all the cart's lines.
      cartHash: { type: String },
    },

    baseline: { type: moneySchema, required: true },
    proposed: { type: moneySchema, required: true },
    // How far below the baseline the proposal is, in percent (positive = a
    // reduction). Null when there is no baseline to compare with.
    deltaPercent: { type: Number, default: null },

    reasonCode: { type: String, required: true },
    reasonText: { type: String, required: true, trim: true },

    // A custom line (spec §8.2): something sold that isn't in the catalogue.
    // The unit price is `proposed`; this holds what it is and how many.
    custom: {
      title: { type: String, trim: true },
      quantity: { type: Number },
      // How tax treats it, and where it is booked (spec §8.2).
      taxable: { type: Boolean },
      taxCode: { type: String, trim: true },
      accountingCode: { type: String, trim: true },
    },

    // Which quantity rule an exception relaxes: the minimum, or the pack size
    // (spec §2.2 "MOQ and increment recorded separately").
    rule: { type: String, enum: ["MOQ", "INCREMENT"] },

    // A one-off delivery address (spec §1.3 "address overrides").
    address: {
      company: { type: String, trim: true },
      address1: { type: String, trim: true },
      address2: { type: String, trim: true },
      city: { type: String, trim: true },
      provinceCode: { type: String, trim: true },
      zip: { type: String, trim: true },
      countryCode: { type: String, trim: true },
      phone: { type: String, trim: true },
    },

    status: { type: String, enum: STATUSES, default: "REQUESTED", index: true },
    // Why it was refused, when status is DENIED.
    denyReason: { type: String },

    // Version of the requester's role when it was decided, so the outcome can
    // be explained later.
    policyVersion: { type: Number },
    // How approval was routed (the matching policy, or the default route).
    route: {
      policyId: { type: mongoose.Schema.Types.ObjectId },
      policyName: { type: String },
      approverRoles: { type: [String], default: [] },
      slaHours: { type: Number },
      selfApprovalAllowed: { type: Boolean, default: false },
      selfApprovalMaxPercent: { type: Number, default: null },
      commentRequiredAbovePercent: { type: Number, default: null },
    },

    // A pending request or an approved exception lapses after this.
    expiresAt: { type: Date },
    decisions: { type: [decisionSchema], default: [] },

    // Set once the request has waited past its SLA and been escalated.
    escalatedAt: { type: Date, default: null },
    appliedAt: { type: Date },
    appliedOrderId: { type: String },
    invalidatedReason: { type: String },
  },
  { timestamps: true }
);

overrideRequestSchema.index({ shop: 1, status: 1, createdAt: -1 });
overrideRequestSchema.index({ shop: 1, agent: 1, createdAt: -1 });
overrideRequestSchema.index({ shop: 1, cart: 1, status: 1 });

module.exports = mongoose.model("OverrideRequest", overrideRequestSchema);
module.exports.TYPES = TYPES;
module.exports.STATUSES = STATUSES;
