const express = require("express");

const {
  getCustomerGroups,
  getCustomerGroup,
  createCustomerGroup,
  updateCustomerGroup,
  deleteCustomerGroup,
} = require("../controllers/customerGroup.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.route("/").get(getCustomerGroups).post(createCustomerGroup);
router.route("/:id").get(getCustomerGroup).put(updateCustomerGroup).delete(deleteCustomerGroup);

module.exports = router;
