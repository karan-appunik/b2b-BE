const express = require("express");

const { getAuditEvents, verifyAuditTrail, exportAuditEvents } = require("../controllers/audit.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.get("/", getAuditEvents);
router.get("/export", exportAuditEvents);
router.get("/verify", verifyAuditTrail);

module.exports = router;
