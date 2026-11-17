const express = require("express");
const delegationController = require("../controllers/delegation.controller");
const offlineController = require("../controllers/offlineCapture.controller");

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
const {
  createContext,
  readCurrentContext,
  validateContextById,
  exitContext,
  authorizeAction,
  refreshContextById,
} = require("../controllers/agentContext.controller");
const { getCurrentCart, saveCurrentCart } = require("../controllers/agentCart.controller");
const {
  beginOperation,
  completeOperation,
  releaseOperation,
} = require("../controllers/idempotency.controller");
const { idempotent } = require("../services/idempotency.service");
const { getStatus, enroll, verifyCode } = require("../controllers/agentMfa.controller");
const {
  createOverride,
  listOverrides,
  cancelOverride,
  usableOverrides,
  markApplied,
  listApprovals,
  decideApproval,
} = require("../controllers/override.controller");
const quoteController = require("../controllers/quote.controller");
const paymentLinkController = require("../controllers/paymentLink.controller");
const customerCreateController = require("../controllers/customerCreate.controller");
const approvalLinkController = require("../controllers/approvalLink.controller");
const shoppingListController = require("../controllers/shoppingList.controller");
const notificationController = require("../controllers/notification.controller");
const v1Controller = require("../controllers/v1.controller");
const { getAgentDashboard, setPin } = require("../controllers/agentDashboard.controller");
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

router.get("/agent/dashboard", getAgentDashboard);
router.post("/agent/pins", setPin);
router.get("/agent/carts/current", getCurrentCart);
router.put("/agent/carts/current", saveCurrentCart);
router.get("/agent/mfa/status", getStatus);
router.post("/agent/mfa/enroll", enroll);
router.post("/agent/mfa/verify", verifyCode);
router.post("/agent/overrides", createOverride);
router.get("/agent/overrides", listOverrides);
router.get("/agent/overrides/usable", usableOverrides);
router.post("/agent/overrides/applied", markApplied);
router.post("/agent/overrides/:id/cancel", cancelOverride);
router.get("/agent/approvals", listApprovals);
router.post("/agent/approvals/:id/decision", decideApproval);
router.post("/agent/quotes", quoteController.createQuote);
router.get("/agent/quotes", quoteController.listOwned);
router.get("/agent/quote-approvals", quoteController.listApprovals);
router.post("/agent/quote-approvals/:id/decision", quoteController.decideApproval);
router.get("/agent/delegations", delegationController.agentList);
router.post("/agent/delegations", delegationController.agentCreate);
router.post("/agent/delegations/:id/revoke", delegationController.agentRevoke);
router.get("/agent/delegate-candidates", delegationController.agentCandidates);
router.post("/agent/offline-captures", offlineController.receive);
router.get("/agent/offline-captures", offlineController.list);
router.post("/agent/offline-captures/:id/resolve", offlineController.resolve);
router.get("/agent/quotes/:id", quoteController.getQuote);
router.put("/agent/quotes/:id", quoteController.editQuote);
router.post("/agent/quotes/:id/submit", quoteController.submitQuote);
router.post("/agent/quotes/:id/send", quoteController.sendQuote);
router.post("/agent/quotes/:id/withdraw", quoteController.withdrawQuote);
router.post("/agent/quotes/:id/revise", quoteController.reviseQuote);
router.post("/agent/quotes/:id/duplicate", quoteController.duplicateQuote);
router.post("/agent/quotes/:id/converted", quoteController.markConverted);
router.get("/customer/quotes", quoteController.listForBuyer);
router.get("/customer/quotes/:id", quoteController.getForBuyer);
router.post("/customer/quotes/:id/respond", quoteController.respond);
router.get("/agent/customer-summary", v1Controller.customerSummary);
router.post("/agent/order-failed", async (req, res, next) => {
  try {
    const { shop, agentShopifyCustomerId, customerId, key, code, message } = req.body;
    res.status(200).json(await require("../services/orderFailure.service").recordFailure({ shop, agentShopifyCustomerId, customerId, key, code, message }));
  } catch (err) {
    next(err);
  }
});
router.get("/agent/module-settings", async (req, res, next) => {
  try {
    const settings = await require("../services/override.service").getSettings(req.query.shop);
    res.status(200).json({
      inventoryMode: settings.inventoryMode || "informational",
      paymentLinkValidHours: settings.paymentLinkValidHours,
      substitutes: (settings.substitutes || []).map((s) => ({ fromSku: s.fromSku, toSku: s.toSku, note: s.note || null })),
      offlineCaptureEnabled: settings.offlineCaptureEnabled === true,
      offlineCaptureDays: settings.offlineCaptureDays || 7,
    });
  } catch (err) {
    next(err);
  }
});
router.get("/agent/notifications", notificationController.list);
router.post("/agent/notifications/read", notificationController.read);
router.get("/shopping-lists", shoppingListController.list);
router.post("/shopping-lists", shoppingListController.create);
router.post("/shopping-lists/:id/delete", shoppingListController.remove);
router.post("/agent/approval-links/open", approvalLinkController.open);
router.post("/agent/approval-links/decide", approvalLinkController.decide);
router.post("/agent/customers/check", customerCreateController.check);
router.post("/agent/customers/record", customerCreateController.record);
router.post("/agent/addresses/record", customerCreateController.recordAddress);
router.post("/agent/payment-links", paymentLinkController.createLink);
router.get("/agent/payment-links", paymentLinkController.listOwned);
router.post("/agent/payment-links/:id/revoke", paymentLinkController.revokeOwned);
router.post("/customer/payment-links/resolve", paymentLinkController.resolveForBuyer);
router.post("/payment-links/paid", paymentLinkController.markPaid);
router.post("/payment-links/order-changed", paymentLinkController.orderChanged);
router.post("/agent/authorize", authorizeAction);
router.post("/agent/contexts", idempotent("agent.contexts"), createContext);
router.get("/agent/contexts/current", readCurrentContext);
router.post("/agent/contexts/:id/refresh", refreshContextById);
router.get("/agent/contexts/:id/validate", validateContextById);
router.delete("/agent/contexts/:id", exitContext);

router.post("/idempotency/begin", beginOperation);
router.post("/idempotency/complete", completeOperation);
router.post("/idempotency/release", releaseOperation);

router.post("/auth/sso", ssoLogin);

router.get("/discounts/active", getActiveDiscounts);
router.post("/discounts/redemptions", recordDiscountRedemptions);

router.post("/orders/sync", bulkImportOrders);

router.get("/forms/:id/public", getPublicForm);
router.post("/forms/:id/submit", submitFormEntry);
router.post("/forms/:id/upload", uploadMiddleware.single("file"), uploadFormFile);

module.exports = router;
