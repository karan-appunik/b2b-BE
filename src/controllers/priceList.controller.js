const fs = require("fs");
const path = require("path");
const PriceList = require("../models/priceList.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const priceListService = require("../services/priceList.service");

// SparkLayer-style tag model: every B2B customer gets this fixed base tag
// (granting wholesale pricing at checkout) plus their CustomerGroup's own
// shopifyTag — not a tag per price list. See customerGroup.model.js.
const B2B_BASE_TAG = "b2b";

// admin-frontend's dev port changes on every restart (Shopify CLI assigns it
// dynamically). admin-frontend/vite.config.ts writes its current port here on
// every start, so we read it fresh on every push instead of relying on a
// hardcoded ADMIN_FRONTEND_URL in .env that goes stale between restarts.
// Only trust this file outside production — a deployed backend must always
// use ADMIN_FRONTEND_URL.
function getAdminFrontendUrl() {
  if (process.env.NODE_ENV !== "production") {
    try {
      const filePath = path.resolve(__dirname, "../../.dev-admin-url.json");
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (data.url) return data.url;
    } catch {
      // fall through to env var
    }
  }
  return process.env.ADMIN_FRONTEND_URL;
}

async function getPriceLists(req, res, next) {
  try {
    const shop = req.user.shop;
    const priceLists = await PriceList.find({ shop }).sort({ createdAt: -1 });
    const customerCounts = await Customer.aggregate([
      { $match: { shop, priceList: { $ne: null } } },
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
    const shop = req.user.shop;
    const priceList = await PriceList.findOne({ _id: req.params.id, shop }).populate(
      "items.product",
      "name sku msrp"
    );

    if (!priceList) {
      return res.status(404).json({ message: "Price list not found" });
    }

    const customers = await Customer.find({ shop, priceList: priceList._id });

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
      shop: req.user.shop,
    });

    res.status(201).json(priceList);
  } catch (err) {
    next(err);
  }
}

async function updatePriceList(req, res, next) {
  try {
    const { name, description, status, pricingType, automaticPricing } = req.body;
    const priceList = await PriceList.findOneAndUpdate(
      { _id: req.params.id, shop: req.user.shop },
      { name, description, status, pricingType, automaticPricing },
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
    const shop = req.user.shop;
    const priceList = await PriceList.findOneAndDelete({ _id: req.params.id, shop });

    if (!priceList) {
      return res.status(404).json({ message: "Price list not found" });
    }

    await priceListService.cascadeUnassignOnDelete(priceList._id, shop);

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

    const priceList = await priceListService.replaceItems(req.params.id, items, req.user.shop);

    if (!priceList) {
      return res.status(404).json({ message: "Price list not found" });
    }

    const shopifySync = await autoSyncToShopify(priceList);

    res.status(200).json({ ...priceList.toObject(), shopifySync });
  } catch (err) {
    next(err);
  }
}

async function upsertItemForProduct(req, res, next) {
  try {
    const { price, minQuantity, unitOfMeasure, tiers } = req.body;

    if (price === undefined || Number.isNaN(Number(price))) {
      return res.status(400).json({ message: "price is required" });
    }

    const priceList = await priceListService.upsertItemForProduct(
      req.params.id,
      req.params.productId,
      { price: Number(price), minQuantity: Number(minQuantity) || 1, unitOfMeasure, tiers },
      req.user.shop
    );

    if (!priceList) {
      return res.status(404).json({ message: "Price list not found" });
    }

    const shopifySync = await autoSyncToShopify(priceList);

    res.status(200).json({ ...priceList.toObject(), shopifySync });
  } catch (err) {
    next(err);
  }
}

async function removeItemForProduct(req, res, next) {
  try {
    const priceList = await priceListService.removeItemForProduct(
      req.params.id,
      req.params.productId,
      req.user.shop
    );

    if (!priceList) {
      return res.status(404).json({ message: "Price list not found" });
    }

    const shopifySync = await autoSyncToShopify(priceList);

    res.status(200).json({ ...priceList.toObject(), shopifySync });
  } catch (err) {
    next(err);
  }
}

async function performShopifyPush(priceListId, shop) {
  const priceList = await PriceList.findOne({ _id: priceListId, shop }).populate(
    "items.product",
    "shopifyVariantId msrp name",
  );

  if (!priceList) {
    return { ok: false, statusCode: 404, message: "Price list not found" };
  }

  if (priceList.pricingType !== "manual") {
    return {
      ok: false,
      statusCode: 400,
      message: "Only manual pricing price lists can be pushed to Shopify",
    };
  }

  const pricedItems = priceList.items.filter((item) => item.product?.shopifyVariantId);

  if (pricedItems.length === 0) {
    return {
      ok: false,
      statusCode: 400,
      message: "None of this price list's products are linked to Shopify",
    };
  }

  const prices = pricedItems.map((item) => ({
    variantId: item.product.shopifyVariantId,
    amount: String(item.price),
    // Full quantity-break schedule for this variant on this price list —
    // admin-frontend stores this on the wholesale_price metafield so
    // checkout/storefront can pick the right tier for the ordered quantity.
    tiers: [
      { minQuantity: item.minQuantity || 1, price: item.price },
      ...(item.tiers || []).map((t) => ({ minQuantity: t.minQuantity, price: t.price })),
    ].sort((a, b) => a.minQuantity - b.minQuantity),
  }));

  const currentVariantIds = prices.map((p) => p.variantId);

  const customers = await Customer.find({
    shop: priceList.shop,
    priceList: priceList._id,
    shopifyCustomerId: { $exists: true, $ne: null },
  });
  const currentCustomerIds = customers.map((c) => c.shopifyCustomerId);
  const previousCustomerIds = priceList.shopifyPushedCustomerIds || [];
  const addCustomerIds = currentCustomerIds.filter((id) => !previousCustomerIds.includes(id));
  const removeCustomerIds = previousCustomerIds.filter(
    (id) => !currentCustomerIds.includes(id),
  );

  const adminFrontendUrl = getAdminFrontendUrl();
  if (!adminFrontendUrl) {
    return { ok: false, statusCode: 500, message: "ADMIN_FRONTEND_URL is not configured" };
  }

  const pushRes = await fetch(`${adminFrontendUrl}/internal/price-lists/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-api-key": process.env.INTERNAL_API_KEY,
    },
    body: JSON.stringify({
      shop: priceList.shop,
      priceListName: priceList.name,
      currency: priceList.currency,
      tag: B2B_BASE_TAG,
      prices,
      previousVariantIds: priceList.shopifyPushedVariantIds || [],
      addCustomerIds,
      removeCustomerIds,
    }),
  });

  const result = await pushRes.json();

  if (!pushRes.ok || result.error) {
    priceList.shopifyPushError = result.error || result.message || "Push to Shopify failed";
    await priceList.save();
    return { ok: false, statusCode: 400, message: priceList.shopifyPushError };
  }

  // Customers whose tag add/remove call failed on Shopify's side aren't
  // actually tagged yet — excluding them here (instead of trusting
  // currentCustomerIds blindly) means the next push retries them, rather
  // than silently treating a failed tag write as done forever.
  const failedTagCustomerIds = new Set(result.failedTagCustomerIds || []);
  if (failedTagCustomerIds.size > 0) {
    console.error(
      `[priceList] tag sync failed for ${failedTagCustomerIds.size} customer(s) on "${priceList.name}" — will retry on next push`,
      [...failedTagCustomerIds],
    );
  }

  priceList.shopifyPushedVariantIds = currentVariantIds;
  priceList.shopifyPushedCustomerIds = currentCustomerIds.filter(
    (id) => !failedTagCustomerIds.has(id),
  );
  // shopifySegmentId / shopifyItemDiscounts are no longer written — wholesale
  // pricing is enforced at checkout time from the wholesale_price metafield
  // (see apps.sparklayer.checkout.tsx) rather than a Shopify Segment +
  // Automatic Discount. The schema fields are left in place as harmless
  // legacy columns for price lists pushed before this change.
  priceList.shopifyPushedAt = new Date();
  priceList.shopifyPushError = undefined;
  await priceList.save();

  return { ok: true, priceList };
}

async function autoSyncToShopify(priceList) {
  if (priceList.pricingType !== "manual") {
    return { attempted: false };
  }

  const result = await performShopifyPush(priceList._id, priceList.shop);

  if (!result.ok && result.statusCode === 400 && /linked to Shopify/.test(result.message)) {
    return { attempted: false };
  }

  return { attempted: true, ok: result.ok, message: result.ok ? undefined : result.message };
}

async function bulkImportPriceLists(req, res, next) {
  try {
    const shop = req.user.shop;
    const { rows } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: "rows must be a non-empty array" });
    }

    const validRows = rows.filter(
      (r) => r.priceListSlug && r.sku && !Number.isNaN(Number(r.price)),
    );

    if (validRows.length === 0) {
      return res.status(400).json({ message: "No valid rows to import" });
    }

    const skus = [...new Set(validRows.map((r) => r.sku))];
    const products = await Product.find({ sku: { $in: skus }, shop });
    const productIdBySku = new Map(products.map((p) => [p.sku, String(p._id)]));

    const rowsBySlug = new Map();
    for (const row of validRows) {
      const slug = slugify(row.priceListSlug);
      if (!rowsBySlug.has(slug)) rowsBySlug.set(slug, []);
      rowsBySlug.get(slug).push(row);
    }

    let priceListsCreated = 0;
    let priceListsUpdated = 0;
    let itemsUpdated = 0;
    const affectedPriceLists = [];

    for (const [handle, priceListRows] of rowsBySlug) {
      let priceList = await PriceList.findOne({ handle, shop });

      if (!priceList) {
        priceList = await PriceList.create({
          name: handle,
          handle,
          currency: priceListRows[0].currency || "USD",
          status: "draft",
          pricingType: "manual",
          shop,
        });
        priceListsCreated += 1;
      } else {
        priceListsUpdated += 1;
      }

      const itemsByProduct = new Map(
        priceList.items.map((item) => [String(item.product), item.price]),
      );

      for (const row of priceListRows) {
        const productId = productIdBySku.get(row.sku);
        if (!productId) continue;
        itemsByProduct.set(productId, Number(row.price));
        itemsUpdated += 1;
      }

      priceList.items = [...itemsByProduct.entries()].map(([product, price]) => ({
        product,
        price,
      }));
      await priceList.save();
      affectedPriceLists.push(priceList);
    }

    for (const priceList of affectedPriceLists) {
      await autoSyncToShopify(priceList);
    }

    res.status(200).json({
      priceListsCreated,
      priceListsUpdated,
      itemsUpdated,
    });
  } catch (err) {
    next(err);
  }
}

async function retryFailedShopifyPushes() {
  const failed = await PriceList.find({
    pricingType: "manual",
    shopifyPushError: { $exists: true, $ne: null },
  });

  for (const priceList of failed) {
    const result = await performShopifyPush(priceList._id, priceList.shop);
    if (result.ok) {
      console.log(`[priceList] retry push succeeded for "${priceList.name}"`);
    } else {
      console.error(`[priceList] retry push failed for "${priceList.name}": ${result.message}`);
    }
  }

  return { retried: failed.length };
}

async function pushToShopify(req, res, next) {
  try {
    const result = await performShopifyPush(req.params.id, req.user.shop);

    if (!result.ok) {
      return res.status(result.statusCode).json({ message: result.message });
    }

    res.status(200).json(result.priceList);
  } catch (err) {
    next(err);
  }
}

async function assignCustomers(req, res, next) {
  try {
    const shop = req.user.shop;
    const { customerIds } = req.body;

    if (!Array.isArray(customerIds)) {
      return res.status(400).json({ message: "customerIds must be an array" });
    }

    const priceList = await PriceList.findOne({ _id: req.params.id, shop });

    if (!priceList) {
      return res.status(404).json({ message: "Price list not found" });
    }

    const customers = await priceListService.assignCustomers(req.params.id, customerIds, shop);
    const shopifySync = await autoSyncToShopify(priceList);

    res.status(200).json({ customers, shopifySync });
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
  upsertItemForProduct,
  removeItemForProduct,
  assignCustomers,
  pushToShopify,
  autoSyncToShopify,
  retryFailedShopifyPushes,
  bulkImportPriceLists,
};
