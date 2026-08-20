const PriceList = require("../models/priceList.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");

async function replaceItems(priceListId, items, shop) {
  const productIds = items.map((item) => item.product);
  const foundCount = await Product.countDocuments({ _id: { $in: productIds }, shop });

  if (foundCount !== new Set(productIds.map(String)).size) {
    const err = new Error("One or more products do not exist");
    err.statusCode = 400;
    throw err;
  }

  const priceList = await PriceList.findOneAndUpdate(
    { _id: priceListId, shop },
    { items },
    { new: true, runValidators: true }
  ).populate("items.product", "name sku msrp");

  return priceList;
}

async function assignCustomers(priceListId, customerIds, shop) {
  await Customer.updateMany(
    { shop, priceList: priceListId, _id: { $nin: customerIds } },
    { priceList: null }
  );

  await Customer.updateMany({ shop, _id: { $in: customerIds } }, { priceList: priceListId });

  return Customer.find({ shop, priceList: priceListId });
}

async function cascadeUnassignOnDelete(priceListId, shop) {
  await Customer.updateMany({ shop, priceList: priceListId }, { priceList: null });
}

module.exports = { replaceItems, assignCustomers, cascadeUnassignOnDelete };
