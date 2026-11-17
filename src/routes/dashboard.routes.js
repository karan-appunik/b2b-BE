const express = require("express");

const { getSyncHealth } = require("../controllers/dashboard.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.get("/sync-health", getSyncHealth);

module.exports = router;
