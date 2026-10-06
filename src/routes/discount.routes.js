const express = require("express");

const {
  getDiscounts,
  getDiscount,
  getDiscountRedemptionSummary,
  createDiscount,
  updateDiscount,
  deleteDiscount,
  duplicateDiscount,
  reorderDiscountPriorities,
} = require("../controllers/discount.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.route("/").get(getDiscounts).post(createDiscount);
router.put("/priorities", reorderDiscountPriorities);
router.route("/:id").get(getDiscount).put(updateDiscount).delete(deleteDiscount);
router.get("/:id/redemptions/summary", getDiscountRedemptionSummary);
router.post("/:id/duplicate", duplicateDiscount);

module.exports = router;
