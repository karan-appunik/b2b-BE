const express = require("express");

const { searchB2bCustomers } = require("../controllers/customer.controller");
const { createContext, readCurrentContext, exitContext } = require("../controllers/agentContext.controller");
const { createOverride } = require("../controllers/override.controller");
const quoteController = require("../controllers/quote.controller");
const v1 = require("../controllers/v1.controller");
const { protectInternal } = require("../middleware/internal.middleware");

// The specification's endpoint catalogue (§7.2), under the paths it names.
// Each one runs the same code as the internal API, so behaviour and checks are
// identical. The caller is the storefront's server (it proves itself with the
// internal key) and names the agent; the context may be given in the
// X-Context-Id header.
const router = express.Router();

router.use(protectInternal);

router.use((req, res, next) => {
  const header = req.get("x-context-id");
  if (header) {
    if (req.body && typeof req.body === "object" && req.body.contextId === undefined) req.body.contextId = header;
    if (req.query.contextId === undefined) req.query.contextId = header;
  }
  next();
});

router.get("/agent/customers", searchB2bCustomers);
router.post("/agent/contexts", createContext);
router.delete("/agent/contexts/:id", exitContext);
router.get("/context", readCurrentContext);

router.post("/carts", v1.createOrResumeCart);
router.post("/carts/:id/items", v1.addCartItem);
router.post("/carts/:id/overrides", createOverride);
router.post("/carts/:id/validate", v1.validateCartEndpoint);

router.post("/quotes", quoteController.createQuote);
router.post("/quotes/:id/submit-approval", quoteController.submitQuote);
router.post("/quotes/:id/send", quoteController.sendQuote);
router.post("/quotes/:id/accept", (req, res, next) => {
  req.body.action = "accept";
  return quoteController.respond(req, res, next);
});
router.post("/quotes/:id/convert", quoteController.markConverted);

router.get("/agent/audit", v1.agentAudit);

// The catalogue and order creation live in Shopify and the storefront server
// (prices, stock, tax, draft orders), not in this service.
const servedByStorefront = (req, res) =>
  res.status(501).json({
    code: "SERVED_BY_STOREFRONT",
    message: "This is served by the storefront (Shopify): /apps/sparklayer/variant-search and /apps/sparklayer/checkout",
  });
router.get("/catalog/products", servedByStorefront);
router.post("/orders", servedByStorefront);

module.exports = router;
