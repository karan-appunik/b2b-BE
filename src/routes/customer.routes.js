const express = require("express");

const {
  getCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  addCustomerAddress,
  mergeCustomerInto,
} = require("../controllers/customer.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.route("/").get(getCustomers).post(createCustomer);
router.route("/:id").get(getCustomer).put(updateCustomer).delete(deleteCustomer);
router.route("/:id/addresses").post(addCustomerAddress);
router.post("/:id/merge", mergeCustomerInto);

module.exports = router;
