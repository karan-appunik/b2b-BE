const express = require("express");

const { getOrders, getOrderStats } = require("../controllers/order.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.get("/", getOrders);
router.get("/stats", getOrderStats);

module.exports = router;
