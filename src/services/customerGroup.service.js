const CustomerGroup = require("../models/customerGroup.model");
const Customer = require("../models/customer.model");
const PriceList = require("../models/priceList.model");
const { autoSyncToShopify } = require("../controllers/priceList.controller");

const DEFAULT_PAYMENT_METHODS = { invoice: false, onAccount: false, cardAtCheckout: false };
const DEFAULT_ORDER_LIMITS = {
  valueBased: { enabled: false, minValue: 0 },
  unitBased: { enabled: false, minUnits: 0 },
};

async function ensureBaseGroup(shop) {
  let base = await CustomerGroup.findOne({ isBase: true, shop });
  if (!base) {
    base = await CustomerGroup.create({
      name: "Base customer group",
      isBase: true,
      shopifyTag: undefined,
      paymentMethods: DEFAULT_PAYMENT_METHODS,
      orderLimits: DEFAULT_ORDER_LIMITS,
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
    const targetPriceList = targetGroup.priceList || base.priceList || null;
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
