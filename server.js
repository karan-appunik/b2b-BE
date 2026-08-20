require("dotenv").config();

const app = require("./app");
const connectDB = require("./src/config/db");
const { retryFailedShopifyPushes } = require("./src/controllers/priceList.controller");

const PORT = process.env.PORT || 5000;
const SHOPIFY_RETRY_INTERVAL_MS = 5 * 60 * 1000;

app.listen(PORT, () => {
  console.log(`[server] backend-api listening on port ${PORT}`);
});

connectDB().catch((err) => {
  console.error("[db] Failed to connect to MongoDB:", err.message);
});

setInterval(() => {
  retryFailedShopifyPushes().catch((err) => {
    console.error("[shopify-retry] failed to run retry sweep:", err.message);
  });
}, SHOPIFY_RETRY_INTERVAL_MS);
