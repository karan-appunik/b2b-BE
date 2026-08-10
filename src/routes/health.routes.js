const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

router.get("/health", (req, res) => {
  const dbStates = ["disconnected", "connected", "connecting", "disconnecting"];

  res.status(200).json({
    status: "ok",
    service: "backend-api",
    timestamp: new Date().toISOString(),
    db: dbStates[mongoose.connection.readyState] || "unknown",
  });
});

module.exports = router;
