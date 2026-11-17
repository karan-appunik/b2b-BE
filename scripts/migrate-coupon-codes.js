// One-off migration: the Discount schema used to store a single coupon code
// as `couponCode` (string). It now stores `couponCodes` (array), so a
// discount can have several codes (docs.sparklayer.io/discounts "Coupon
// codes"). Existing discounts still have the old field in MongoDB — this
// copies it into the new array field and removes the old one, then
// resyncs indexes so the stale {shop, couponCode} unique index is dropped
// and the new {shop, couponCodes} one is created.
//
// Run once from backend-api/: node scripts/migrate-coupon-codes.js
require("dotenv").config();
const mongoose = require("mongoose");
const Discount = require("../src/models/discount.model");

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set");
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log("[migrate] connected");

  const collection = mongoose.connection.collection("discounts");
  const cursor = collection.find({ couponCode: { $exists: true, $type: "string" } });

  let migrated = 0;
  for await (const doc of cursor) {
    const code = String(doc.couponCode || "").trim().toUpperCase();
    const existing = Array.isArray(doc.couponCodes) ? doc.couponCodes : [];
    const merged = code ? [...new Set([...existing, code])] : existing;

    await collection.updateOne(
      { _id: doc._id },
      { $set: { couponCodes: merged }, $unset: { couponCode: "" } },
    );
    console.log(`[migrate] "${doc.name}" -> couponCodes: [${merged.join(", ")}]`);
    migrated++;
  }

  console.log(`[migrate] ${migrated} discount(s) updated`);

  console.log("[migrate] resyncing indexes...");
  await Discount.syncIndexes();
  console.log("[migrate] indexes synced");

  await mongoose.disconnect();
  console.log("[migrate] done");
}

migrate().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
