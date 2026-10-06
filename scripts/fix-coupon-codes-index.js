// Rebuilds the {shop, couponCodes} unique index with the correct partial
// filter — the original version treated every automatic discount (empty
// couponCodes array) as colliding with every other one, because MongoDB
// indexes an empty array as a single `undefined` entry, not zero entries.
// Run once from backend-api/: node scripts/fix-coupon-codes-index.js
require("dotenv").config();
const mongoose = require("mongoose");
const Discount = require("../src/models/discount.model");

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log("[fix-index] connected");

  console.log("[fix-index] syncing indexes...");
  const result = await Discount.syncIndexes();
  console.log("[fix-index] syncIndexes result:", result);

  const indexes = await mongoose.connection.collection("discounts").indexes();
  console.log("[fix-index] current indexes:", JSON.stringify(indexes, null, 2));

  await mongoose.disconnect();
  console.log("[fix-index] done");
}

run().catch((err) => {
  console.error("[fix-index] failed:", err);
  process.exit(1);
});
