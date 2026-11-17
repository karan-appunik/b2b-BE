// One-off backfill: every discount created before the priority field existed
// defaults to 0, which is fine functionally (ties break by createdAt) but
// means the "Manage priorities" list has no real starting order. This gives
// each shop's existing discounts a sequential priority matching their
// current creation order (oldest = highest priority), which matches
// pre-existing checkout behavior.
// Run once from backend-api/: node scripts/backfill-discount-priority.js
require("dotenv").config();
const mongoose = require("mongoose");
const Discount = require("../src/models/discount.model");

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log("[backfill] connected");

  const shops = await Discount.distinct("shop");
  let updated = 0;

  for (const shop of shops) {
    const discounts = await Discount.find({ shop }).sort({ createdAt: 1 });
    for (let i = 0; i < discounts.length; i++) {
      if (discounts[i].priority !== i) {
        discounts[i].priority = i;
        await discounts[i].save();
        updated++;
      }
    }
  }

  console.log(`[backfill] ${updated} discount(s) updated across ${shops.length} shop(s)`);
  await mongoose.disconnect();
  console.log("[backfill] done");
}

run().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
