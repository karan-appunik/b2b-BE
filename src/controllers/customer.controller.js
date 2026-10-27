const mongoose = require("mongoose");
const Customer = require("../models/customer.model");
const CustomerGroup = require("../models/customerGroup.model");
const { applyAllGroupsToCustomers, ensureBaseGroup } = require("../services/customerGroup.service");
const { applyRules: applyTerritoryRules } = require("../services/territory.service");
const { handOverWork } = require("../services/agentHandover.service");
const ContextSession = require("../models/contextSession.model");
const { markSimilar } = require("../services/customerSummary.service");
const {
  isAgentRole,
  findAgentByShopifyId,
  authorizeAgent,
  buildCustomerScopeFilter,
} = require("../services/agentAccess.service");
const { getRole } = require("../services/role.service");
const { AUDIT_ACTIONS, recordAudit } = require("../services/audit.service");
const { sendAgentAccessEmail } = require("../services/email.service");
const { revokeAgentContexts } = require("../services/agentContext.service");

const DEFAULT_ORDER_LIMITS = {
  quantity: { min: null, max: null },
  total: [],
};

// The merchant's customer list. It answers with a plain list, as it always did;
// `search` narrows it, and `page` + `limit` return one page instead, as
// { customers, total, page, pages }, for shops with many customers.
// `.lean()` keeps it cheap: it hands back plain records instead of building a
// full document for each customer, which was most of the time it took.
async function getCustomers(req, res, next) {
  try {
    const filter = { shop: req.user.shop };

    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: pattern }, { email: pattern }, { company: pattern }];
    }

    const query = Customer.find(filter).populate("priceList", "name").sort({ createdAt: -1 }).lean();

    if (req.query.page !== undefined) {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const [customers, total] = await Promise.all([query.skip((page - 1) * limit).limit(limit), Customer.countDocuments(filter)]);
      return res.status(200).json({ customers, total, page, pages: Math.max(Math.ceil(total / limit), 1) });
    }

    res.status(200).json(await query);
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

// POST /api/customers/:id/merge { intoCustomerId } — merge this account into
// another (spec §12). The merchant does it on purpose; see customerMerge.service.
async function mergeCustomerInto(req, res, next) {
  try {
    const summary = await require("../services/customerMerge.service").mergeCustomer({
      shop: req.user.shop,
      fromId: req.params.id,
      intoId: req.body.intoCustomerId,
      user: req.user,
    });
    res.status(200).json({ merged: true, ...summary });
  } catch (err) {
    if (err && err.code && err.statusCode) return res.status(err.statusCode).json({ code: err.code, message: err.message });
    next(err);
  }
}

async function updateCustomer(req, res, next) {
  try {
    const { name, email, company, role, creditLimit, creditBalance, territory, handoverTo, accountStatus, agentProfile, internalNotes, legalEntity, allowedChannels, accountCode } = req.body;
    const update = { name, email, company, role };

    // A sales role must be a real, active role (the built-in ones or a custom
    // one from Customers > Roles); anything else is rejected.
    let previousRole;
    let previousStatus;
    if (accountStatus !== undefined) {
      const before = await Customer.findOne({ _id: req.params.id, shop: req.user.shop }).select("accountStatus");
      previousStatus = before ? before.accountStatus || "active" : undefined;
    }
    if (role !== undefined) {
      if (role !== "customer" && !(await getRole(req.user.shop, role))) {
        return res.status(400).json({ message: "Unknown role" });
      }
      const existing = await Customer.findOne({ _id: req.params.id, shop: req.user.shop }).select("role");
      previousRole = existing ? existing.role : undefined;
    }

    // An agent's manager, dates and language (spec §4.1) are checked and saved
    // on their own, so a bad value changes nothing else.
    if (agentProfile !== undefined) {
      try {
        await require("../services/agentOverview.service").updateProfile({ shop: req.user.shop, agentId: req.params.id, input: agentProfile || {}, user: req.user });
      } catch (err) {
        if (err.code) return res.status(err.statusCode || 400).json({ code: err.code, message: err.message });
        throw err;
      }
    }

    // The person who takes over is checked before anything changes.
    if (role === "customer" && previousRole !== undefined && isAgentRole(previousRole) && handoverTo) {
      const successor = mongoose.isValidObjectId(handoverTo)
        ? await Customer.findOne({ _id: handoverTo, shop: req.user.shop })
        : null;
      if (!successor || !isAgentRole(successor.role) || String(successor._id) === String(req.params.id)) {
        return res.status(400).json({ code: "INVALID_HANDOVER", message: "Choose another active agent to take over" });
      }
    }

    if (internalNotes !== undefined) {
      if (String(internalNotes).length > 2000) return res.status(400).json({ message: "Notes can be up to 2000 characters" });
      update.internalNotes = String(internalNotes);
    }

    if (accountCode !== undefined) update.accountCode = String(accountCode || "").trim() || null;
    if (legalEntity !== undefined) update.legalEntity = String(legalEntity || "").trim() || null;
    if (allowedChannels !== undefined) {
      const list = (Array.isArray(allowedChannels) ? allowedChannels : String(allowedChannels || "").split(",")).map((c) => String(c).trim()).filter(Boolean);
      update.allowedChannels = [...new Set(list)];
    }

    if (accountStatus !== undefined) {
      if (!["active", "suspended", "merged"].includes(accountStatus)) {
        return res.status(400).json({ message: "accountStatus must be active, suspended or merged" });
      }
      update.accountStatus = accountStatus;
    }

    if (territory !== undefined) {
      // Only a real change counts as "by hand" (rules then leave it alone).
      // Saving the form with the territory unchanged must not take it away
      // from the rules.
      const prev = await Customer.findOne({ _id: req.params.id, shop: req.user.shop }).select("territory");
      const nextTerritory = territory === "" ? null : territory;
      if (prev && (prev.territory || null) !== nextTerritory) {
        update.territory = nextTerritory;
        update.$unset = { territorySource: 1 };
      }
    }
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

    // Demoting an agent back to a plain customer must cut off any customer
    // context they currently hold (spec §2.4).
    let handover = null;
    if (!isAgentRole(customer.role)) {
      await revokeAgentContexts(customer.shop, customer._id, "AGENT_DISABLED");

      // They stopped being an agent just now: their open work is passed on
      // (or flagged) rather than left with someone who can't touch it.
      if (previousRole !== undefined && isAgentRole(previousRole)) {
        handover = await handOverWork({ shop: customer.shop, agent: customer, toAgentId: handoverTo || null, actor: req.user });
      }
    }

    // Someone who has just been given a sales role is told how to start (and,
    // if the role needs it, that setting up MFA is what activates their access).
    if (role !== undefined && isAgentRole(customer.role) && !isAgentRole(previousRole)) {
      const newRole = await getRole(customer.shop, customer.role);
      sendAgentAccessEmail({
        agent: customer,
        roleName: newRole ? newRole.name : customer.role,
        shop: customer.shop,
        mfaRequired: !!(newRole && newRole.requireMfa),
      }).catch((err) => console.error("[email] agent access email failed", err));
    }

    if (internalNotes !== undefined) {
      // The note itself stays out of the audit trail; only that it changed.
      await recordAudit({
        shop: customer.shop,
        actorType: "merchant_user",
        actor: req.user._id,
        customer: customer._id,
        action: AUDIT_ACTIONS.CUSTOMER_NOTES_UPDATED,
        objectType: "customer",
        objectId: String(customer._id),
        metadata: { length: String(internalNotes).length },
      });
    }

    // A suspended or merged account ends every open context for it (spec §12).
    if (accountStatus !== undefined && accountStatus !== "active") {
      await ContextSession.updateMany(
        { shop: customer.shop, customer: customer._id, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: "ACCOUNT_" + accountStatus.toUpperCase() } }
      );
    }
    if (accountStatus !== undefined && previousStatus !== accountStatus) {
      await recordAudit({
        shop: customer.shop,
        actorType: "merchant_user",
        actor: req.user._id,
        customer: customer._id,
        action: AUDIT_ACTIONS.ACCOUNT_STATUS_CHANGED,
        objectType: "customer",
        objectId: String(customer._id),
        metadata: { from: previousStatus || "active", to: accountStatus },
      });
    }

    // Role and permission changes need an audit trail (spec §2.4).
    if (role !== undefined && previousRole !== undefined && previousRole !== customer.role) {
      await recordAudit({
        shop: customer.shop,
        actorType: "merchant_user",
        actor: req.user._id,
        action: AUDIT_ACTIONS.AGENT_ROLE_CHANGED,
        objectType: "customer",
        objectId: String(customer._id),
        metadata: { from: previousRole, to: customer.role },
      });
    }

    res.status(200).json(handover ? { ...customer.toObject(), handover } : customer);
  } catch (err) {
    if (err && err.code === "INVALID_HANDOVER") return res.status(400).json({ code: err.code, message: err.message });
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

    // Where each customer's default address was before this sync, to notice a change.
    const before = new Map(
      (
        await Customer.find({ shop, shopifyCustomerId: { $in: customers.filter((c) => c.shopifyCustomerId).map((c) => String(c.shopifyCustomerId)) } })
          .select("shopifyCustomerId region")
          .lean()
      ).map((c) => [c.shopifyCustomerId, c])
    );

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
        if (c.region && typeof c.region === "object") {
          setFields.region = {
            countryCode: c.region.countryCode ? String(c.region.countryCode).toUpperCase() : undefined,
            provinceCode: c.region.provinceCode ? String(c.region.provinceCode).toUpperCase() : undefined,
            zip: c.region.zip ? String(c.region.zip) : undefined,
          };
        }
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

    // A changed address makes a payment link for the old one wrong (spec §12).
    for (const c of customers) {
      const old = c.shopifyCustomerId ? before.get(String(c.shopifyCustomerId)) : null;
      if (!old || !old.region || !c.region || typeof c.region !== "object") continue;
      await require("../services/paymentLink.service")
        .invalidateForAddressChange({ shop, customerId: old._id, previousRegion: old.region, newRegion: c.region })
        .catch((err) => console.error("[payment-link] address check failed", err));
    }

    // A customer's tags may have just changed (new tag added in Shopify, or
    // a brand-new customer synced in for the first time) — re-run group
    // matching now so their price list/segment stays in sync without the
    // merchant needing to manually re-save a customer group.
    const groupSync = await applyAllGroupsToCustomers(shop);
    // New and changed addresses may now fit a territory rule.
    await applyTerritoryRules(shop).catch((err) => console.error("[territory] could not apply rules", err));

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

    if (!customer || !isAgentRole(customer.role)) {
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
// SparkLayer's own agent search supports that we actually store. Results are
// limited to the customers the agent has an active grant for (default deny).
async function searchB2bCustomers(req, res, next) {
  try {
    const { shop, q, agentShopifyCustomerId } = req.query;

    if (!shop || !agentShopifyCustomerId) {
      return res.status(400).json({ message: "shop and agentShopifyCustomerId are required" });
    }

    const agent = await findAgentByShopifyId(shop, agentShopifyCustomerId);
    if (!agent || !(await authorizeAgent(shop, agent, "customer.search")).allowed) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const query = String(q || "").trim();
    if (!query) {
      return res.status(200).json([]);
    }

    const scopeFilter = await buildCustomerScopeFilter(shop, agent);
    if (!scopeFilter) {
      return res.status(200).json([]);
    }

    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const digits = query.replace(/\D/g, "");

    const customers = await Customer.find({
      ...scopeFilter,
      shopifyCustomerId: { $exists: true, $ne: null },
      // Spec §4.2: company, name, email, postcode, phone or tax id. Phone digits
      // are matched without spaces, dashes or the country code.
      $or: [
        { name: pattern },
        { email: pattern },
        { company: pattern },
        { "region.zip": pattern },
        { taxId: pattern },
        { accountCode: pattern },
        { phone: pattern },
        ...(digits.length >= 4 ? [{ phoneKey: new RegExp(digits.length > 9 ? digits.slice(-9) : digits) }] : []),
      ],
    })
      .select("name email company shopifyCustomerId accountStatus")
      .limit(20);

    res.status(200).json(
      markSimilar(
        customers.map((c) => ({
          id: c._id,
          name: c.name,
          email: c.email,
          company: c.company || null,
          shopifyCustomerId: c.shopifyCustomerId,
          status: c.accountStatus || "active",
        }))
      )
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
  mergeCustomerInto,
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
