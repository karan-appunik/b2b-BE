const express = require("express");

const { listGrants, createGrant, deleteGrant, previewGrantRule } = require("../controllers/agentScope.controller");
const {
  listPermissionGrants,
  createPermissionGrant,
  revokePermissionGrant,
} = require("../controllers/permissionGrant.controller");
const { resetMfa } = require("../controllers/agentMfa.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.route("/:agentId/permission-grants").get(listPermissionGrants).post(createPermissionGrant);
router.delete("/:agentId/permission-grants/:grantId", revokePermissionGrant);
router.post("/:agentId/mfa/reset", resetMfa);
router.post("/:agentId/scope-grants/preview", previewGrantRule);
router.route("/:agentId/scope-grants").get(listGrants).post(createGrant);
router.route("/:agentId/scope-grants/:grantId").delete(deleteGrant);

module.exports = router;
