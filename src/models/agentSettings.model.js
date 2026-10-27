const mongoose = require("mongoose");

// Shop-wide settings for the Sales Agents module (spec §4.1 "Module
// settings"). One document per shop, created on first read.
const agentSettingsSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, unique: true, trim: true },
    // A hard floor no exception may go below: the lowest allowed price, as a
    // percent of the baseline (e.g. 60 = never below 60% of the baseline).
    // Null: no floor. This stands in for the spec's "below-cost floor" until
    // product cost is available.
    hardFloorPercent: { type: Number, default: null, min: 0, max: 100 },
    // Spec §11.1: step-up authentication for "high-value overrides". On roles
    // that use MFA, an exception at least this many percent below the baseline
    // needs a fresh authenticator check; smaller ones don't. Exceptions with
    // no baseline to compare (a custom line) always do. Null: every exception
    // needs the check.
    stepUpAbovePercent: { type: Number, default: 10, min: 0, max: 100 },
    // Quotes at or above this total (minor units) must be approved by a
    // manager before they can be sent to the buyer (spec §3.3 "optional
    // internal approval"). Null: no quote needs approval.
    quoteApprovalAbove: { type: Number, default: null, min: 0 },
    // Days a sent quote stays open, and days an accepted one has to become an order.
    quoteValidDays: { type: Number, default: 14, min: 1 },
    quoteConvertDays: { type: Number, default: 14, min: 1 },
    // Hours a payment link stays usable.
    paymentLinkValidHours: { type: Number, default: 72, min: 1 },
    // New customers made by agents get these tags, so the group rule that
    // matches them (a safe price list and terms) applies on its own.
    newCustomerTags: { type: [String], default: ["provisional"] },
    // What a provisional customer may do: "allow" orders, or "block" them
    // until the merchant approves the account.
    provisionalOrdering: { type: String, enum: ["allow", "block"], default: "allow" },
    requireTaxId: { type: Boolean, default: false },
    // Alerts (spec §10.2). Reminders go out this many days before a sent
    // quote expires; an approval past its SLA is escalated; each agent gets one
    // daily summary. Emails wait out quiet hours (the shop's own time zone).
    alertsEnabled: { type: Boolean, default: true },
    quoteReminderDays: { type: [Number], default: [3, 1] },
    escalateApprovals: { type: Boolean, default: true },
    digestEnabled: { type: Boolean, default: true },
    quietHoursStart: { type: Number, default: null, min: 0, max: 23 },
    quietHoursEnd: { type: Number, default: null, min: 0, max: 23 },
    businessTimezone: { type: String, default: "UTC", trim: true },
    // Kill switch and feature flags (spec §15.2): the whole module, or one
    // capability, can be switched off without removing anyone's role.
    // Stock (spec §9.5): "informational" only checks what is in stock;
    // "reserve_orders" also holds the stock for an order sent to the customer to
    // pay, until its payment link runs out. Quotes never reserve.
    inventoryMode: { type: String, enum: ["informational", "reserve_orders"], default: "informational" },
    moduleEnabled: { type: Boolean, default: true },
    // Replacements for items that are no longer sold, by SKU. Offered to the
    // agent on a reorder, never added without them agreeing.
    substitutes: {
      type: [{ fromSku: { type: String, required: true, trim: true }, toSku: { type: String, required: true, trim: true }, note: { type: String, trim: true, maxlength: 200 }, _id: false }],
      default: [],
    },
    // An order that fails is reported to the agent and their managers once it
    // has failed this many times (the same order, retried).
    // Phase 4: offline capture. Off until the merchant turns it on: it keeps a
    // short list of customer names on the agent's own device so it can be used
    // without a signal. Unsynced captures older than this many days are refused.
    offlineCaptureEnabled: { type: Boolean, default: false },
    offlineCaptureDays: { type: Number, default: 7, min: 1, max: 30 },
    // Phase 4: the longest an approval delegation may last, in days.
    delegationMaxDays: { type: Number, default: 30, min: 1, max: 90 },
    orderFailAlertAfter: { type: Number, default: 2, min: 1, max: 10 },
    // Retention schedules (spec §11.2): how old, in days, finished contexts,
    // notifications, closed quotes and untouched carts must be before they are
    // deleted, and whether that happens by itself each day. The audit trail is
    // always kept. A legal hold stops all of it.
    retention: {
      autoPurge: { type: Boolean, default: false },
      contextsDays: { type: Number, default: 365, min: 30 },
      notificationsDays: { type: Number, default: 180, min: 30 },
      closedQuotesDays: { type: Number, default: 730, min: 30 },
      inactiveCartsDays: { type: Number, default: 180, min: 30 },
    },
    // How long an "acting for a customer" context lives (spec §15.4): an
    // absolute limit, and optionally an idle limit that ends it sooner when
    // nothing has happened for that long.
    contextAbsoluteMinutes: { type: Number, default: 480, min: 15, max: 1440 },
    contextIdleMinutes: { type: Number, default: null, min: 5, max: 1440 },
    // Wording of notifications, per type and optionally per language
    // ("quote.expiring" or "quote.expiring|fr"): { title, body }, with
    // {title} {body} {recipient} {shop} filled in.
    notificationTemplates: { type: mongoose.Schema.Types.Mixed, default: {} },
    // How our legal entities, channels and territories are named in the
    // merchant's other systems. Added to events as "external".
    integrationMappings: {
      type: [{ kind: { type: String, enum: ["legalEntity", "channel", "territory"], required: true }, from: { type: String, required: true, trim: true }, to: { type: String, required: true, trim: true }, _id: false }],
      default: [],
    },
    featuresOff: { type: [String], default: [] },
    // Running number for quote numbers (Q-0001, Q-0002 …).
    quoteSeq: { type: Number, default: 0 },
    // How long an exception request waits for a decision, and how long an
    // approved or auto-approved exception stays usable.
    requestTtlHours: { type: Number, default: 24, min: 1 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AgentSettings", agentSettingsSchema);
