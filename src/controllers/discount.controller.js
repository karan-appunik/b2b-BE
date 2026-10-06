const mongoose = require("mongoose");
const Discount = require("../models/discount.model");
const DiscountRedemption = require("../models/discountRedemption.model");
const Customer = require("../models/customer.model");
const CustomerGroup = require("../models/customerGroup.model");
const Product = require("../models/product.model");
const { ensureBaseGroup } = require("../services/customerGroup.service");

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// docs.sparklayer.io/discounts "Compatible discounts" whitelist — drops
// anything that isn't a valid ObjectId (a stray/removed discount id sent by
// a stale form) rather than letting Mongoose throw a cast error.
function sanitizeCompatibleDiscountIds(compatibleDiscountIds) {
  if (!Array.isArray(compatibleDiscountIds)) return [];
  return compatibleDiscountIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
}

// docs.sparklayer.io/discounts "Coupon codes" — "coupon codes will
// automatically be saved in uppercase". De-duped so the same code typed
// twice doesn't trip the {shop, couponCodes} unique index on save.
function sanitizeCouponCodes(couponCodes) {
  if (!Array.isArray(couponCodes)) return [];
  const cleaned = couponCodes.map((code) => String(code).trim().toUpperCase()).filter(Boolean);
  return [...new Set(cleaned)];
}

// docs.sparklayer.io/discounts "Discount Priorities" — a newly created (or
// duplicated) discount jumps to the front of the merchant's priority order,
// ahead of everything that already exists, rather than tying with it.
async function topPriority(shop) {
  const first = await Discount.findOne({ shop }).sort({ priority: 1 }).select("priority").lean();
  return first ? first.priority - 1 : 0;
}

// docs.sparklayer.io/discounts "Advanced Requirements and Rewards" — one
// SKU/tag/vendor condition, the shared shape between the simple
// productRequirement field, each condition inside an advanced
// requirementGroups entry, and a cart_lines reward's cartLineMatch.
function validateRequirementCondition(condition, label) {
  if (typeof condition !== "object" || condition === null || Array.isArray(condition)) {
    return `${label} must be an object`;
  }
  const { attribute, operator, value: conditionValue } = condition;
  if (!["sku", "tag", "vendor"].includes(attribute)) {
    return `${label} attribute must be 'sku', 'tag', or 'vendor'`;
  }
  if (!["equals", "contains"].includes(operator)) {
    return `${label} operator must be 'equals' or 'contains'`;
  }
  if (!conditionValue || !String(conditionValue).trim()) {
    return `${label} value is required`;
  }
  return null;
}

// docs.sparklayer.io/discounts "Advanced Free Products" — the requirement-
// condition validator can't check a product's SKU exists (that's an async DB
// lookup, done later by resolveFreeProductGroups); this only checks shape.
function validateFreeProductGroupInput(group, groupLabel) {
  if (typeof group !== "object" || group === null || Array.isArray(group)) {
    return `${groupLabel} must be an object`;
  }
  const { products, application, limitedMaxTimes } = group;
  if (!Array.isArray(products) || products.length === 0) {
    return `${groupLabel} must have at least one product`;
  }
  for (const product of products) {
    if (typeof product !== "object" || product === null || Array.isArray(product)) {
      return `${groupLabel} products must be objects`;
    }
    if (!product.sku || !String(product.sku).trim()) {
      return `${groupLabel} has a product missing a SKU`;
    }
    if (product.quantity !== undefined && product.quantity !== null && product.quantity !== "") {
      const qty = Number(product.quantity);
      if (!Number.isInteger(qty) || qty < 1) {
        return `${groupLabel} product quantity must be a whole number of 1 or more`;
      }
    }
    if (product.perQuantity !== undefined && product.perQuantity !== null && product.perQuantity !== "") {
      const per = Number(product.perQuantity);
      if (!Number.isInteger(per) || per < 1) {
        return `${groupLabel} "award again every" must be a whole number of 1 or more`;
      }
    }
  }
  if (!["once", "recursive", "limited"].includes(application)) {
    return `${groupLabel} application must be 'once', 'recursive', or 'limited'`;
  }
  if (application === "limited") {
    const max = Number(limitedMaxTimes);
    if (!Number.isInteger(max) || max < 1) {
      return `${groupLabel} maximum times must be a whole number of 1 or more when application is 'limited'`;
    }
  }
  return null;
}

function validateDiscountInput({ name, method, couponCodes, mode, appliesTo, valueType, value, minSubtotal, maxSubtotal, itemQuantityMethod, minItemQuantity, maxItemQuantity, productRequirement, startsAt, endsAt, customerGroupIds, usageLimitPerCustomer, excludedCustomerIdentifiers, freeProductSku, freeProductQuantity, freeProductPerQuantity, lineItemSkus, requirementGroups, rewards, rewardApplication, freeProductGroups }) {
  if (!name || !String(name).trim()) {
    return "Name is required";
  }

  if (method !== "automatic" && method !== "coupon") {
    return "Method must be 'automatic' or 'coupon'";
  }

  if (method === "coupon" && sanitizeCouponCodes(couponCodes).length === 0) {
    return "At least one coupon code is required for coupon discounts";
  }

  if (mode === "advanced") {
    if (!Array.isArray(requirementGroups) || requirementGroups.length === 0) {
      return "At least one requirement group is required for advanced discounts";
    }
    if (requirementGroups.length > 10) {
      return "A maximum of 10 order rules are allowed per discount";
    }
    for (const group of requirementGroups) {
      if (!Array.isArray(group) || group.length === 0) {
        return "Each requirement group must contain at least one condition";
      }
      if (group.length > 10) {
        return "A maximum of 10 conditions are allowed per order rule";
      }
      for (const condition of group) {
        const conditionError = validateRequirementCondition(condition, "Requirement condition");
        if (conditionError) return conditionError;
      }
    }

    if (!Array.isArray(rewards) || rewards.length === 0) {
      return "At least one reward is required for advanced discounts";
    }
    for (const reward of rewards) {
      if (typeof reward !== "object" || reward === null || Array.isArray(reward)) {
        return "Each reward must be an object";
      }
      const { type: rewardType, valueType: rewardValueType, value: rewardValue, cartLineMatch } = reward;
      if (!["subtotal", "shipping", "cart_lines"].includes(rewardType)) {
        return "Reward type must be 'subtotal', 'shipping', or 'cart_lines'";
      }
      const validRewardValueTypes = rewardType === "shipping" ? ["percentage", "fixed", "free", "set_cost"] : ["percentage", "fixed"];
      if (!validRewardValueTypes.includes(rewardValueType)) {
        return rewardType === "shipping"
          ? "Reward value type must be 'percentage', 'fixed', 'free', or 'set_cost'"
          : "Reward value type must be 'percentage' or 'fixed'";
      }
      if (rewardValueType !== "free") {
        const numericRewardValue = Number(rewardValue);
        if (Number.isNaN(numericRewardValue) || numericRewardValue < 0) {
          return "Reward value must be a non-negative number";
        }
        if (rewardValueType === "percentage" && numericRewardValue > 100) {
          return "Reward percentage value cannot exceed 100";
        }
      }
      if (rewardType === "cart_lines") {
        if (!cartLineMatch) {
          return "A cart lines reward requires a product-matching condition";
        }
        const matchError = validateRequirementCondition(cartLineMatch, "Cart lines reward condition");
        if (matchError) return matchError;
      }
    }

    if (rewardApplication !== undefined && rewardApplication !== null && !["all", "highest", "lowest"].includes(rewardApplication)) {
      return "Reward application must be 'all', 'highest', or 'lowest'";
    }
  } else if (mode === "advanced_free_product") {
    if (!Array.isArray(requirementGroups) || requirementGroups.length === 0) {
      return "At least one requirement group is required for advanced free product discounts";
    }
    if (requirementGroups.length > 10) {
      return "A maximum of 10 order rules are allowed per discount";
    }
    for (const group of requirementGroups) {
      if (!Array.isArray(group) || group.length === 0) {
        return "Each requirement group must contain at least one condition";
      }
      if (group.length > 10) {
        return "A maximum of 10 conditions are allowed per order rule";
      }
      for (const condition of group) {
        const conditionError = validateRequirementCondition(condition, "Requirement condition");
        if (conditionError) return conditionError;
      }
    }

    // Parallel arrays — freeProductGroups[i] is requirementGroups[i]'s own
    // reward, so every requirement group needs a matching reward entry.
    if (!Array.isArray(freeProductGroups) || freeProductGroups.length !== requirementGroups.length) {
      return "Each requirement group needs its own free product reward";
    }
    for (let i = 0; i < freeProductGroups.length; i += 1) {
      const groupError = validateFreeProductGroupInput(freeProductGroups[i], `Free product reward ${i + 1}`);
      if (groupError) return groupError;
    }
  } else if (!["order", "shipping", "free_product", "line_item"].includes(appliesTo)) {
    return "Applies to must be 'order', 'shipping', 'free_product', or 'line_item'";
  } else if (appliesTo === "free_product") {
    if (valueType !== "free") {
      return "Value type must be 'free' for a free product reward";
    }
    if (!freeProductSku || !String(freeProductSku).trim()) {
      return "Enter the SKU of the product to give away";
    }
    if (freeProductQuantity !== undefined && freeProductQuantity !== null && freeProductQuantity !== "") {
      const qty = Number(freeProductQuantity);
      if (!Number.isInteger(qty) || qty < 1) {
        return "Free product quantity must be a whole number of 1 or more";
      }
    }
    if (freeProductPerQuantity !== undefined && freeProductPerQuantity !== null && freeProductPerQuantity !== "") {
      const per = Number(freeProductPerQuantity);
      if (!Number.isInteger(per) || per < 1) {
        return "\"Award again every\" must be a whole number of 1 or more";
      }
    }
  } else if (appliesTo === "line_item") {
    if (valueType !== "percentage") {
      return "Value type must be 'percentage' for a percentage-off-products reward";
    }
    const numericValue = Number(value);
    if (Number.isNaN(numericValue) || numericValue < 0 || numericValue > 100) {
      return "Percentage value must be between 0 and 100";
    }
    if (!Array.isArray(lineItemSkus) || lineItemSkus.length === 0) {
      return "Enter at least one SKU";
    }
    if (lineItemSkus.length > 25) {
      return "A maximum of 25 SKUs are allowed per discount";
    }
    if (lineItemSkus.some((sku) => typeof sku !== "string" || !sku.trim())) {
      return "SKU entries must be non-empty text";
    }
  } else {
    const validValueTypes = appliesTo === "shipping" ? ["percentage", "fixed", "free", "set_cost"] : ["percentage", "fixed"];
    if (!validValueTypes.includes(valueType)) {
      return appliesTo === "shipping"
        ? "Value type must be 'percentage', 'fixed', 'free', or 'set_cost'"
        : "Value type must be 'percentage' or 'fixed'";
    }

    const numericValue = Number(value);
    if (Number.isNaN(numericValue) || numericValue < 0) {
      return "Value must be a non-negative number";
    }
    if (valueType === "percentage" && numericValue > 100) {
      return "Percentage value cannot exceed 100";
    }
  }

  if (minSubtotal !== undefined && minSubtotal !== null && minSubtotal !== "") {
    const min = Number(minSubtotal);
    if (Number.isNaN(min) || min < 0) return "Minimum subtotal must be a non-negative number";
  }
  if (maxSubtotal !== undefined && maxSubtotal !== null && maxSubtotal !== "") {
    const max = Number(maxSubtotal);
    if (Number.isNaN(max) || max < 0) return "Maximum subtotal must be a non-negative number";
  }
  if (
    minSubtotal !== undefined && minSubtotal !== null && minSubtotal !== "" &&
    maxSubtotal !== undefined && maxSubtotal !== null && maxSubtotal !== ""
  ) {
    if (Number(maxSubtotal) < Number(minSubtotal)) {
      return "Maximum subtotal must be greater than or equal to minimum subtotal";
    }
  }

  if (itemQuantityMethod !== undefined && itemQuantityMethod !== null && !["total", "unique"].includes(itemQuantityMethod)) {
    return "Item quantity method must be 'total' or 'unique'";
  }
  if (minItemQuantity !== undefined && minItemQuantity !== null && minItemQuantity !== "") {
    const min = Number(minItemQuantity);
    if (!Number.isInteger(min) || min < 0) return "Minimum item quantity must be a non-negative whole number";
  }
  if (maxItemQuantity !== undefined && maxItemQuantity !== null && maxItemQuantity !== "") {
    const max = Number(maxItemQuantity);
    if (!Number.isInteger(max) || max < 0) return "Maximum item quantity must be a non-negative whole number";
  }
  if (
    minItemQuantity !== undefined && minItemQuantity !== null && minItemQuantity !== "" &&
    maxItemQuantity !== undefined && maxItemQuantity !== null && maxItemQuantity !== ""
  ) {
    if (Number(maxItemQuantity) < Number(minItemQuantity)) {
      return "Maximum item quantity must be greater than or equal to minimum item quantity";
    }
  }

  if (productRequirement !== undefined && productRequirement !== null) {
    const productRequirementError = validateRequirementCondition(productRequirement, "Product requirement");
    if (productRequirementError) return productRequirementError;
  }

  if (startsAt) {
    const starts = new Date(startsAt);
    if (Number.isNaN(starts.getTime())) return "Start date is invalid";
  }
  if (endsAt) {
    const ends = new Date(endsAt);
    if (Number.isNaN(ends.getTime())) return "End date is invalid";
  }
  if (startsAt && endsAt && new Date(endsAt) < new Date(startsAt)) {
    return "End date must be on or after the start date";
  }

  if (customerGroupIds !== undefined && customerGroupIds !== null) {
    if (!Array.isArray(customerGroupIds)) return "Customer groups must be a list";
    if (customerGroupIds.some((id) => !mongoose.isValidObjectId(id))) {
      return "One or more customer group ids are invalid";
    }
  }

  if (usageLimitPerCustomer !== undefined && usageLimitPerCustomer !== null && usageLimitPerCustomer !== "") {
    const limit = Number(usageLimitPerCustomer);
    if (!Number.isInteger(limit) || limit < 1) {
      return "Usage limit per customer must be a whole number of 1 or more";
    }
  }

  if (excludedCustomerIdentifiers !== undefined && excludedCustomerIdentifiers !== null) {
    if (!Array.isArray(excludedCustomerIdentifiers)) return "Excluded customers must be a list";
    if (excludedCustomerIdentifiers.some((id) => typeof id !== "string" || !id.trim())) {
      return "Excluded customer entries must be non-empty text (email or customer id)";
    }
  }

  return null;
}

// Resolves and caches the giveaway product's Shopify variant id + display
// fields from the Product collection (synced from Shopify — see
// internal.routes.js POST /products/sync), matched by SKU the same way the
// real SparkLayer app's "Give a free product" form works. Returns null when
// appliesTo isn't "free_product"; throws a plain string message (handled
// like a validation error) if no product with that SKU exists under this shop.
async function resolveOneFreeProduct(shop, sku, quantity, perQuantity) {
  const product = await Product.findOne({ shop, sku: String(sku).trim() });
  if (!product || !product.shopifyVariantId) {
    throw new Error(`No product found with SKU "${sku}"`);
  }

  return {
    productId: product._id,
    shopifyVariantId: product.shopifyVariantId,
    title: product.productTitle || product.name,
    variantTitle: product.variantTitle || "",
    sku: product.sku,
    image: product.image || null,
    quantity: quantity === undefined || quantity === null || quantity === "" ? 1 : Number(quantity),
    perQuantity: perQuantity === undefined || perQuantity === null || perQuantity === "" ? null : Number(perQuantity),
  };
}

async function resolveFreeProduct(shop, appliesTo, freeProductSku, freeProductQuantity, freeProductPerQuantity) {
  if (appliesTo !== "free_product") return null;
  return resolveOneFreeProduct(shop, freeProductSku, freeProductQuantity, freeProductPerQuantity);
}

// docs.sparklayer.io/discounts "Advanced Free Products" — resolves every
// product in every group (mode === "advanced_free_product" only); mirrors
// resolveFreeProduct but for freeProductGroups' parallel-to-requirementGroups
// shape, where each group can award several different products.
async function resolveFreeProductGroups(shop, mode, freeProductGroups) {
  if (mode !== "advanced_free_product") return [];

  const resolved = [];
  for (const group of freeProductGroups) {
    const products = [];
    for (const product of group.products) {
      products.push(await resolveOneFreeProduct(shop, product.sku, product.quantity, product.perQuantity));
    }
    resolved.push({
      products,
      application: group.application,
      limitedMaxTimes:
        group.application === "limited" && group.limitedMaxTimes !== undefined && group.limitedMaxTimes !== null && group.limitedMaxTimes !== ""
          ? Number(group.limitedMaxTimes)
          : null,
    });
  }
  return resolved;
}

async function getDiscounts(req, res, next) {
  try {
    const shop = req.user.shop;
    const discounts = await Discount.find({ shop }).sort({ createdAt: -1 });
    res.status(200).json(discounts);
  } catch (err) {
    next(err);
  }
}

// docs.sparklayer.io/discounts "Discount Priorities" — "you can then simply
// drag the discounts up and down in the priority you'd like them to apply."
// The merchant panel sends the full list of discount ids in the new order;
// this just stamps each one's position as its priority (lower = applied
// first — see resolveDiscount in discountLookup.server.ts).
async function reorderDiscountPriorities(req, res, next) {
  try {
    const shop = req.user.shop;
    const { orderedIds } = req.body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ message: "orderedIds must be a non-empty array" });
    }

    await Promise.all(
      orderedIds.map((id, index) =>
        mongoose.Types.ObjectId.isValid(id)
          ? Discount.updateOne({ _id: id, shop }, { $set: { priority: index } })
          : Promise.resolve(),
      ),
    );

    const discounts = await Discount.find({ shop }).sort({ priority: 1, createdAt: -1 });
    res.status(200).json(discounts);
  } catch (err) {
    next(err);
  }
}

async function getDiscount(req, res, next) {
  try {
    const shop = req.user.shop;
    const discount = await Discount.findOne({ _id: req.params.id, shop });

    if (!discount) {
      return res.status(404).json({ message: "Discount not found" });
    }

    res.status(200).json(discount);
  } catch (err) {
    next(err);
  }
}

// docs.sparklayer.io/discounts "Data Tracking" — merchant-facing rollup of
// the redemption rows recordDiscountRedemptions writes at checkout time:
// how many times this discount was used and the total dollars it saved
// across every order, plus a short list of the most recent redemptions.
async function getDiscountRedemptionSummary(req, res, next) {
  try {
    const shop = req.user.shop;
    const discount = await Discount.findOne({ _id: req.params.id, shop }).select("_id").lean();

    if (!discount) {
      return res.status(404).json({ message: "Discount not found" });
    }

    const [summary] = await DiscountRedemption.aggregate([
      { $match: { shop, discount: discount._id } },
      {
        $group: {
          _id: null,
          timesUsed: { $sum: 1 },
          totalSavings: { $sum: { $ifNull: ["$savingsAmount", 0] } },
        },
      },
    ]);

    const recent = await DiscountRedemption.find({ shop, discount: discount._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("orderId couponCode preDiscountTotal savingsAmount currency createdAt")
      .lean();

    res.status(200).json({
      timesUsed: summary?.timesUsed || 0,
      totalSavings: summary?.totalSavings || 0,
      recent,
    });
  } catch (err) {
    next(err);
  }
}

async function createDiscount(req, res, next) {
  try {
    const {
      name,
      handle,
      publicName,
      description,
      status,
      method,
      couponCodes,
      appliesTo,
      valueType,
      value,
      currency,
      minSubtotal,
      maxSubtotal,
      itemQuantityMethod,
      minItemQuantity,
      maxItemQuantity,
      productRequirement,
      startsAt,
      endsAt,
      customerGroupIds,
      usageLimitPerCustomer,
      excludedCustomerIdentifiers,
      compatibleWithOthers,
      compatibleDiscountIds,
      freeProductSku,
      freeProductQuantity,
      freeProductPerQuantity,
      lineItemSkus,
      mode,
      requirementGroups,
      rewards,
      rewardApplication,
      freeProductGroups,
    } = req.body;

    const validationError = validateDiscountInput({
      name,
      method,
      couponCodes,
      mode,
      appliesTo,
      valueType,
      value,
      minSubtotal,
      maxSubtotal,
      itemQuantityMethod,
      minItemQuantity,
      maxItemQuantity,
      productRequirement,
      startsAt,
      endsAt,
      customerGroupIds,
      usageLimitPerCustomer,
      excludedCustomerIdentifiers,
      freeProductSku,
      freeProductQuantity,
      freeProductPerQuantity,
      lineItemSkus,
      requirementGroups,
      rewards,
      rewardApplication,
      freeProductGroups,
    });
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    // "advanced" and "advanced_free_product" discounts both ignore
    // appliesTo/valueType/value/productRequirement/lineItemSkus/freeProduct
    // entirely (see discount.model.js) — forced to harmless defaults here
    // rather than left as whatever the client sent, since appliesTo/
    // valueType/value are schema-required fields.
    const isAdvancedRewards = mode === "advanced";
    const isAdvancedFreeProduct = mode === "advanced_free_product";
    const isAdvancedAny = isAdvancedRewards || isAdvancedFreeProduct;
    const effectiveAppliesTo = isAdvancedAny ? "order" : appliesTo;
    const effectiveValueType = isAdvancedAny ? "percentage" : valueType;
    const effectiveValue = isAdvancedAny ? 0 : (appliesTo === "free_product" ? 0 : Number(value));

    let freeProduct;
    let resolvedFreeProductGroups;
    try {
      freeProduct = isAdvancedAny ? null : await resolveFreeProduct(req.user.shop, appliesTo, freeProductSku, freeProductQuantity, freeProductPerQuantity);
      resolvedFreeProductGroups = await resolveFreeProductGroups(req.user.shop, mode, freeProductGroups || []);
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const discount = await Discount.create({
      name,
      handle: handle ? slugify(handle) : slugify(name),
      publicName: publicName || "",
      description: description || "",
      status,
      method,
      couponCodes: method === "coupon" ? sanitizeCouponCodes(couponCodes) : [],
      mode: isAdvancedRewards ? "advanced" : isAdvancedFreeProduct ? "advanced_free_product" : "simple",
      requirementGroups: isAdvancedAny && Array.isArray(requirementGroups) ? requirementGroups : [],
      rewards: isAdvancedRewards && Array.isArray(rewards) ? rewards : [],
      rewardApplication: isAdvancedRewards && ["all", "highest", "lowest"].includes(rewardApplication) ? rewardApplication : "all",
      freeProductGroups: resolvedFreeProductGroups,
      appliesTo: effectiveAppliesTo,
      valueType: effectiveValueType,
      value: effectiveValue,
      freeProduct,
      lineItemSkus: !isAdvancedAny && appliesTo === "line_item" && Array.isArray(lineItemSkus)
        ? lineItemSkus.map((sku) => String(sku).trim()).filter(Boolean)
        : [],
      currency,
      minSubtotal: minSubtotal === undefined || minSubtotal === null || minSubtotal === "" ? null : Number(minSubtotal),
      maxSubtotal: maxSubtotal === undefined || maxSubtotal === null || maxSubtotal === "" ? null : Number(maxSubtotal),
      itemQuantityMethod: itemQuantityMethod === "unique" ? "unique" : "total",
      minItemQuantity:
        minItemQuantity === undefined || minItemQuantity === null || minItemQuantity === "" ? null : Number(minItemQuantity),
      maxItemQuantity:
        maxItemQuantity === undefined || maxItemQuantity === null || maxItemQuantity === "" ? null : Number(maxItemQuantity),
      productRequirement: isAdvancedAny ? null : (productRequirement || null),
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      customerGroupIds: Array.isArray(customerGroupIds) ? customerGroupIds : [],
      usageLimitPerCustomer:
        usageLimitPerCustomer === undefined || usageLimitPerCustomer === null || usageLimitPerCustomer === ""
          ? null
          : Number(usageLimitPerCustomer),
      excludedCustomerIdentifiers: Array.isArray(excludedCustomerIdentifiers)
        ? excludedCustomerIdentifiers.map((id) => String(id).trim()).filter(Boolean)
        : [],
      compatibleWithOthers: compatibleWithOthers === true,
      compatibleDiscountIds: sanitizeCompatibleDiscountIds(compatibleDiscountIds),
      priority: await topPriority(req.user.shop),
      shop: req.user.shop,
    });

    res.status(201).json(discount);
  } catch (err) {
    next(err);
  }
}

async function updateDiscount(req, res, next) {
  try {
    const shop = req.user.shop;
    const {
      name,
      handle,
      publicName,
      description,
      status,
      method,
      couponCodes,
      appliesTo,
      valueType,
      value,
      currency,
      minSubtotal,
      maxSubtotal,
      itemQuantityMethod,
      minItemQuantity,
      maxItemQuantity,
      productRequirement,
      startsAt,
      endsAt,
      customerGroupIds,
      usageLimitPerCustomer,
      excludedCustomerIdentifiers,
      compatibleWithOthers,
      compatibleDiscountIds,
      freeProductSku,
      freeProductQuantity,
      freeProductPerQuantity,
      lineItemSkus,
      mode,
      requirementGroups,
      rewards,
      rewardApplication,
      freeProductGroups,
    } = req.body;

    const validationError = validateDiscountInput({
      name,
      method,
      couponCodes,
      mode,
      appliesTo,
      valueType,
      value,
      minSubtotal,
      maxSubtotal,
      itemQuantityMethod,
      minItemQuantity,
      maxItemQuantity,
      productRequirement,
      startsAt,
      endsAt,
      customerGroupIds,
      usageLimitPerCustomer,
      excludedCustomerIdentifiers,
      freeProductSku,
      freeProductQuantity,
      freeProductPerQuantity,
      lineItemSkus,
      requirementGroups,
      rewards,
      rewardApplication,
      freeProductGroups,
    });
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const isAdvancedRewards = mode === "advanced";
    const isAdvancedFreeProduct = mode === "advanced_free_product";
    const isAdvancedAny = isAdvancedRewards || isAdvancedFreeProduct;
    const effectiveAppliesTo = isAdvancedAny ? "order" : appliesTo;
    const effectiveValueType = isAdvancedAny ? "percentage" : valueType;
    const effectiveValue = isAdvancedAny ? 0 : (appliesTo === "free_product" ? 0 : Number(value));

    let freeProduct;
    let resolvedFreeProductGroups;
    try {
      freeProduct = isAdvancedAny ? null : await resolveFreeProduct(shop, appliesTo, freeProductSku, freeProductQuantity, freeProductPerQuantity);
      resolvedFreeProductGroups = await resolveFreeProductGroups(shop, mode, freeProductGroups || []);
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const update = {
      name,
      handle: handle ? slugify(handle) : slugify(name),
      publicName: publicName || "",
      description: description || "",
      status,
      method,
      couponCodes: method === "coupon" ? sanitizeCouponCodes(couponCodes) : [],
      mode: isAdvancedRewards ? "advanced" : isAdvancedFreeProduct ? "advanced_free_product" : "simple",
      requirementGroups: isAdvancedAny && Array.isArray(requirementGroups) ? requirementGroups : [],
      rewards: isAdvancedRewards && Array.isArray(rewards) ? rewards : [],
      rewardApplication: isAdvancedRewards && ["all", "highest", "lowest"].includes(rewardApplication) ? rewardApplication : "all",
      freeProductGroups: resolvedFreeProductGroups,
      appliesTo: effectiveAppliesTo,
      valueType: effectiveValueType,
      value: effectiveValue,
      freeProduct,
      lineItemSkus: !isAdvancedAny && appliesTo === "line_item" && Array.isArray(lineItemSkus)
        ? lineItemSkus.map((sku) => String(sku).trim()).filter(Boolean)
        : [],
      currency,
      minSubtotal: minSubtotal === undefined || minSubtotal === null || minSubtotal === "" ? null : Number(minSubtotal),
      maxSubtotal: maxSubtotal === undefined || maxSubtotal === null || maxSubtotal === "" ? null : Number(maxSubtotal),
      itemQuantityMethod: itemQuantityMethod === "unique" ? "unique" : "total",
      minItemQuantity:
        minItemQuantity === undefined || minItemQuantity === null || minItemQuantity === "" ? null : Number(minItemQuantity),
      maxItemQuantity:
        maxItemQuantity === undefined || maxItemQuantity === null || maxItemQuantity === "" ? null : Number(maxItemQuantity),
      productRequirement: isAdvancedAny ? null : (productRequirement || null),
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      customerGroupIds: Array.isArray(customerGroupIds) ? customerGroupIds : [],
      usageLimitPerCustomer:
        usageLimitPerCustomer === undefined || usageLimitPerCustomer === null || usageLimitPerCustomer === ""
          ? null
          : Number(usageLimitPerCustomer),
      excludedCustomerIdentifiers: Array.isArray(excludedCustomerIdentifiers)
        ? excludedCustomerIdentifiers.map((id) => String(id).trim()).filter(Boolean)
        : [],
      compatibleWithOthers: compatibleWithOthers === true,
      compatibleDiscountIds: sanitizeCompatibleDiscountIds(compatibleDiscountIds),
    };

    const discount = await Discount.findOneAndUpdate({ _id: req.params.id, shop }, update, {
      new: true,
      runValidators: true,
    });

    if (!discount) {
      return res.status(404).json({ message: "Discount not found" });
    }

    res.status(200).json(discount);
  } catch (err) {
    next(err);
  }
}

async function deleteDiscount(req, res, next) {
  try {
    const shop = req.user.shop;
    const discount = await Discount.findOneAndDelete({ _id: req.params.id, shop });

    if (!discount) {
      return res.status(404).json({ message: "Discount not found" });
    }

    res.status(200).json({ message: "Discount deleted" });
  } catch (err) {
    next(err);
  }
}

// docs.sparklayer.io/discounts "Duplicate Discounts" — "these are discounts
// that share the same structure, rules, and logic of an existing one" and
// "the discount internal name will have ' copy' added to the end". Copies
// every setting as-is except: a fresh handle (the original's is already
// taken), status forced to draft (so a copy never goes live by accident),
// and coupon codes cleared (the {shop, couponCodes} unique index would
// reject reusing the same code — the merchant adds new ones before
// activating a coupon-method duplicate).
async function duplicateDiscount(req, res, next) {
  try {
    const shop = req.user.shop;
    const original = await Discount.findOne({ _id: req.params.id, shop }).lean();

    if (!original) {
      return res.status(404).json({ message: "Discount not found" });
    }

    const newName = `${original.name} copy`;
    const baseHandle = slugify(newName) || "discount-copy";
    let handle = baseHandle;
    let suffix = 1;
    while (await Discount.exists({ shop, handle })) {
      suffix += 1;
      handle = `${baseHandle}-${suffix}`;
    }

    const { _id, createdAt, updatedAt, __v, ...rest } = original;

    const duplicate = await Discount.create({
      ...rest,
      name: newName,
      handle,
      status: "draft",
      couponCodes: [],
      priority: await topPriority(shop),
      shop,
    });

    res.status(201).json(duplicate);
  } catch (err) {
    next(err);
  }
}

// Called from admin-frontend's checkout proxy (apps.sparklayer.checkout.tsx)
// to look up candidate discounts at checkout time — mirrors getOrderLimits/
// getCreditInfo: this returns raw, schedule-filtered candidates only, the
// caller does subtotal/currency matching once it knows the cart's real total
// (same division of labor as fetchVariantPricing + pickTierPrice for pricing).
async function getActiveDiscounts(req, res, next) {
  try {
    const { shop, couponCodes, shopifyCustomerId } = req.query;

    if (!shop) {
      return res.status(200).json({ automatic: [], coupons: [] });
    }

    const now = new Date();
    const scheduleFilter = {
      $and: [
        { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
        { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
      ],
    };

    // docs.sparklayer.io/discounts "Discount Priorities" — sorted by the
    // merchant's manually-set order so every resolver on the admin-frontend
    // side (order stacking, and the "first eligible" pick for shipping/
    // free-product/line-item rewards) sees automatic discounts in the same
    // priority order without each one re-deriving it.
    let automatic = await Discount.find({
      shop,
      status: "active",
      method: "automatic",
      ...scheduleFilter,
    }).sort({ priority: 1, createdAt: -1 });

    // Up to 3 coupon codes per order (docs.sparklayer.io/discounts) — extra
    // codes are just ignored here, matching the storefront cart's own
    // 3-code cap, rather than erroring on a request that over-sends.
    const codes = String(couponCodes || "")
      .split(",")
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 3);

    let coupons = [];
    if (codes.length) {
      coupons = await Discount.find({
        shop,
        status: "active",
        method: "coupon",
        couponCodes: { $in: codes },
        ...scheduleFilter,
      });
    }

    // Resolve the shopper's effective customer group (own group, falling
    // back to the base group) — same resolution getOrderLimits/getCreditInfo
    // use — so discounts restricted to other groups (Discount.customerGroupIds)
    // never reach the buyer. An empty customerGroupIds means "every group".
    let effectiveGroupId = null;
    let customer = null;
    if (shopifyCustomerId) {
      customer = await Customer.findOne({ shop, shopifyCustomerId: String(shopifyCustomerId) });
      if (customer) {
        const base = await ensureBaseGroup(shop);
        const group = customer.customerGroup
          ? await CustomerGroup.findOne({ _id: customer.customerGroup, shop })
          : null;
        effectiveGroupId = String((group || base)._id);
      }
    }

    const groupEligible = (discount) => {
      if (!discount.customerGroupIds || discount.customerGroupIds.length === 0) return true;
      return effectiveGroupId != null && discount.customerGroupIds.some((id) => String(id) === effectiveGroupId);
    };

    // Exclude customers (docs.sparklayer.io/discounts) — matched against
    // either the shopper's email or their raw/GID Shopify customer id, since
    // a merchant might paste either into the exclusion list.
    const shopperIdentifiers = new Set();
    if (customer?.email) shopperIdentifiers.add(String(customer.email).trim().toLowerCase());
    if (shopifyCustomerId) {
      const raw = String(shopifyCustomerId).trim().toLowerCase();
      shopperIdentifiers.add(raw);
      shopperIdentifiers.add(raw.replace("gid://shopify/customer/", ""));
    }
    const notExcluded = (discount) => {
      if (!discount.excludedCustomerIdentifiers || discount.excludedCustomerIdentifiers.length === 0) return true;
      return !discount.excludedCustomerIdentifiers.some((id) => shopperIdentifiers.has(id));
    };

    automatic = automatic.filter((d) => groupEligible(d) && notExcluded(d));
    coupons = coupons.filter((d) => groupEligible(d) && notExcluded(d));

    // Usage-limit counts (Discount.usageLimitPerCustomer) — counted from real
    // redemption rows rather than a running counter so a cancelled/edited
    // order can't leave the count wrong. Only queried for discounts that
    // actually cap usage, and only once we know who the shopper is.
    let usageCounts = {};
    if (shopifyCustomerId) {
      const limited = [...automatic, ...coupons].filter((d) => d.usageLimitPerCustomer != null);
      if (limited.length) {
        const counted = await DiscountRedemption.aggregate([
          {
            $match: {
              shop,
              shopifyCustomerId: String(shopifyCustomerId),
              discount: { $in: limited.map((d) => d._id) },
            },
          },
          { $group: { _id: "$discount", count: { $sum: 1 } } },
        ]);
        usageCounts = Object.fromEntries(counted.map((c) => [String(c._id), c.count]));
      }
    }

    const withUsage = (discount) => {
      const obj = discount.toObject();
      obj.usedByCustomer = usageCounts[String(discount._id)] || 0;
      return obj;
    };

    // docs.sparklayer.io/discounts: "The coupon code box will only show for
    // your customers if there is an 'active' discount code that is
    // 'enabled'" — independent of whether a specific code was requested
    // above, so the storefront can decide whether to render the input at all.
    const hasCoupons = await Discount.exists({
      shop,
      status: "active",
      method: "coupon",
      ...scheduleFilter,
    });

    res.status(200).json({
      automatic: automatic.map(withUsage),
      coupons: coupons.map(withUsage),
      hasCoupons: !!hasCoupons,
    });
  } catch (err) {
    next(err);
  }
}

// Called from the checkout proxy right after a discount is actually applied
// to an order, so usage-limit counts above can be enforced going forward.
async function recordDiscountRedemptions(req, res, next) {
  try {
    const { shop, shopifyCustomerId, discountIds, orderId, preDiscountTotal, currency, savings } = req.body;

    if (!shop || !shopifyCustomerId || !Array.isArray(discountIds) || discountIds.length === 0) {
      return res.status(400).json({ message: "shop, shopifyCustomerId and discountIds are required" });
    }

    const validIds = discountIds.filter((id) => mongoose.isValidObjectId(id));

    // docs.sparklayer.io/discounts "Data Tracking" — couponCode is resolved
    // here from the Discount doc (rather than trusted from the caller) so a
    // redemption row always reflects a real saved code for that discount.
    const discountDocs = validIds.length
      ? await Discount.find({ _id: { $in: validIds } }).select("method couponCodes").lean()
      : [];
    const discountById = Object.fromEntries(discountDocs.map((d) => [String(d._id), d]));

    const rows = validIds.map((id) => {
      const doc = discountById[id];
      const savingsAmount = savings && savings[id] != null ? Number(savings[id]) : null;
      return {
        shop,
        discount: id,
        shopifyCustomerId: String(shopifyCustomerId),
        orderId,
        preDiscountTotal: preDiscountTotal != null ? Number(preDiscountTotal) : null,
        currency: currency || null,
        savingsAmount: Number.isFinite(savingsAmount) ? savingsAmount : null,
        couponCode: doc?.method === "coupon" ? doc.couponCodes?.[0] || null : null,
      };
    });

    if (rows.length) {
      await DiscountRedemption.insertMany(rows);
    }

    res.status(201).json({ recorded: rows.length });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getDiscounts,
  getDiscount,
  getDiscountRedemptionSummary,
  createDiscount,
  updateDiscount,
  deleteDiscount,
  duplicateDiscount,
  reorderDiscountPriorities,
  getActiveDiscounts,
  recordDiscountRedemptions,
};
