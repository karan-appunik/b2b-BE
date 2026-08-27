const CustomerGroup = require("../models/customerGroup.model");
const Customer = require("../models/customer.model");
const { ensureBaseGroup, applyAllGroupsToCustomers } = require("../services/customerGroup.service");

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

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function uniqueHandle(shop, desired, excludeId) {
  const base = slugify(desired) || "group";
  let handle = base;
  let suffix = 2;
  while (
    await CustomerGroup.exists({ shop, handle, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
  ) {
    handle = `${base}-${suffix}`;
    suffix += 1;
  }
  return handle;
}

function withEffectiveSettings(group, base) {
  const obj = group.toObject ? group.toObject() : group;
  return {
    ...obj,
    effectivePriceLists: obj.priceLists?.length ? obj.priceLists : base.priceLists || [],
    effectivePaymentMethods: obj.paymentMethods || base.paymentMethods || DEFAULT_PAYMENT_METHODS,
    effectiveOrderLimits: obj.orderLimits || base.orderLimits || DEFAULT_ORDER_LIMITS,
    effectiveStockDisplay: obj.stockDisplay || base.stockDisplay || DEFAULT_STOCK_DISPLAY,
    effectiveAddressManagement:
      obj.addressManagement || base.addressManagement || DEFAULT_ADDRESS_MANAGEMENT,
    effectiveCreditSettings: obj.creditSettings || base.creditSettings || DEFAULT_CREDIT_SETTINGS,
    effectiveCheckoutAccess: obj.checkoutAccess || base.checkoutAccess || DEFAULT_CHECKOUT_ACCESS,
  };
}

async function getCustomerGroups(req, res, next) {
  try {
    const shop = req.user.shop;
    const base = await ensureBaseGroup(shop);
    const groups = await CustomerGroup.find({ shop })
      .populate("priceLists", "name")
      .sort({ isBase: -1, createdAt: -1 });

    const counts = await Promise.all(
      groups.map((g) =>
        g.isBase
          ? Customer.countDocuments({ shop })
          : Customer.countDocuments({ shop, tags: g.shopifyTag })
      )
    );

    const populatedBase = groups.find((g) => g.isBase) || (await base.populate("priceLists", "name"));

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
      "priceLists",
      "name"
    );

    if (!group) {
      return res.status(404).json({ message: "Customer group not found" });
    }

    const populatedBase = group.isBase ? group : await base.populate("priceLists", "name");
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
    const {
      name,
      handle,
      shopifyTag,
      priceLists,
      paymentMethods,
      orderLimits,
      stockDisplay,
      addressManagement,
      creditSettings,
      checkoutAccess,
    } = req.body;
    const group = await CustomerGroup.create({
      name,
      handle: await uniqueHandle(shop, handle || name),
      shopifyTag,
      priceLists: priceLists || [],
      paymentMethods: paymentMethods || null,
      orderLimits: orderLimits || null,
      stockDisplay: stockDisplay || null,
      addressManagement: addressManagement || null,
      creditSettings: creditSettings || null,
      checkoutAccess: checkoutAccess || null,
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
    const {
      name,
      handle,
      shopifyTag,
      priceLists,
      paymentMethods,
      orderLimits,
      stockDisplay,
      addressManagement,
      creditSettings,
      checkoutAccess,
    } = req.body;
    const existing = await CustomerGroup.findOne({ _id: req.params.id, shop });

    if (!existing) {
      return res.status(404).json({ message: "Customer group not found" });
    }

    const update = {
      name,
      priceLists: priceLists || [],
      paymentMethods: paymentMethods || null,
      orderLimits: orderLimits || null,
      stockDisplay: stockDisplay || null,
      addressManagement: addressManagement || null,
      creditSettings: creditSettings || null,
      checkoutAccess: checkoutAccess || null,
    };
    if (!existing.isBase) update.shopifyTag = shopifyTag;
    if (handle && slugify(handle) !== existing.handle) {
      update.handle = await uniqueHandle(shop, handle, existing._id);
    }

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
