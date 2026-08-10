const PriceList = require("../models/priceList.model");
const Customer = require("../models/customer.model");
const priceListService = require("../services/priceList.service");

async function getPriceLists(req, res, next) {
  try {
    const priceLists = await PriceList.find().sort({ createdAt: -1 });
    const customerCounts = await Customer.aggregate([
      { $match: { priceList: { $ne: null } } },
      { $group: { _id: "$priceList", count: { $sum: 1 } } },
    ]);
    const countsById = Object.fromEntries(
      customerCounts.map((c) => [String(c._id), c.count])
    );

    res.status(200).json(
      priceLists.map((pl) => ({
        _id: pl._id,
        name: pl.name,
        handle: pl.handle,
        currency: pl.currency,
        description: pl.description,
        status: pl.status,
        pricingType: pl.pricingType,
        itemCount: pl.items.length,
        customerCount: countsById[String(pl._id)] || 0,
        createdAt: pl.createdAt,
      }))
    );
  } catch (err) {
    next(err);
  }
}

async function getPriceList(req, res, next) {
  try {
    const priceList = await PriceList.findById(req.params.id).populate(
      "items.product",
      "name sku msrp"
    );

    if (!priceList) {
      return res.status(404).json({ message: "Price list not found" });
    }

    const customers = await Customer.find({ priceList: priceList._id });

    res.status(200).json({ ...priceList.toObject(), customers });
  } catch (err) {
    next(err);
  }
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function createPriceList(req, res, next) {
  try {
    const { name, handle, currency, description, status, pricingType, automaticPricing } =
      req.body;

    const priceList = await PriceList.create({
      name,
      handle: handle ? slugify(handle) : slugify(name),
      currency,
      description,
      status,
      pricingType,
      automaticPricing,
    });

    res.status(201).json(priceList);
  } catch (err) {
    next(err);
  }
}

async function updatePriceList(req, res, next) {
  try {
    const { name, description, status } = req.body;
    const priceList = await PriceList.findByIdAndUpdate(
      req.params.id,
      { name, description, status },
      { new: true, runValidators: true }
    );

    if (!priceList) {
      return res.status(404).json({ message: "Price list not found" });
    }

    res.status(200).json(priceList);
  } catch (err) {
    next(err);
  }
}

async function deletePriceList(req, res, next) {
  try {
    const priceList = await PriceList.findByIdAndDelete(req.params.id);

    if (!priceList) {
      return res.status(404).json({ message: "Price list not found" });
    }

    await priceListService.cascadeUnassignOnDelete(priceList._id);

    res.status(200).json({ message: "Price list deleted" });
  } catch (err) {
    next(err);
  }
}

async function upsertItems(req, res, next) {
  try {
    const { items } = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({ message: "items must be an array" });
    }

    const priceList = await priceListService.replaceItems(req.params.id, items);

    if (!priceList) {
      return res.status(404).json({ message: "Price list not found" });
    }

    res.status(200).json(priceList);
  } catch (err) {
    next(err);
  }
}

async function assignCustomers(req, res, next) {
  try {
    const { customerIds } = req.body;

    if (!Array.isArray(customerIds)) {
      return res.status(400).json({ message: "customerIds must be an array" });
    }

    const priceList = await PriceList.findById(req.params.id);

    if (!priceList) {
      return res.status(404).json({ message: "Price list not found" });
    }

    const customers = await priceListService.assignCustomers(req.params.id, customerIds);

    res.status(200).json({ customers });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getPriceLists,
  getPriceList,
  createPriceList,
  updatePriceList,
  deletePriceList,
  upsertItems,
  assignCustomers,
};
