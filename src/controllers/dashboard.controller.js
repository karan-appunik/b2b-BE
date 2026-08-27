const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const PriceList = require("../models/priceList.model");

// "Sync health" for the merchant Home page — a product/customer counts as a
// sync issue when it's missing the piece of setup SparkLayer actually needs
// to use it: a product with no price anywhere is invisible to every price
// list, and a customer without the b2b tag never gets picked up as B2B in
// the first place (see customerGroup.service.js — matching is tag-based).
async function getSyncHealth(req, res, next) {
  try {
    const shop = req.user.shop;

    const [totalProducts, priceLists, totalCustomers, untaggedCustomers] = await Promise.all([
      Product.countDocuments({ shop }),
      PriceList.find({ shop }, "items.product"),
      Customer.countDocuments({ shop }),
      Customer.countDocuments({ shop, tags: { $ne: "b2b" } }),
    ]);

    const pricedProductIds = new Set();
    for (const list of priceLists) {
      for (const item of list.items) {
        pricedProductIds.add(String(item.product));
      }
    }

    const allProductIds = await Product.find({ shop }, "_id");
    const unpricedCount = allProductIds.filter((p) => !pricedProductIds.has(String(p._id))).length;

    res.status(200).json({
      products: { issues: unpricedCount, total: totalProducts },
      customers: { issues: untaggedCustomers, total: totalCustomers },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getSyncHealth };
