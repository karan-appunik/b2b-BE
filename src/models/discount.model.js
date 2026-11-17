const mongoose = require("mongoose");

// docs.sparklayer.io/discounts "Advanced Requirements": the cart must
// contain at least one line whose product SKU/tag/vendor matches this rule,
// or the discount doesn't apply — independent of the reward it grants.
const productRequirementSchema = new mongoose.Schema(
  {
    attribute: { type: String, enum: ["sku", "tag", "vendor"], required: true },
    operator: { type: String, enum: ["equals", "contains"], required: true, default: "equals" },
    value: { type: String, required: true, trim: true },
  },
  { _id: false }
);

// docs.sparklayer.io/discounts "Advanced Requirements and Rewards" — a single
// SKU/tag/vendor condition, identical shape to productRequirementSchema
// above but reused as an array element inside requirementGroups (see below)
// rather than a single standalone requirement.
const requirementConditionSchema = new mongoose.Schema(
  {
    attribute: { type: String, enum: ["sku", "tag", "vendor"], required: true },
    operator: { type: String, enum: ["equals", "contains"], required: true, default: "equals" },
    value: { type: String, required: true, trim: true },
  },
  { _id: false }
);

// docs.sparklayer.io/discounts "Advanced Requirements and Rewards" — one
// reward fired when a discount's requirementGroups match. "cart_lines"
// targets specific lines via cartLineMatch (same shape as a requirement
// condition); "subtotal"/"shipping" apply against the whole order/shipping
// cost and ignore cartLineMatch. "free" valueType only makes sense for
// "shipping" (100% off), same convention as the top-level valueType field.
const rewardSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["subtotal", "shipping", "cart_lines"], required: true },
    valueType: { type: String, enum: ["percentage", "fixed", "free", "set_cost"], required: true },
    value: { type: Number, required: true, min: 0 },
    cartLineMatch: { type: requirementConditionSchema, default: null },
  },
  { _id: false }
);

// docs.sparklayer.io/discounts "Advanced Free Products" — the reward for an
// appliesTo: "free_product" discount. Resolved and cached from the Product
// collection at create/update time (see discount.controller.js) so checkout
// never needs an extra lookup, and so the merchant panel can display the
// product without re-fetching it.
const freeProductSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    shopifyVariantId: { type: String, required: true, trim: true },
    title: { type: String, trim: true },
    variantTitle: { type: String, trim: true },
    sku: { type: String, trim: true },
    image: { type: String, trim: true, default: null },
    quantity: { type: Number, default: 1, min: 1 },
    // docs.sparklayer.io/discounts "Recursive Free Products" — every time the
    // cart's eligible item count (same count itemQuantityMethod already
    // computes for min/maxItemQuantity) reaches another multiple of this
    // number, `quantity` is awarded again — see resolveFreeProductAward in
    // discountLookup.server.ts. null = fixed quantity, no scaling.
    perQuantity: { type: Number, default: null, min: 1 },
  },
  { _id: false }
);

// docs.sparklayer.io/discounts "Advanced Free Products" — one entry per
// requirementGroups index (freeProductGroups[i] is this discount's reward
// for requirementGroups[i] matching); only read when mode ===
// "advanced_free_product". Unlike the single-product simple free_product
// reward above, a group can award several different products together
// (BOGO-style), each with its own quantity/perQuantity.
const freeProductGroupSchema = new mongoose.Schema(
  {
    products: { type: [freeProductSchema], default: [] },
    // "once" ignores every product's own perQuantity and awards its base
    // quantity a single time per order; "recursive" awards each product
    // repeatedly per its own perQuantity with no cap; "limited" is the same
    // as recursive but capped at limitedMaxTimes repetitions.
    application: { type: String, enum: ["once", "recursive", "limited"], default: "once" },
    limitedMaxTimes: { type: Number, default: null, min: 1 },
  },
  { _id: false }
);

const discountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    handle: { type: String, trim: true, lowercase: true },
    publicName: { type: String, trim: true, default: "" },
    // docs.sparklayer.io/discounts "Summary" — an optional internal note
    // about the discount, shown only in the merchant panel (never to
    // customers, unlike publicName).
    description: { type: String, trim: true, default: "" },
    status: { type: String, enum: ["active", "draft"], default: "draft" },
    // docs.sparklayer.io/discounts "Discount Priorities" — merchant-ordered
    // via drag-and-drop in the "Manage priorities" list (lower number =
    // applied first). A newly created or duplicated discount jumps to the
    // front (see topPriority in discount.controller.js); resolveDiscount in
    // discountLookup.server.ts is what actually reads this.
    priority: { type: Number, default: 0 },
    method: { type: String, enum: ["automatic", "coupon"], required: true, default: "automatic" },
    // docs.sparklayer.io/discounts "Coupon codes" — a discount can have
    // several codes saved against it (e.g. the same promotion run under
    // different codes per marketing channel); any of them applies this same
    // discount. Stored uppercase, same as before.
    couponCodes: {
      type: [{ type: String, trim: true, uppercase: true }],
      default: [],
    },
    // What the reward does — reduces the order subtotal, reduces the
    // shipping cost, gives away a free product, or reduces specific line
    // items by SKU (docs.sparklayer.io/discounts "Shipping" / "Advanced Free
    // Products" / "Give a Percentage Off Products"). "free" valueType is
    // only valid for shipping (100% off shipping); free_product ignores
    // valueType/value entirely (its reward lives in freeProduct below);
    // line_item is always "percentage" (the docs don't offer a fixed-amount
    // option for this reward type).
    appliesTo: { type: String, enum: ["order", "shipping", "free_product", "line_item"], required: true, default: "order" },
    valueType: { type: String, enum: ["percentage", "fixed", "free", "set_cost"], required: true, default: "percentage" },
    value: { type: Number, required: true, min: 0 },
    // Required when appliesTo === "free_product"; null otherwise.
    freeProduct: { type: freeProductSchema, default: null },
    // Required when appliesTo === "line_item" (max 25 per
    // docs.sparklayer.io/discounts "Give a Percentage Off Products");
    // empty otherwise. Matched against cart line SKUs directly — no Product
    // lookup needed since, unlike freeProduct, nothing needs to be added to
    // the order, just discounted.
    lineItemSkus: { type: [{ type: String, trim: true }], default: [] },
    currency: { type: String, trim: true, uppercase: true, default: "USD" },
    minSubtotal: { type: Number, default: null, min: 0 },
    maxSubtotal: { type: Number, default: null, min: 0 },
    // "total" counts every unit across all lines (e.g. 3 of SKU-A + 2 of
    // SKU-B = 5); "unique" counts distinct line items instead (= 2) —
    // docs.sparklayer.io/discounts "Order Item Limits".
    itemQuantityMethod: { type: String, enum: ["total", "unique"], default: "total" },
    minItemQuantity: { type: Number, default: null, min: 0 },
    maxItemQuantity: { type: Number, default: null, min: 0 },
    // null = no product restriction (applies regardless of cart contents).
    productRequirement: { type: productRequirementSchema, default: null },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    // Empty array = every customer group is eligible (no restriction).
    customerGroupIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "CustomerGroup" }], default: [] },
    // null = unlimited uses per customer.
    usageLimitPerCustomer: { type: Number, default: null, min: 1 },
    // Emails or Shopify customer ids blocked from this discount regardless of
    // group/eligibility — docs.sparklayer.io/discounts "Exclude customers".
    // Stored lowercase/trimmed so lookups are a plain membership check.
    excludedCustomerIdentifiers: { type: [{ type: String, trim: true, lowercase: true }], default: [] },
    // docs.sparklayer.io/discounts "Compatible discounts" — per the docs,
    // "when you create a discount it will be able to be used in conjunction
    // with all other discounts by default." This flag is purely whether the
    // merchant opted into restricting that (i.e. whether the whitelist panel
    // below is shown) — it has no effect on stacking by itself, since an
    // empty compatibleDiscountIds already means "compatible with everyone."
    compatibleWithOthers: { type: Boolean, default: false },
    // Empty = combine with any other discount that's also willing to
    // combine with this one (the real default per the docs). Non-empty = a
    // whitelist: this discount only joins a stack alongside the specific
    // discounts listed here ("select the discounts that you wish to be
    // compatible... if none are selected all discounts may be used").
    // Checked mutually — see isMutuallyCompatible in discountLookup.server.ts.
    compatibleDiscountIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Discount" }], default: [] },
    // docs.sparklayer.io/discounts "Advanced Requirements and Rewards" /
    // "Advanced Free Products" — two parallel modes alongside the simple
    // appliesTo-driven reward above. "simple" (default) is every discount
    // created via the four basic Type options and ignores requirementGroups/
    // rewards/rewardApplication/freeProductGroups entirely; "advanced"
    // ignores appliesTo/valueType/value/productRequirement/lineItemSkus/
    // freeProduct/freeProductGroups instead, since those only make sense for
    // a single reward/single requirement shape; "advanced_free_product" is
    // the same but reads requirementGroups + freeProductGroups instead of
    // rewards/rewardApplication.
    mode: { type: String, enum: ["simple", "advanced", "advanced_free_product"], default: "simple" },
    // Outer array = OR, inner array = AND — e.g. [[condA, condB], [condC]]
    // means "(condA AND condB) OR (condC)". Only read when mode === "advanced"
    // or "advanced_free_product" (shared between both — see freeProductGroups
    // below for how the latter pairs each group with its own reward).
    requirementGroups: { type: [[requirementConditionSchema]], default: [] },
    // Every reward that fires together when requirementGroups match, subject
    // to rewardApplication below. Only read when mode === "advanced".
    rewards: { type: [rewardSchema], default: [] },
    // "all" fires every entry in rewards; "highest"/"lowest" fire only the
    // single reward with the largest/smallest computed discount amount at
    // checkout time (see selectRewards in discountLookup.server.ts).
    rewardApplication: { type: String, enum: ["all", "highest", "lowest"], default: "all" },
    // docs.sparklayer.io/discounts "Advanced Free Products" — parallel array
    // to requirementGroups (index i's free products fire when
    // requirementGroups[i] matches). Only read when mode ===
    // "advanced_free_product" — see resolveAdvancedFreeProductGroups in
    // discountLookup.server.ts.
    freeProductGroups: { type: [freeProductGroupSchema], default: [] },
    shop: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

// Multikey unique index — the partial filter is required because MongoDB
// indexes an empty array as a single `undefined` entry rather than no entry
// at all, so without it every automatic discount (empty couponCodes) would
// collide with every other one. With the filter, only discounts that
// actually have at least one code participate, and two coupon-method
// discounts under one shop conflict only if any single code appears in
// both of their lists.
discountSchema.index(
  { shop: 1, couponCodes: 1 },
  { unique: true, partialFilterExpression: { "couponCodes.0": { $exists: true } } }
);

// Mirrors priceListSchema's { shop, handle } index — handle is optional, so
// only documents that actually have one participate in the uniqueness check.
discountSchema.index(
  { shop: 1, handle: 1 },
  { unique: true, partialFilterExpression: { handle: { $exists: true } } }
);

module.exports = mongoose.model("Discount", discountSchema);
