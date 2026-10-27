const mongoose = require("mongoose");

// Phase 4: offline capture. An agent with no signal (a trade event, a
// warehouse) notes down what a customer wants on the device. When the device
// is back online it is sent here. It is a list of wanted items, not an order and
// not a cart: nothing is priced, reserved or added until the agent opens it
// again and the normal checks run (access, today's price, stock). The spec says
// writes need a connection in V1, so this never writes to a cart by itself.
const lineSchema = new mongoose.Schema(
  {
    sku: { type: String, trim: true, maxlength: 100 },
    barcode: { type: String, trim: true, maxlength: 100 },
    variantId: { type: String, trim: true, maxlength: 64 },
    title: { type: String, trim: true, maxlength: 200 },
    quantity: { type: Number, required: true, min: 1, max: 100000 },
  },
  { _id: false }
);

const offlineCaptureSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    // Made up on the device so a resend is recognised and never doubled.
    clientId: { type: String, required: true, trim: true, maxlength: 80 },
    capturedAt: { type: Date, required: true },
    receivedAt: { type: Date, default: Date.now },
    lines: { type: [lineSchema], default: [] },
    note: { type: String, trim: true, maxlength: 500 },
    po: { type: String, trim: true, maxlength: 64 },
    status: { type: String, enum: ["PENDING_REVIEW", "ADDED", "DISCARDED"], default: "PENDING_REVIEW" },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

offlineCaptureSchema.index({ shop: 1, agent: 1, clientId: 1 }, { unique: true });
offlineCaptureSchema.index({ shop: 1, agent: 1, status: 1, capturedAt: -1 });

module.exports = mongoose.model("OfflineCapture", offlineCaptureSchema);
