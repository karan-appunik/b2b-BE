const Customer = require("../models/customer.model");
const CustomerGroup = require("../models/customerGroup.model");
const { applyAllGroupsToCustomers, ensureBaseGroup } = require("../services/customerGroup.service");

const DEFAULT_ORDER_LIMITS = {
  quantity: { min: null, max: null },
  total: [],
};

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
    const { name, email, company, role, creditLimit, creditBalance } = req.body;
    const update = { name, email, company, role };
    if (creditLimit !== undefined) update.creditLimit = creditLimit === "" ? null : creditLimit;
    if (creditBalance !== undefined) update.creditBalance = creditBalance;
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, shop: req.user.shop },
      update,
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
        // Mirrors the shop's real Shopify "payment_on_account" customer
        // metafield — admin-frontend reads it fresh on every sync so this
        // stays a read-only reflection of Shopify, not an independent value.
        if (c.creditLimit !== undefined) setFields.creditLimit = c.creditLimit;
        if (c.creditBalance !== undefined) setFields.creditBalance = c.creditBalance;

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

// Looks up a single customer by their Shopify customer id, for the storefront
// to determine whether the person currently logged in is a sales agent (and
// if so, which role) — called via admin-frontend's app proxy using
// Shopify's `logged_in_customer_id`, not a merchant session.
async function getAgentContext(req, res, next) {
  try {
    const { shop, shopifyCustomerId } = req.query;

    if (!shop || !shopifyCustomerId) {
      return res.status(400).json({ message: "shop and shopifyCustomerId are required" });
    }

    const customer = await Customer.findOne({
      shop,
      shopifyCustomerId: String(shopifyCustomerId),
    });

    if (!customer || !["sales_agent", "sales_admin"].includes(customer.role)) {
      return res.status(200).json({ isAgent: false });
    }

    res.status(200).json({
      isAgent: true,
      role: customer.role,
      name: customer.name,
      email: customer.email,
    });
  } catch (err) {
    next(err);
  }
}

// Lets a sales agent search for the B2B customer they want to place an
// order on behalf of. Matches by name, email, or company — the fields
// SparkLayer's own agent search supports that we actually store.
async function searchB2bCustomers(req, res, next) {
  try {
    const { shop, q } = req.query;

    if (!shop) {
      return res.status(400).json({ message: "shop is required" });
    }

    const query = String(q || "").trim();
    if (!query) {
      return res.status(200).json([]);
    }

    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const customers = await Customer.find({
      shop,
      shopifyCustomerId: { $exists: true, $ne: null },
      $or: [{ name: pattern }, { email: pattern }, { company: pattern }],
    })
      .select("name email company shopifyCustomerId")
      .limit(20);

    res.status(200).json(
      customers.map((c) => ({
        id: c._id,
        name: c.name,
        email: c.email,
        company: c.company || null,
        shopifyCustomerId: c.shopifyCustomerId,
      }))
    );
  } catch (err) {
    next(err);
  }
}

// Called from admin-frontend's checkout proxy (apps.sparklayer.checkout.tsx)
// to enforce a customer group's order quantity/total limits at checkout — the
// same effective-limits resolution getCustomerGroup uses in the merchant
// panel, just keyed off the shopper's Shopify customer id instead of a
// merchant session.
async function getOrderLimits(req, res, next) {
  try {
    const { shop, shopifyCustomerId } = req.query;

    if (!shop || !shopifyCustomerId) {
      return res.status(200).json(DEFAULT_ORDER_LIMITS);
    }

    const customer = await Customer.findOne({ shop, shopifyCustomerId: String(shopifyCustomerId) });
    if (!customer) {
      return res.status(200).json(DEFAULT_ORDER_LIMITS);
    }

    const base = await ensureBaseGroup(shop);
    const group = customer.customerGroup
      ? await CustomerGroup.findOne({ _id: customer.customerGroup, shop })
      : null;
    const effectiveGroup = group || base;

    res.status(200).json(effectiveGroup.orderLimits || base.orderLimits || DEFAULT_ORDER_LIMITS);
  } catch (err) {
    next(err);
  }
}

// Called from the checkout proxy before creating a "pay on account" draft
// order — mirrors SparkLayer's sparklayer.payment_on_account customer
// metafield ({ credit_limit, balance }). creditLimit null means no limit set.
async function getCreditInfo(req, res, next) {
  try {
    const { shop, shopifyCustomerId } = req.query;

    if (!shop || !shopifyCustomerId) {
      return res.status(200).json({ creditLimit: null, balance: 0, enforced: false });
    }

    const customer = await Customer.findOne({ shop, shopifyCustomerId: String(shopifyCustomerId) });
    if (!customer) {
      return res.status(200).json({ creditLimit: null, balance: 0, enforced: false });
    }

    // The customer group's "Prevent placing an order if exceeding credit
    // limit" checkbox (Customer Groups > [group] > Credit settings) is the
    // on/off switch — a numeric limit on the customer record alone doesn't
    // enforce anything unless their effective group has this turned on.
    const base = await ensureBaseGroup(shop);
    const group = customer.customerGroup
      ? await CustomerGroup.findOne({ _id: customer.customerGroup, shop })
      : null;
    const effectiveGroup = group || base;
    const creditSettings = effectiveGroup.creditSettings || base.creditSettings;
    const enforced = !!creditSettings?.preventOrderIfExceeded;

    // "Payment on account" (Customer Groups > [group] > Payment methods) is
    // its own payment method, separate from Shopify's native Net Terms —
    // gates whether the storefront's "Payment on Account" option (and thus
    // credit-limit spend) is available to this shopper at all.
    const paymentMethods = effectiveGroup.paymentMethods || base.paymentMethods;
    const onAccountEnabled = !!paymentMethods?.onAccount;

    res.status(200).json({
      creditLimit: customer.creditLimit,
      balance: customer.creditBalance || 0,
      enforced,
      onAccountEnabled,
    });
  } catch (err) {
    next(err);
  }
}

// Called after a "pay on account" order is successfully placed — the
// customer's outstanding balance grows by the order total, same as
// SparkLayer's own balance auto-update after a successful order.
async function chargeCredit(req, res, next) {
  try {
    const { shop, shopifyCustomerId, amount } = req.body;

    if (!shop || !shopifyCustomerId || !(Number(amount) > 0)) {
      return res.status(400).json({ message: "shop, shopifyCustomerId and a positive amount are required" });
    }

    const customer = await Customer.findOneAndUpdate(
      { shop, shopifyCustomerId: String(shopifyCustomerId) },
      { $inc: { creditBalance: Number(amount) } },
      { new: true }
    );

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.status(200).json({ balance: customer.creditBalance });
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
  getAgentContext,
  searchB2bCustomers,
  getOrderLimits,
  getCreditInfo,
  chargeCredit,
  bulkImportCustomers,
  deleteCustomersByShopifyCustomer,
  cleanupRemovedCustomers,
};
