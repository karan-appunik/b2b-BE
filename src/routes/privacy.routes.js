const express = require("express");

const c = require("../controllers/privacy.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.get("/retention", c.retentionPreview);
router.post("/retention/run", c.retentionRun);
router.get("/holds", c.listHolds);
router.post("/holds", c.placeHold);
router.post("/holds/:id/release", c.releaseHold);
router.get("/requests", c.listRequests);
router.post("/requests", c.createRequest);

module.exports = router;
