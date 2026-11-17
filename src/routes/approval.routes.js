const express = require("express");

const {
  listApprovals,
  decideApproval,
  listPolicies,
  createPolicy,
  updatePolicy,
  deletePolicy,
  getSettings,
  updateSettings,
} = require("../controllers/approval.controller");
const quoteController = require("../controllers/quote.controller");
const delegationController = require("../controllers/delegation.controller");
const paymentLinkController = require("../controllers/paymentLink.controller");
const customerCreateController = require("../controllers/customerCreate.controller");
const reportController = require("../controllers/report.controller");
const territoryController = require("../controllers/territory.controller");
const agentAdmin = require("../services/agentOverview.service");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

// Mounted at /api, so `protect` is applied route by route: a router-wide
// `router.use(protect)` here would also run for every other /api path.
const feedController = require("../controllers/integrationFeed.controller");
router.get("/integrations/crm/accounts", protect, feedController.crmAccounts);
router.get("/integrations/crm/quotes", protect, feedController.crmQuotes);
router.get("/integrations/commission-feed", protect, feedController.commission);
router.get("/delegations", protect, delegationController.list);
router.post("/delegations", protect, delegationController.create);
router.post("/delegations/:id/revoke", protect, delegationController.revoke);
router.get("/approvals", protect, listApprovals);
router.post("/approvals/:id/decision", protect, decideApproval);

router.route("/approval-policies").get(protect, listPolicies).post(protect, createPolicy);
router.route("/approval-policies/:id").put(protect, updatePolicy).delete(protect, deletePolicy);

router.get("/quotes", protect, quoteController.listForMerchant);
router.get("/quotes/:id", protect, quoteController.getForMerchant);
router.post("/quotes/:id/decision", protect, quoteController.decideForMerchant);

router.get("/agents/overview", protect, async (req, res, next) => {
  try {
    res.status(200).json({ agents: await agentAdmin.overview(req.user.shop) });
  } catch (err) {
    next(err);
  }
});
router.get("/agents/export", protect, async (req, res, next) => {
  try {
    const rows = await agentAdmin.overview(req.user.shop);
    require("../services/audit.service")
      .recordAudit({ shop: req.user.shop, actorType: "merchant_user", actor: req.user._id, action: "agents.exported", objectType: "agents", metadata: { rows: rows.length } })
      .catch(() => {});
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="sales-agents-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.status(200).send(agentAdmin.toCsv(rows));
  } catch (err) {
    next(err);
  }
});
router.get("/territory-rules", protect, territoryController.list);
router.post("/territory-rules", protect, territoryController.create);
router.post("/territory-rules/apply", protect, territoryController.apply);
router.put("/territory-rules/:id", protect, territoryController.update);
router.delete("/territory-rules/:id", protect, territoryController.remove);
router.get("/reports/sales-agents", protect, reportController.sales);
router.get("/reports/operations", protect, reportController.operations);
router.get("/provisional-customers", protect, customerCreateController.list);
router.post("/provisional-customers/:id/approve", protect, customerCreateController.approve);
router.get("/payment-links", protect, paymentLinkController.listForMerchant);
router.post("/payment-links/:id/revoke", protect, paymentLinkController.revokeForMerchant);

router.route("/agent-settings").get(protect, getSettings).put(protect, updateSettings);

module.exports = router;
