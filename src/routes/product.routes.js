const express = require("express");

const {
  searchProducts,
  getProducts,
  getProduct,
  getProductPricing,
  createProduct,
  updateProduct,
  deleteProduct,
  bulkImportProducts,
} = require("../controllers/product.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.route("/").get(getProducts).post(createProduct);
router.post("/bulk", bulkImportProducts);
router.get("/search", searchProducts);
router.get("/:id/pricing", getProductPricing);
router.route("/:id").get(getProduct).put(updateProduct).delete(deleteProduct);

module.exports = router;
