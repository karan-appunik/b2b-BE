const PriceList = require("../models/priceList.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");

async function replaceItems(priceListId, items) {
  const productIds = items.map((item) => item.product);
  const foundCount = await Product.countDocuments({ _id: { $in: productIds } });

  if (foundCount !== new Set(productIds.map(String)).size) {
    const err = new Error("One or more products do not exist");
    err.statusCode = 400;
    throw err;
  }

  const priceList = await PriceList.findByIdAndUpdate(
    priceListId,
    { items },
    { new: true, runValidators: true }
  ).populate("items.product", "name sku msrp");

  return priceList;
}

async function assignCustomers(priceListId, customerIds) {
  await Customer.updateMany(
    { priceList: priceListId, _id: { $nin: customerIds } },
    { priceList: null }
  );

  await Customer.updateMany({ _id: { $in: customerIds } }, { priceList: priceListId });

  return Customer.find({ priceList: priceListId });
}

async function cascadeUnassignOnDelete(priceListId) {
  await Customer.updateMany({ priceList: priceListId }, { priceList: null });
}

module.exports = { replaceItems, assignCustomers, cascadeUnassignOnDelete };
