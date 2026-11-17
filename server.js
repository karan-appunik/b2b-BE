require("dotenv").config();

const app = require("./app");
const connectDB = require("./src/config/db");
const { retryFailedShopifyPushes } = require("./src/controllers/priceList.controller");
const { startOutboxDispatcher } = require("./src/services/outbox.service");
const { startAlertSweeper } = require("./src/services/alert.service");
const { startRetentionSweeper } = require("./src/services/retention.service");

const PORT = process.env.PORT || 5000;
const SHOPIFY_RETRY_INTERVAL_MS = 5 * 60 * 1000;

app.listen(PORT, () => {
  console.log(`[server] backend-api listening on port ${PORT}`);
});

connectDB().catch((err) => {
  console.error("[db] Failed to connect to MongoDB:", err.message);
});

// Delivers queued integration events (waits until AGENT_EVENTS_WEBHOOK_URL is set).
startOutboxDispatcher();

// Timed alerts: escalations, quote reminders, daily summaries, queued emails.
startAlertSweeper();

// Retention schedules, for shops that turned them on.
startRetentionSweeper();

setInterval(() => {
  retryFailedShopifyPushes().catch((err) => {
    console.error("[shopify-retry] failed to run retry sweep:", err.message);
  });
}, SHOPIFY_RETRY_INTERVAL_MS);
