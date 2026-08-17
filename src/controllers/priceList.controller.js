const fs = require("fs");
const path = require("path");
const PriceList = require("../models/priceList.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const priceListService = require("../services/priceList.service");

// admin-frontend's dev port changes on every restart (Shopify CLI assigns it
// dynamically). admin-frontend/vite.config.ts writes its current port here on
// every start, so we read it fresh on every push instead of relying on a
// hardcoded ADMIN_FRONTEND_URL in .env that goes stale between restarts.
function getAdminFrontendUrl() {
  try {
    const filePath = path.resolve(__dirname, "../../.dev-admin-url.json");
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (data.url) return data.url;
  } catch {
    // fall through to env var
  }
  return process.env.ADMIN_FRONTEND_URL;
}

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
    const { name, description, status, pricingType, automaticPricing } = req.body;
    const priceList = await PriceList.findByIdAndUpdate(
      req.params.id,
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

    const shopifySync = await autoSyncToShopify(priceList);

    res.status(200).json({ ...priceList.toObject(), shopifySync });
  } catch (err) {
    next(err);
  }
}

async function performShopifyPush(priceListId) {
  const priceList = await PriceList.findById(priceListId).populate(
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
  }));

  const discountByVariant = new Map(
    (priceList.shopifyItemDiscounts || []).map((d) => [d.variantId, d.shopifyDiscountId]),
  );

  const discountItems = pricedItems.map((item) => ({
    variantId: item.product.shopifyVariantId,
    productTitle: item.product.name,
    discountAmount: Number((item.product.msrp - item.price).toFixed(2)),
    shopifyDiscountId: discountByVariant.get(item.product.shopifyVariantId) || null,
  }));

  const currentVariantIds = prices.map((p) => p.variantId);
  const staleVariantIds = (priceList.shopifyPushedVariantIds || []).filter(
    (id) => !currentVariantIds.includes(id),
  );
  const removedDiscountIds = staleVariantIds
    .map((id) => discountByVariant.get(id))
    .filter(Boolean);

  const customers = await Customer.find({
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
      priceListName: priceList.name,
      currency: priceList.currency,
      tag: `sparklayer-${priceList.handle}`,
      prices,
      previousVariantIds: priceList.shopifyPushedVariantIds || [],
      addCustomerIds,
      removeCustomerIds,
      shopifySegmentId: priceList.shopifySegmentId || null,
      discountItems,
      removedDiscountIds,
    }),
  });

  const result = await pushRes.json();

  if (!pushRes.ok || result.error) {
    priceList.shopifyPushError = result.error || result.message || "Push to Shopify failed";
    await priceList.save();
    return { ok: false, statusCode: 400, message: priceList.shopifyPushError };
  }

  priceList.shopifyPushedVariantIds = currentVariantIds;
  priceList.shopifyPushedCustomerIds = currentCustomerIds;
  priceList.shopifySegmentId = result.shopifySegmentId || priceList.shopifySegmentId;
  priceList.shopifyItemDiscounts = (result.itemDiscountIds || []).map((d) => ({
    variantId: d.variantId,
    shopifyDiscountId: d.shopifyDiscountId,
  }));
  priceList.shopifyPushedAt = new Date();
  priceList.shopifyPushError = undefined;
  await priceList.save();

  return { ok: true, priceList };
}

async function autoSyncToShopify(priceList) {
  if (priceList.pricingType !== "manual") {
    return { attempted: false };
  }

  const result = await performShopifyPush(priceList._id);

  if (!result.ok && result.statusCode === 400 && /linked to Shopify/.test(result.message)) {
    return { attempted: false };
  }

  return { attempted: true, ok: result.ok, message: result.ok ? undefined : result.message };
}

async function bulkImportPriceLists(req, res, next) {
  try {
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
    const products = await Product.find({ sku: { $in: skus } });
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
      let priceList = await PriceList.findOne({ handle });

      if (!priceList) {
        priceList = await PriceList.create({
          name: handle,
          handle,
          currency: priceListRows[0].currency || "USD",
          status: "draft",
          pricingType: "manual",
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
    const result = await performShopifyPush(priceList._id);
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
    const result = await performShopifyPush(req.params.id);

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
    const { customerIds } = req.body;

    if (!Array.isArray(customerIds)) {
      return res.status(400).json({ message: "customerIds must be an array" });
    }

    const priceList = await PriceList.findById(req.params.id);

    if (!priceList) {
      return res.status(404).json({ message: "Price list not found" });
    }

    const customers = await priceListService.assignCustomers(req.params.id, customerIds);
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
  assignCustomers,
  pushToShopify,
  autoSyncToShopify,
  retryFailedShopifyPushes,
  bulkImportPriceLists,
};
