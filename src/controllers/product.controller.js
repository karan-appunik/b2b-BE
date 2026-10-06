const Product = require("../models/product.model");
const PriceList = require("../models/priceList.model");

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Groups matching variants by their parent Shopify product so, e.g., searching
// one variant's SKU returns all sibling variants under the same product —
// matching how the SparkLayer Price Editor's product search behaves.
async function searchProducts(req, res, next) {
  try {
    const q = (req.query.q || "").trim();

    if (!q) {
      return res.status(200).json([]);
    }

    const shop = req.user.shop;
    const pattern = new RegExp(escapeRegex(q), "i");

    const matches = await Product.find({
      shop,
      $or: [
        { name: pattern },
        { sku: pattern },
        { productTitle: pattern },
        { variantTitle: pattern },
        { productHandle: pattern },
        { shopifyProductId: pattern },
        { shopifyVariantId: pattern },
      ],
    }).lean();

    if (matches.length === 0) {
      return res.status(200).json([]);
    }

    const groupedProductIds = [
      ...new Set(matches.filter((p) => p.shopifyProductId).map((p) => p.shopifyProductId)),
    ];
    const standaloneIds = matches.filter((p) => !p.shopifyProductId).map((p) => p._id);

    const [siblingVariants, standaloneProducts] = await Promise.all([
      groupedProductIds.length
        ? Product.find({ shop, shopifyProductId: { $in: groupedProductIds } }).lean()
        : [],
      standaloneIds.length ? Product.find({ shop, _id: { $in: standaloneIds } }).lean() : [],
    ]);

    const groups = new Map();

    for (const variant of siblingVariants) {
      const key = variant.shopifyProductId;
      
      let pTitle = variant.productTitle;
      let vTitle = variant.variantTitle;
      if (!pTitle && variant.name) {
        const parts = variant.name.split(" - ");
        pTitle = parts[0];
        if (parts.length > 1 && !vTitle) {
          vTitle = parts[1];
        }
      }
      if (!pTitle) {
        pTitle = variant.name;
      }
      if (!vTitle) {
        vTitle = variant.variantTitle || "Default Title";
      }

      variant.parsedProductTitle = pTitle;
      variant.parsedVariantTitle = vTitle;

      if (!groups.has(key)) {
        groups.set(key, {
          id: key,
          title: pTitle,
          handle: variant.productHandle || null,
          image: variant.image || null,
          variants: [],
        });
      }
      groups.get(key).variants.push(variant);
    }

    for (const product of standaloneProducts) {
      let pTitle = product.productTitle;
      let vTitle = product.variantTitle;
      if (!pTitle && product.name) {
        const parts = product.name.split(" - ");
        pTitle = parts[0];
        if (parts.length > 1 && !vTitle) {
          vTitle = parts[1];
        }
      }
      if (!pTitle) {
        pTitle = product.name;
      }
      if (!vTitle) {
        vTitle = product.variantTitle || "Default Title";
      }

      product.parsedProductTitle = pTitle;
      product.parsedVariantTitle = vTitle;

      groups.set(product._id.toString(), {
        id: product._id,
        title: pTitle,
        handle: product.productHandle || null,
        image: product.image || null,
        variants: [product],
      });
    }

    const results = [...groups.values()]
      .map((group) => ({
        id: group.id,
        title: group.title,
        handle: group.handle,
        image: group.image,
        variantCount: group.variants.length,
        variants: group.variants
          .map((v) => ({
            id: v._id,
            sku: v.sku,
            variantTitle: v.parsedVariantTitle || v.variantTitle || "Default Title",
            msrp: v.msrp,
            image: v.image || null,
          }))
          .sort((a, b) => (a.sku || "").localeCompare(b.sku || "")),
      }))
      .sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    res.status(200).json(results);
  } catch (err) {
    next(err);
  }
}

async function getProducts(req, res, next) {
  try {
    const products = await Product.find({ shop: req.user.shop }).sort({ createdAt: -1 });
    res.status(200).json(products);
  } catch (err) {
    next(err);
  }
}

async function getProduct(req, res, next) {
  try {
    const product = await Product.findOne({ _id: req.params.id, shop: req.user.shop });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.status(200).json(product);
  } catch (err) {
    next(err);
  }
}

// Powers the Price Editor's per-variant page: the variant itself, its
// sibling variants (for the variant switcher), every price list that
// already prices this variant, the price lists that don't yet (for
// "Select a Price List"), and the read-only Shopify base price.
async function getProductPricing(req, res, next) {
  try {
    const shop = req.user.shop;
    const product = await Product.findOne({ _id: req.params.id, shop }).lean();

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const siblings = product.shopifyProductId
      ? await Product.find({ shop, shopifyProductId: product.shopifyProductId })
          .sort({ sku: 1 })
          .lean()
      : [product];

    const allPriceLists = await PriceList.find({ shop }).lean();

    const priceLists = [];
    const availablePriceLists = [];

    for (const pl of allPriceLists) {
      const item = pl.items.find((i) => String(i.product) === String(product._id));
      if (item) {
        priceLists.push({
          _id: pl._id,
          name: pl.name,
          handle: pl.handle,
          currency: pl.currency,
          pricingType: pl.pricingType,
          price: item.price,
          minQuantity: item.minQuantity || 1,
          unitOfMeasure: item.unitOfMeasure || "",
          tiers: item.tiers || [],
        });
      } else {
        availablePriceLists.push({
          _id: pl._id,
          name: pl.name,
          handle: pl.handle,
          currency: pl.currency,
        });
      }
    }

    res.status(200).json({
      product: {
        id: product._id,
        sku: product.sku,
        name: product.name,
        msrp: product.msrp,
        productTitle: product.productTitle || product.name,
        productHandle: product.productHandle || null,
        variantTitle: product.variantTitle || null,
        image: product.image || null,
        options: product.options || [],
        shopifyProductId: product.shopifyProductId || null,
        shopifyVariantId: product.shopifyVariantId || null,
        shopifyAdminUrl: product.shopifyProductId
          ? `https://${shop}/admin/products/${product.shopifyProductId.split("/").pop()}`
          : null,
      },
      variants: siblings.map((v) => ({
        id: v._id,
        sku: v.sku,
        variantTitle: v.variantTitle || null,
        shopifyVariantId: v.shopifyVariantId || null,
      })),
      priceLists,
      availablePriceLists,
      shopifyPrice: { currency: "USD", price: product.msrp },
    });
  } catch (err) {
    next(err);
  }
}

async function createProduct(req, res, next) {
  try {
    const { name, sku, msrp } = req.body;
    const product = await Product.create({ name, sku, msrp, shop: req.user.shop });
    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
}

async function updateProduct(req, res, next) {
  try {
    const { name, sku, msrp } = req.body;
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, shop: req.user.shop },
      { name, sku, msrp },
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.status(200).json(product);
  } catch (err) {
    next(err);
  }
}

async function deleteProduct(req, res, next) {
  try {
    const product = await Product.findOneAndDelete({ _id: req.params.id, shop: req.user.shop });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.status(200).json({ message: "Product deleted" });
  } catch (err) {
    next(err);
  }
}

async function bulkImportProducts(req, res, next) {
  try {
    const { products } = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ message: "products must be a non-empty array" });
    }

    const shop = req.user?.shop || req.body.shop;

    const ops = products
      .filter((p) => p.sku && p.name && p.msrp !== undefined && !Number.isNaN(Number(p.msrp)))
      .map((p) => {
        const setFields = { name: p.name, sku: p.sku, msrp: Number(p.msrp), shop };
        if (p.shopifyProductId) setFields.shopifyProductId = String(p.shopifyProductId);
        if (p.shopifyVariantId) setFields.shopifyVariantId = String(p.shopifyVariantId);
        if (p.productTitle) setFields.productTitle = String(p.productTitle);
        if (p.productHandle) setFields.productHandle = String(p.productHandle);
        if (p.variantTitle) setFields.variantTitle = String(p.variantTitle);
        if (p.image) setFields.image = String(p.image);
        if (Array.isArray(p.options) && p.options.length) {
          setFields.options = p.options.map((o) => ({ name: String(o.name), value: String(o.value) }));
        }

        return {
          updateOne: {
            filter: p.shopifyVariantId
              ? { shopifyVariantId: String(p.shopifyVariantId), shop }
              : { sku: p.sku, shop },
            update: { $set: setFields },
            upsert: true,
          },
        };
      });

    if (ops.length === 0) {
      return res.status(400).json({ message: "No valid rows to import" });
    }

    const result = await Product.bulkWrite(ops, { ordered: false });

    res.status(200).json({
      received: products.length,
      imported: ops.length,
      created: result.upsertedCount,
      updated: result.modifiedCount,
    });
  } catch (err) {
    next(err);
  }
}

async function deleteProductsByShopifyProduct(req, res, next) {
  try {
    const { shopifyProductId, shop } = req.body;

    if (!shopifyProductId) {
      return res.status(400).json({ message: "shopifyProductId is required" });
    }

    const result = await Product.deleteMany({ shopifyProductId: String(shopifyProductId), shop });

    res.status(200).json({ deleted: result.deletedCount });
  } catch (err) {
    next(err);
  }
}

async function cleanupRemovedProducts(req, res, next) {
  try {
    const { activeVariantIds, shop } = req.body;

    if (!Array.isArray(activeVariantIds)) {
      return res.status(400).json({ message: "activeVariantIds must be an array" });
    }

    // Delete any product that has a shopifyProductId but is not in the active list
    const result = await Product.deleteMany({
      shop,
      shopifyProductId: { $exists: true, $ne: null },
      shopifyVariantId: { $nin: activeVariantIds },
    });

    res.status(200).json({ deleted: result.deletedCount });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  searchProducts,
  getProducts,
  getProduct,
  getProductPricing,
  createProduct,
  updateProduct,
  deleteProduct,
  bulkImportProducts,
  deleteProductsByShopifyProduct,
  cleanupRemovedProducts,
};
