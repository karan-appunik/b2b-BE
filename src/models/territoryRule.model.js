const mongoose = require("mongoose");

// Puts customers into a sales territory by themselves (spec §2.3 "dynamic
// scope"; roadmap "territory automation"). A rule names a territory and what a
// customer must look like: where their default address is, or a Shopify tag.
// Within one kind of check any value will do; across kinds, all must match.
// The first matching rule by priority wins.
const territoryRuleSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    territory: { type: String, required: true, trim: true, maxlength: 60 },
    countryCodes: { type: [String], default: [] },
    provinceCodes: { type: [String], default: [] },
    zipPrefixes: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    // Lower runs first.
    priority: { type: Number, default: 100 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

territoryRuleSchema.index({ shop: 1, priority: 1, createdAt: 1 });

module.exports = mongoose.model("TerritoryRule", territoryRuleSchema);
