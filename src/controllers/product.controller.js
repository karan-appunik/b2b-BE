const Product = require("../models/product.model");

async function getProducts(req, res, next) {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.status(200).json(products);
  } catch (err) {
    next(err);
  }
}

async function getProduct(req, res, next) {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.status(200).json(product);
  } catch (err) {
    next(err);
  }
}

async function createProduct(req, res, next) {
  try {
    const { name, sku, msrp } = req.body;
    const product = await Product.create({ name, sku, msrp });
    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
}

async function updateProduct(req, res, next) {
  try {
    const { name, sku, msrp } = req.body;
    const product = await Product.findByIdAndUpdate(
      req.params.id,
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
    const product = await Product.findByIdAndDelete(req.params.id);

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

    const ops = products
      .filter((p) => p.sku && p.name && p.msrp !== undefined && !Number.isNaN(Number(p.msrp)))
      .map((p) => {
        const setFields = { name: p.name, sku: p.sku, msrp: Number(p.msrp) };
        if (p.shopifyProductId) setFields.shopifyProductId = String(p.shopifyProductId);
        if (p.shopifyVariantId) setFields.shopifyVariantId = String(p.shopifyVariantId);

        return {
          updateOne: {
            filter: p.shopifyVariantId
              ? { shopifyVariantId: String(p.shopifyVariantId) }
              : { sku: p.sku },
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
    const { shopifyProductId } = req.body;

    if (!shopifyProductId) {
      return res.status(400).json({ message: "shopifyProductId is required" });
    }

    const result = await Product.deleteMany({ shopifyProductId: String(shopifyProductId) });

    res.status(200).json({ deleted: result.deletedCount });
  } catch (err) {
    next(err);
  }
}

async function cleanupRemovedProducts(req, res, next) {
  try {
    const { activeVariantIds } = req.body;

    if (!Array.isArray(activeVariantIds)) {
      return res.status(400).json({ message: "activeVariantIds must be an array" });
    }

    // Delete any product that has a shopifyProductId but is not in the active list
    const result = await Product.deleteMany({
      shopifyProductId: { $exists: true, $ne: null },
      shopifyVariantId: { $nin: activeVariantIds },
    });

    res.status(200).json({ deleted: result.deletedCount });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  bulkImportProducts,
  deleteProductsByShopifyProduct,
  cleanupRemovedProducts,
};
