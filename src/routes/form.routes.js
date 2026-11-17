const express = require("express");

const {
  getForms,
  getForm,
  createForm,
  updateForm,
  deleteForm,
  getFormEntries,
  getFormEntry,
  reviewFormEntry,
  updateEntryInternalData,
  deleteFormEntry,
} = require("../controllers/form.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.route("/").get(getForms).post(createForm);
router.route("/:id").get(getForm).put(updateForm).delete(deleteForm);
router.route("/:id/entries").get(getFormEntries);
router.route("/:id/entries/:entryId").get(getFormEntry).delete(deleteFormEntry);
router.route("/:id/entries/:entryId/review").put(reviewFormEntry);
router.route("/:id/entries/:entryId/internal-data").put(updateEntryInternalData);

module.exports = router;
