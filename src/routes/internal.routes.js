const express = require("express");

const {
  bulkImportProducts,
  deleteProductsByShopifyProduct,
  cleanupRemovedProducts,
} = require("../controllers/product.controller");
const { bulkImportOrders } = require("../controllers/order.controller");
const {
  bulkImportCustomers,
  deleteCustomersByShopifyCustomer,
  cleanupRemovedCustomers,
  getAgentContext,
  searchB2bCustomers,
  getOrderLimits,
  getCreditInfo,
  chargeCredit,
} = require("../controllers/customer.controller");
const { getPublicForm, submitFormEntry, uploadFormFile } = require("../controllers/form.controller");
const { getActiveDiscounts, recordDiscountRedemptions } = require("../controllers/discount.controller");
const { ssoLogin } = require("../controllers/auth.controller");
const { protectInternal } = require("../middleware/internal.middleware");
const { uploadFormFile: uploadMiddleware } = require("../middleware/formUpload.middleware");

const router = express.Router();

router.use(protectInternal);

router.post("/products/sync", bulkImportProducts);
router.post("/products/delete-by-shopify-product", deleteProductsByShopifyProduct);
router.post("/products/cleanup", cleanupRemovedProducts);

router.post("/customers/sync", bulkImportCustomers);
router.post("/customers/delete-by-shopify-customer", deleteCustomersByShopifyCustomer);
router.post("/customers/cleanup", cleanupRemovedCustomers);
router.get("/customers/agent-context", getAgentContext);
router.get("/customers/search", searchB2bCustomers);
router.get("/customers/order-limits", getOrderLimits);
router.get("/customers/credit", getCreditInfo);
router.post("/customers/credit/charge", chargeCredit);

router.post("/auth/sso", ssoLogin);

router.get("/discounts/active", getActiveDiscounts);
router.post("/discounts/redemptions", recordDiscountRedemptions);

router.post("/orders/sync", bulkImportOrders);

router.get("/forms/:id/public", getPublicForm);
router.post("/forms/:id/submit", submitFormEntry);
router.post("/forms/:id/upload", uploadMiddleware.single("file"), uploadFormFile);

module.exports = router;
