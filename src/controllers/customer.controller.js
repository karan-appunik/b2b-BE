const Customer = require("../models/customer.model");
const { applyAllGroupsToCustomers } = require("../services/customerGroup.service");

async function getCustomers(req, res, next) {
  try {
    const customers = await Customer.find({ shop: req.user.shop })
      .populate("priceList", "name")
      .sort({ createdAt: -1 });
    res.status(200).json(customers);
  } catch (err) {
    next(err);
  }
}

async function getCustomer(req, res, next) {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, shop: req.user.shop }).populate(
      "priceList",
      "name"
    );

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.status(200).json(customer);
  } catch (err) {
    next(err);
  }
}

async function createCustomer(req, res, next) {
  try {
    const { name, email, company } = req.body;
    const customer = await Customer.create({ name, email, company, shop: req.user.shop });
    res.status(201).json(customer);
  } catch (err) {
    next(err);
  }
}

async function updateCustomer(req, res, next) {
  try {
    const { name, email, company, role } = req.body;
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, shop: req.user.shop },
      { name, email, company, role },
      { new: true, runValidators: true }
    ).populate("priceList", "name");

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.status(200).json(customer);
  } catch (err) {
    next(err);
  }
}

async function deleteCustomer(req, res, next) {
  try {
    const customer = await Customer.findOneAndDelete({ _id: req.params.id, shop: req.user.shop });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.status(200).json({ message: "Customer deleted" });
  } catch (err) {
    next(err);
  }
}

async function addCustomerAddress(req, res, next) {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, shop: req.user.shop });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const {
      firstName,
      lastName,
      company,
      address1,
      address2,
      city,
      zip,
      country,
      province,
      phone,
      isDefault,
    } = req.body;

    if (isDefault) {
      customer.addresses.forEach((address) => {
        address.isDefault = false;
      });
    }

    customer.addresses.push({
      firstName,
      lastName,
      company,
      address1,
      address2,
      city,
      zip,
      country,
      province,
      phone,
      isDefault: !!isDefault,
    });

    await customer.save();

    res.status(201).json(customer.addresses[customer.addresses.length - 1]);
  } catch (err) {
    next(err);
  }
}

async function bulkImportCustomers(req, res, next) {
  try {
    const { customers } = req.body;

    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ message: "customers must be a non-empty array" });
    }

    const shop = req.body.shop;

    const ops = customers
      .filter((c) => c.email && c.name)
      .map((c) => {
        const setFields = { name: c.name, email: c.email, shop };
        if (c.company) setFields.company = c.company;
        if (Array.isArray(c.tags)) setFields.tags = c.tags;
        if (c.shopifyCustomerId) setFields.shopifyCustomerId = String(c.shopifyCustomerId);
        if (c.shopifyCompanyId) setFields.shopifyCompanyId = String(c.shopifyCompanyId);
        if (c.shopifyCompanyLocationId)
          setFields.shopifyCompanyLocationId = String(c.shopifyCompanyLocationId);
        if (c.shopifyCompanyName) setFields.shopifyCompanyName = String(c.shopifyCompanyName);

        return {
          updateOne: {
            filter: c.shopifyCustomerId
              ? { shopifyCustomerId: String(c.shopifyCustomerId), shop }
              : { email: String(c.email).toLowerCase().trim(), shop },
            update: { $set: setFields },
            upsert: true,
          },
        };
      });

    if (ops.length === 0) {
      return res.status(400).json({ message: "No valid rows to import" });
    }

    const result = await Customer.bulkWrite(ops, { ordered: false });

    // A customer's tags may have just changed (new tag added in Shopify, or
    // a brand-new customer synced in for the first time) — re-run group
    // matching now so their price list/segment stays in sync without the
    // merchant needing to manually re-save a customer group.
    const groupSync = await applyAllGroupsToCustomers(shop);

    res.status(200).json({
      received: customers.length,
      imported: ops.length,
      created: result.upsertedCount,
      updated: result.modifiedCount,
      groupSync,
    });
  } catch (err) {
    next(err);
  }
}

async function deleteCustomersByShopifyCustomer(req, res, next) {
  try {
    const { shopifyCustomerId, shop } = req.body;

    if (!shopifyCustomerId) {
      return res.status(400).json({ message: "shopifyCustomerId is required" });
    }

    const result = await Customer.deleteMany({ shopifyCustomerId: String(shopifyCustomerId), shop });

    res.status(200).json({ deleted: result.deletedCount });
  } catch (err) {
    next(err);
  }
}

async function cleanupRemovedCustomers(req, res, next) {
  try {
    const { activeCustomerIds, shop } = req.body;

    if (!Array.isArray(activeCustomerIds)) {
      return res.status(400).json({ message: "activeCustomerIds must be an array" });
    }

    const result = await Customer.deleteMany({
      shop,
      shopifyCustomerId: { $exists: true, $ne: null, $nin: activeCustomerIds },
    });

    res.status(200).json({ deleted: result.deletedCount });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  addCustomerAddress,
  bulkImportCustomers,
  deleteCustomersByShopifyCustomer,
  cleanupRemovedCustomers,
};
