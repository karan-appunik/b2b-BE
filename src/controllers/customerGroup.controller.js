const CustomerGroup = require("../models/customerGroup.model");
const Customer = require("../models/customer.model");
const { ensureBaseGroup, applyAllGroupsToCustomers } = require("../services/customerGroup.service");

const DEFAULT_PAYMENT_METHODS = { invoice: false, onAccount: false, cardAtCheckout: false };
const DEFAULT_ORDER_LIMITS = {
  valueBased: { enabled: false, minValue: 0 },
  unitBased: { enabled: false, minUnits: 0 },
};

function withEffectiveSettings(group, base) {
  const obj = group.toObject ? group.toObject() : group;
  return {
    ...obj,
    effectivePriceList: obj.priceList || base.priceList || null,
    effectivePaymentMethods: obj.paymentMethods || base.paymentMethods || DEFAULT_PAYMENT_METHODS,
    effectiveOrderLimits: obj.orderLimits || base.orderLimits || DEFAULT_ORDER_LIMITS,
  };
}

async function getCustomerGroups(req, res, next) {
  try {
    const shop = req.user.shop;
    const base = await ensureBaseGroup(shop);
    const groups = await CustomerGroup.find({ shop })
      .populate("priceList", "name")
      .sort({ isBase: -1, createdAt: -1 });

    const counts = await Promise.all(
      groups.map((g) =>
        g.isBase
          ? Customer.countDocuments({ shop })
          : Customer.countDocuments({ shop, tags: g.shopifyTag })
      )
    );

    const populatedBase = groups.find((g) => g.isBase) || (await base.populate("priceList", "name"));

    res.status(200).json(
      groups.map((g, i) => ({ ...withEffectiveSettings(g, populatedBase), customerCount: counts[i] }))
    );
  } catch (err) {
    next(err);
  }
}

async function getCustomerGroup(req, res, next) {
  try {
    const shop = req.user.shop;
    const base = await ensureBaseGroup(shop);
    const group = await CustomerGroup.findOne({ _id: req.params.id, shop }).populate(
      "priceList",
      "name"
    );

    if (!group) {
      return res.status(404).json({ message: "Customer group not found" });
    }

    const populatedBase = group.isBase ? group : await base.populate("priceList", "name");
    const customers = group.isBase
      ? await Customer.find({ shop }, "name email")
      : await Customer.find({ shop, tags: group.shopifyTag }, "name email");

    res.status(200).json({ ...withEffectiveSettings(group, populatedBase), customers });
  } catch (err) {
    next(err);
  }
}

async function createCustomerGroup(req, res, next) {
  try {
    const shop = req.user.shop;
    const { name, shopifyTag, priceList, paymentMethods, orderLimits } = req.body;
    const group = await CustomerGroup.create({
      name,
      shopifyTag,
      priceList: priceList || null,
      paymentMethods: paymentMethods || null,
      orderLimits: orderLimits || null,
      shop,
    });

    const groupSync = await applyAllGroupsToCustomers(shop);

    res.status(201).json({ ...group.toObject(), groupSync });
  } catch (err) {
    next(err);
  }
}

async function updateCustomerGroup(req, res, next) {
  try {
    const shop = req.user.shop;
    const { name, shopifyTag, priceList, paymentMethods, orderLimits } = req.body;
    const existing = await CustomerGroup.findOne({ _id: req.params.id, shop });

    if (!existing) {
      return res.status(404).json({ message: "Customer group not found" });
    }

    const update = { name, priceList: priceList || null, paymentMethods: paymentMethods || null, orderLimits: orderLimits || null };
    if (!existing.isBase) update.shopifyTag = shopifyTag;

    const group = await CustomerGroup.findOneAndUpdate({ _id: req.params.id, shop }, update, {
      new: true,
      runValidators: true,
    });

    const groupSync = await applyAllGroupsToCustomers(shop);

    res.status(200).json({ ...group.toObject(), groupSync });
  } catch (err) {
    next(err);
  }
}

async function deleteCustomerGroup(req, res, next) {
  try {
    const group = await CustomerGroup.findOne({ _id: req.params.id, shop: req.user.shop });

    if (!group) {
      return res.status(404).json({ message: "Customer group not found" });
    }

    if (group.isBase) {
      return res.status(400).json({ message: "The base customer group cannot be deleted" });
    }

    await group.deleteOne();

    await applyAllGroupsToCustomers(req.user.shop);

    res.status(200).json({ message: "Customer group deleted" });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getCustomerGroups,
  getCustomerGroup,
  createCustomerGroup,
  updateCustomerGroup,
  deleteCustomerGroup,
};
