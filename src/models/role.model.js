const mongoose = require("mongoose");

// A role is a named bundle of permissions (spec §6.2 `roles` +
// `role_permissions`). `version` goes up on every change so a decision can
// be traced to the exact rules in force when it was made.
const permissionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    effect: { type: String, enum: ["allow", "deny"], default: "allow" },
    // Optional limits, e.g. { scope: "all" } or { maxDeltaPercent: 10 }.
    constraints: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { _id: false }
);

const roleSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true },
    key: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    // System roles ship with the app: they can be edited but not deleted.
    isSystem: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    // Key of another role whose permissions this one starts from (spec §4.1
    // "inheritance"). Anything the role lists itself overrides the parent.
    inheritsFrom: { type: String, trim: true, lowercase: true, default: null },
    // People with this role must pass the authenticator-app check before they
    // can act for a customer, and again (step-up) for high-risk actions.
    requireMfa: { type: Boolean, default: false },
    version: { type: Number, default: 1 },
    // Which version of the built-in defaults this role was created from or
    // last brought up to date with (see ensureSystemRoles). Roles from before
    // this field existed count as version 1.
    seededVersion: { type: Number },
    permissions: { type: [permissionSchema], default: [] },
  },
  { timestamps: true }
);

roleSchema.index({ shop: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("Role", roleSchema);
