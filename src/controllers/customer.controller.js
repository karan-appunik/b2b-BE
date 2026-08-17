const Customer = require("../models/customer.model");
const { applyAllGroupsToCustomers } = require("../services/customerGroup.service");

async function getCustomers(req, res, next) {
  try {
    const customers = await Customer.find()
      .populate("priceList", "name")
      .sort({ createdAt: -1 });
    res.status(200).json(customers);
  } catch (err) {
    next(err);
  }
}

async function getCustomer(req, res, next) {
  try {
    const customer = await Customer.findById(req.params.id).populate("priceList", "name");

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
    const customer = await Customer.create({ name, email, company });
    res.status(201).json(customer);
  } catch (err) {
    next(err);
  }
}

async function updateCustomer(req, res, next) {
  try {
    const { name, email, company, role } = req.body;
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
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
    const customer = await Customer.findByIdAndDelete(req.params.id);

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.status(200).json({ message: "Customer deleted" });
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

    const ops = customers
      .filter((c) => c.email && c.name)
      .map((c) => {
        const setFields = { name: c.name, email: c.email };
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
              ? { shopifyCustomerId: String(c.shopifyCustomerId) }
              : { email: String(c.email).toLowerCase().trim() },
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
    const groupSync = await applyAllGroupsToCustomers();

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
    const { shopifyCustomerId } = req.body;

    if (!shopifyCustomerId) {
      return res.status(400).json({ message: "shopifyCustomerId is required" });
    }

    const result = await Customer.deleteMany({ shopifyCustomerId: String(shopifyCustomerId) });

    res.status(200).json({ deleted: result.deletedCount });
  } catch (err) {
    next(err);
  }
}

async function cleanupRemovedCustomers(req, res, next) {
  try {
    const { activeCustomerIds } = req.body;

    if (!Array.isArray(activeCustomerIds)) {
      return res.status(400).json({ message: "activeCustomerIds must be an array" });
    }

    const result = await Customer.deleteMany({
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
  bulkImportCustomers,
  deleteCustomersByShopifyCustomer,
  cleanupRemovedCustomers,
};
