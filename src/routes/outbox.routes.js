const express = require("express");

const { listEvents, retryEvent } = require("../controllers/outbox.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.get("/", listEvents);
router.post("/:id/retry", retryEvent);

module.exports = router;
