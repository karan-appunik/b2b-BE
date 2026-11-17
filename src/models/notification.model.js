const mongoose = require("mongoose");

// A message for one person (spec §10.2): shown in the app, and optionally sent
// by email. dedupeKey stops the same alert being made twice for the same
// person ("suppress duplicates"). Emails wait while quiet hours are on.
const notificationSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    type: { type: String, required: true },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, maxlength: 1000 },
    // Where the person goes to act on it.
    link: { type: String },
    dedupeKey: { type: String, required: true },
    // Shown in the app. Buyers have no inbox, so theirs are email only.
    inApp: { type: Boolean, default: true },
    readAt: { type: Date },
    emailPending: { type: Boolean, default: false },
    emailSentAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ shop: 1, recipient: 1, dedupeKey: 1 }, { unique: true });
notificationSchema.index({ shop: 1, recipient: 1, createdAt: -1 });
notificationSchema.index({ emailPending: 1, createdAt: 1 });

module.exports = mongoose.model("Notification", notificationSchema);
