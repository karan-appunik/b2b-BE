const express = require("express");

const {
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  getRoleMembers,
} = require("../controllers/role.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.route("/").get(listRoles).post(createRole);
router.get("/:key/members", getRoleMembers);
router.route("/:key").put(updateRole).delete(deleteRole);

module.exports = router;
