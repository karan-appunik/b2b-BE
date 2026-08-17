const CustomerGroup = require("../models/customerGroup.model");
const Customer = require("../models/customer.model");
const PriceList = require("../models/priceList.model");
const { autoSyncToShopify } = require("../controllers/priceList.controller");

const DEFAULT_PAYMENT_METHODS = { invoice: false, onAccount: false, cardAtCheckout: false };
const DEFAULT_ORDER_LIMITS = {
  valueBased: { enabled: false, minValue: 0 },
  unitBased: { enabled: false, minUnits: 0 },
};

async function ensureBaseGroup() {
  let base = await CustomerGroup.findOne({ isBase: true });
  if (!base) {
    base = await CustomerGroup.create({
      name: "Base customer group",
      isBase: true,
      shopifyTag: undefined,
      paymentMethods: DEFAULT_PAYMENT_METHODS,
      orderLimits: DEFAULT_ORDER_LIMITS,
    });
  }
  return base;
}

async function applyGroupToMatchingCustomers(group, base) {
  const effectivePriceList = group.priceList || base.priceList || null;
  if (!effectivePriceList) return { matched: 0, shopifySync: { attempted: false } };

  // Base group only fills in customers nobody has assigned yet — a specific
  // group's own assignment always takes priority over the base default.
  const filter = group.isBase ? { priceList: null } : { tags: group.shopifyTag };
  const result = await Customer.updateMany(filter, { $set: { priceList: effectivePriceList } });

  const priceList = await PriceList.findById(effectivePriceList);
  const shopifySync = priceList ? await autoSyncToShopify(priceList) : { attempted: false };

  return { matched: result.modifiedCount, shopifySync };
}

// Re-runs tag-based group matching for every group against current customer
// tags. Called after any customer sync (webhook or bulk) so a customer newly
// tagged in Shopify gets their price list — and the matching Shopify discount
// segment — without the merchant having to re-save a customer group by hand.
async function applyAllGroupsToCustomers() {
  const base = await ensureBaseGroup();
  const groups = await CustomerGroup.find({ isBase: false });

  const results = [];
  for (const group of groups) {
    results.push(await applyGroupToMatchingCustomers(group, base));
  }
  results.push(await applyGroupToMatchingCustomers(base, base));

  return results;
}

module.exports = {
  ensureBaseGroup,
  applyGroupToMatchingCustomers,
  applyAllGroupsToCustomers,
};
