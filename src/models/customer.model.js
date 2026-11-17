const mongoose = require("mongoose");

const addressSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    company: { type: String, trim: true },
    address1: { type: String, required: true, trim: true },
    address2: { type: String, trim: true },
    city: { type: String, required: true, trim: true },
    zip: { type: String, required: true, trim: true },
    country: { type: String, required: true, trim: true },
    province: { type: String, trim: true },
    phone: { type: String, trim: true },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    company: { type: String, trim: true },
    tags: { type: [String], default: [] },
    // "customer", or the key of a Role (built-in sales roles or a custom one).
    role: { type: String, default: "customer", trim: true },
    priceList: { type: mongoose.Schema.Types.ObjectId, ref: "PriceList", default: null },
    customerGroup: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerGroup", default: null },
    // Authenticator-app (TOTP) second factor for sales agents. The secret is
    // stored encrypted and never returned by default.
    mfa: {
      enabled: { type: Boolean, default: false },
      secretEnc: { type: String, select: false },
      lastUsedStep: { type: Number },
      failedCount: { type: Number },
      lockedUntil: { type: Date },
      verifiedUntil: { type: Date },
      stepUpUntil: { type: Date },
      enrolledAt: { type: Date },
      // When an unconfirmed secret was handed out, so a page reload or a second
      // click within a few minutes shows the same key instead of a new one.
      enrollStartedAt: { type: Date },
    },
    // Sales territory this account belongs to — lets agents be granted access
    // to every customer in a territory (see AgentScopeGrant).
    territory: { type: String, trim: true, default: null },
    // "rule" when a territory rule put them there; absent when it was set by
    // hand (which rules never overwrite).
    territorySource: { type: String, enum: ["rule"] },
    // Where their default address is, for territory rules.
    region: {
      countryCode: { type: String, trim: true, uppercase: true },
      provinceCode: { type: String, trim: true, uppercase: true },
      zip: { type: String, trim: true },
    },
    // Made by a sales agent at a trade event and not yet approved by the
    // merchant (spec §3.4). Ordering for it can be held by a setting.
    provisional: { type: Boolean, default: false },
    // A suspended or merged account can't be ordered for (spec §5.3 step 3);
    // contexts already open for it end (spec §12).
    accountStatus: { type: String, enum: ["active", "suspended", "merged"], default: "active" },
    // For a merged account: the account that took its place.
    mergedInto: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    // What the team knows about this customer. Internal only: it is never sent
    // to the customer, and agents see it only with customer.notes.read.
    internalNotes: { type: String, trim: true, maxlength: 2000 },
    // For a sales agent (spec §4.1): their manager, the dates they may work
    // between, and their language.
    agentProfile: {
      managerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
      validFrom: { type: Date },
      validTo: { type: Date },
      locale: { type: String, trim: true },
      // The legal entities this agent may sell for. Empty means all of them.
      legalEntities: { type: [String], default: undefined },
      // When they last passed the sign-in check.
      lastLoginAt: { type: Date },
    },
    // The sales channels this account may be ordered through. Empty means all.
    allowedChannels: { type: [String], default: undefined },
    createdByAgent: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    approvedAt: { type: Date },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    phone: { type: String, trim: true },
    // Last 9 digits of the phone, so +1 (555) 010-2000 and 555-010-2000 match.
    phoneKey: { type: String, index: true },
    taxId: { type: String, trim: true },
    legalEntity: { type: String, trim: true },
    // The customer's account number in the merchant's own systems (spec §5.1
    // "customer code"). Shown in the Agent Mode banner and searchable.
    accountCode: { type: String, trim: true },
    // Set when the person's data was erased on request (spec §11.2); orders and
    // the audit trail that refer to them are kept.
    erasedAt: { type: Date },
    consent: {
      dataProcessing: { type: Boolean },
      marketing: { type: Boolean },
      at: { type: Date },
    },
    // Mirrors SparkLayer's `sparklayer.payment_on_account` customer metafield
    // ({ credit_limit, balance }) — null limit means "no credit limit set".
    creditLimit: { type: Number, default: null, min: 0 },
    creditBalance: { type: Number, default: 0, min: 0 },
    shopifyCustomerId: { type: String, trim: true },
    shopifyCompanyId: { type: String, trim: true },
    shopifyCompanyLocationId: { type: String, trim: true },
    shopifyCompanyName: { type: String, trim: true },
    addresses: { type: [addressSchema], default: [] },
    shop: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

// Not unique: Shopify itself doesn't guarantee one email per customer record
// — a company contact can be a separate Customer sharing its parent's email.
// shopifyCustomerId below is the real identity key for upserts/dedup.
customerSchema.index({ shop: 1, email: 1 });
// What the agent screens and access rules filter on.
customerSchema.index({ shop: 1, role: 1 });
customerSchema.index({ shop: 1, territory: 1 });
customerSchema.index({ shop: 1, customerGroup: 1 });
customerSchema.index({ shop: 1, createdAt: -1 });

customerSchema.pre("validate", function () {
  const digits = String(this.phone || "").replace(/\D/g, "");
  this.phoneKey = digits.length >= 7 ? digits.slice(-9) : undefined;
});
customerSchema.index(
  { shop: 1, shopifyCustomerId: 1 },
  { unique: true, partialFilterExpression: { shopifyCustomerId: { $exists: true } } }
);

module.exports = mongoose.model("Customer", customerSchema);
