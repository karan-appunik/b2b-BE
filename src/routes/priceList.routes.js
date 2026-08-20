const express = require("express");

const {
  getPriceLists,
  getPriceList,
  createPriceList,
  updatePriceList,
  deletePriceList,
  upsertItems,
  assignCustomers,
  pushToShopify,
  bulkImportPriceLists,
} = require("../controllers/priceList.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.route("/").get(getPriceLists).post(createPriceList);
router.post("/bulk", bulkImportPriceLists);
router.route("/:id").get(getPriceList).put(updatePriceList).delete(deletePriceList);
router.put("/:id/items", upsertItems);
router.put("/:id/customers", assignCustomers);
router.post("/:id/push-to-shopify", pushToShopify);

module.exports = router;
