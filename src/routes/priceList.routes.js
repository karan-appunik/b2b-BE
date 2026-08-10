const express = require("express");

const {
  getPriceLists,
  getPriceList,
  createPriceList,
  updatePriceList,
  deletePriceList,
  upsertItems,
  assignCustomers,
} = require("../controllers/priceList.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.route("/").get(getPriceLists).post(createPriceList);
router.route("/:id").get(getPriceList).put(updatePriceList).delete(deletePriceList);
router.put("/:id/items", upsertItems);
router.put("/:id/customers", assignCustomers);

module.exports = router;
