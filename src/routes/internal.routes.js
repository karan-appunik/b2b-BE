const express = require("express");

const {
  bulkImportProducts,
  deleteProductsByShopifyProduct,
  cleanupRemovedProducts,
} = require("../controllers/product.controller");
const {
  bulkImportCustomers,
  deleteCustomersByShopifyCustomer,
  cleanupRemovedCustomers,
} = require("../controllers/customer.controller");
const { protectInternal } = require("../middleware/internal.middleware");

const router = express.Router();

router.use(protectInternal);

router.post("/products/sync", bulkImportProducts);
router.post("/products/delete-by-shopify-product", deleteProductsByShopifyProduct);
router.post("/products/cleanup", cleanupRemovedProducts);

router.post("/customers/sync", bulkImportCustomers);
router.post("/customers/delete-by-shopify-customer", deleteCustomersByShopifyCustomer);
router.post("/customers/cleanup", cleanupRemovedCustomers);

module.exports = router;
