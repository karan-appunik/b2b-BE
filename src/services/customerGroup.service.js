const CustomerGroup = require("../models/customerGroup.model");
const Customer = require("../models/customer.model");
const PriceList = require("../models/priceList.model");
const { autoSyncToShopify } = require("../controllers/priceList.controller");

const DEFAULT_PAYMENT_METHODS = {
  invoice: false,
  onAccount: false,
  cardAtCheckout: false,
  requestForQuote: false,
};
const DEFAULT_ORDER_LIMITS = {
  quantity: { min: null, max: null },
  total: [],
};
const DEFAULT_STOCK_DISPLAY = {
  showAvailability: true,
  hidePreOrder: false,
  showUnitsOfStock: false,
  max: 9999,
  low: 20,
  last: 5,
};
const DEFAULT_ADDRESS_MANAGEMENT = {
  allowAddressEditing: true,
  allowBillingAddress: true,
};
const DEFAULT_CREDIT_SETTINGS = {
  preventOrderIfExceeded: false,
};
const DEFAULT_CHECKOUT_ACCESS = {
  disableCheckout: false,
};

async function ensureBaseGroup(shop) {
  let base = await CustomerGroup.findOne({ isBase: true, shop });
  if (!base) {
    base = await CustomerGroup.create({
      name: "Base customer group",
      handle: "base",
      isBase: true,
      shopifyTag: undefined,
      priceLists: [],
      paymentMethods: DEFAULT_PAYMENT_METHODS,
      orderLimits: DEFAULT_ORDER_LIMITS,
      stockDisplay: DEFAULT_STOCK_DISPLAY,
      addressManagement: DEFAULT_ADDRESS_MANAGEMENT,
      creditSettings: DEFAULT_CREDIT_SETTINGS,
      checkoutAccess: DEFAULT_CHECKOUT_ACCESS,
      shop,
    });
  }
  return base;
}

// Recomputes group/price-list assignment for every customer in the shop from
// scratch, instead of only adding matches — a customer whose tag no longer
// matches any group's shopifyTag is unassigned (falls back to the base
// group) rather than keeping a stale assignment. Called after any customer
// sync (webhook or bulk) or whenever a group is created/edited, since either
// can change which group a customer currently belongs to.
async function applyAllGroupsToCustomers(shop) {
  const base = await ensureBaseGroup(shop);
  const groups = await CustomerGroup.find({ isBase: false, shop });
  const customers = await Customer.find({ shop });

  const touchedPriceListIds = new Set();

  for (const customer of customers) {
    const matchedGroup = groups.find((g) => customer.tags.includes(g.shopifyTag));
    const targetGroup = matchedGroup || base;
    // Only the first list in the array is synced to Shopify today — full
    // per-product layering across multiple price lists happens at checkout,
    // not in this single priceList-per-customer sync.
    const targetPriceList = targetGroup.priceLists?.[0] || base.priceLists?.[0] || null;
    const groupId = matchedGroup ? matchedGroup._id : null;

    const changed =
      String(customer.customerGroup || "") !== String(groupId || "") ||
      String(customer.priceList || "") !== String(targetPriceList || "");

    if (changed) {
      customer.customerGroup = groupId;
      customer.priceList = targetPriceList;
      await customer.save();
    }

    if (targetPriceList) touchedPriceListIds.add(String(targetPriceList));
  }

  const results = [];
  for (const priceListId of touchedPriceListIds) {
    const priceList = await PriceList.findOne({ _id: priceListId, shop });
    results.push(priceList ? await autoSyncToShopify(priceList) : { attempted: false });
  }

  return results;
}

module.exports = {
  ensureBaseGroup,
  applyAllGroupsToCustomers,
};
