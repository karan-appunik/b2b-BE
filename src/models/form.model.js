const mongoose = require("mongoose");

const FIELD_TYPES = [
  "text",
  "email",
  "phone",
  "url",
  "number",
  "password",
  "textarea",
  "dropdown",
  // "radio" is single-select (like "dropdown"), just rendered as radio
  // buttons; "toggle" is a single on/off checkbox (submits "true" or is
  // simply absent from the submission when off).
  "radio",
  "toggle",
  "checkbox",
  "date",
  // "datetime" -> HTML <input type="datetime-local">; "time" -> <input type="time">.
  "datetime",
  "time",
  // "name" -> { firstName, lastName }; "address" -> { address1, city, zip, country };
  // "country"/"tax" are a fixed country-list dropdown; "hidden" is never shown to
  // (or collected from) the visitor.
  "name",
  "address",
  "country",
  "tax",
  "hidden",
  // Uploaded via a separate multipart request to /api/internal/forms/:id/upload;
  // the submitted value is the returned file URL (a plain string).
  "file",
];

// Languages the embed's own built-in text (First Name, Next/Back, etc.) can be
// localised into. Merchant-entered content (field labels, description,
// success message) is never translated — only this fixed UI vocabulary.
const LANGUAGES = ["en", "es", "fr", "de", "hi"];

// Sub-fields a "name" field can expose — each one independently enabled,
// required, and given its own default value. Kept in sync by hand with
// merchant-panel's formTemplates.js NAME_SUBFIELDS.
const NAME_SUBFIELD_KEYS = ["title", "firstName", "middleName", "lastName", "suffix"];

const conditionSchema = new mongoose.Schema(
  {
    // The other field this field's visibility depends on. null/unset means
    // "always visible".
    fieldId: { type: mongoose.Schema.Types.ObjectId, default: null },
    operator: { type: String, enum: ["equals", "not_equals"], default: "equals" },
    value: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

// Condition keys the Validation tab's rule builder can use — kept in sync by
// hand with merchant-panel's formTemplates.js VALIDATION_CONDITION_GROUPS.
const VALIDATION_CONDITIONS = [
  "equals",
  "not_equals",
  "length_equals",
  "length_not_equals",
  "length_gt",
  "length_gte",
  "length_lt",
  "length_lte",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "matches_pattern",
  "is_email",
  "is_url",
  "is_number",
  "is_integer",
  "is_float",
  "is_alpha",
  "is_alphanumeric",
  "is_empty",
  "is_not_empty",
];

// One rule = one condition to check, an optional comparison value (only
// meaningful for a handful of conditions — see VALIDATION_CONDITIONS above),
// and an optional custom error message (falls back to a generic per-
// condition message when left blank).
const validationRuleSchema = new mongoose.Schema(
  {
    condition: { type: String, enum: [...VALIDATION_CONDITIONS, ""], default: "" },
    value: { type: String, trim: true, default: "" },
    message: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const nameSubfieldSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    required: { type: Boolean, default: false },
    defaultValue: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const nameOptionsSchema = new mongoose.Schema(
  {
    title: { type: nameSubfieldSchema, default: () => ({}) },
    firstName: { type: nameSubfieldSchema, default: () => ({ enabled: true }) },
    middleName: { type: nameSubfieldSchema, default: () => ({}) },
    lastName: { type: nameSubfieldSchema, default: () => ({ enabled: true }) },
    suffix: { type: nameSubfieldSchema, default: () => ({}) },
  },
  { _id: false }
);

// Only meaningful for type "file". `allowedFileTypes` is a merchant-entered,
// comma-separated list of MIME patterns ("image/*"), exact MIME types
// ("application/pdf"), or extensions (".pdf") — empty means no restriction
// beyond the upload endpoint's own hard safety allowlist (see
// formUpload.middleware.js). `expiryDays` is stored for a future cleanup job;
// nothing deletes uploaded files yet. `allowMultiple` is stored for a future
// multi-file embed input; the upload endpoint still accepts one file per
// request today.
const fileOptionsSchema = new mongoose.Schema(
  {
    maxFileSizeMB: { type: Number, default: 10 },
    allowedFileTypes: { type: String, trim: true, default: "" },
    expiryDays: { type: Number, default: null },
    allowMultiple: { type: Boolean, default: false },
  },
  { _id: false }
);

const fieldSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    // A merchant-facing machine name set once at creation (see the Add-field
    // popup) — informational today (surfaced as a reference for Display
    // logic / future Workflows / API); the field's real identity for
    // conditions and submission data is still its _id.
    fieldKey: { type: String, trim: true, default: "" },
    type: { type: String, enum: FIELD_TYPES, required: true },
    // Help text shown under the label on the storefront.
    description: { type: String, trim: true, default: "" },
    placeholder: { type: String, trim: true },
    // Pre-fills the input on the storefront; the visitor can still change it
    // (a "readOnly" field is what actually locks it).
    defaultValue: { type: String, trim: true, default: "" },
    required: { type: Boolean, default: false },
    readOnly: { type: Boolean, default: false },
    // Lets the visitor add multiple instances of this field (e.g. more than
    // one phone number) — only meaningful for simple, single-value types.
    repeatable: { type: Boolean, default: false },
    // HTML input hints — passed straight through to the storefront embed's
    // input element.
    autocomplete: { type: String, trim: true, default: "" },
    inputMode: { type: String, trim: true, default: "" },
    autocapitalize: { type: String, trim: true, default: "none" },
    spellcheck: { type: Boolean, default: true },
    minLength: { type: Number, default: null },
    maxLength: { type: Number, default: null },
    // Validation-tab rules — see validationRuleSchema above.
    validationRules: { type: [validationRuleSchema], default: [] },
    // Only meaningful for type "name" — which sub-fields (title/first/
    // middle/last/suffix) are enabled, whether each is individually
    // required, its own default value, and whether they lay out in a row
    // or a column.
    nameOptions: { type: nameOptionsSchema, default: () => ({}) },
    nameLayout: { type: String, enum: ["row", "column"], default: "row" },
    // Only meaningful for type "phone" — shows an international dial-code
    // dropdown alongside the number input, optionally pre-selected to a
    // given country's code.
    showCountryCode: { type: Boolean, default: true },
    defaultCountry: { type: String, trim: true, default: "" },
    // Only meaningful for type "file" — max upload size, allowed MIME/
    // extension list, retention window, and whether multiple files can be
    // attached (see fileOptionsSchema above for details).
    fileOptions: { type: fileOptionsSchema, default: () => ({}) },
    // Choices for "dropdown"/"checkbox" fields; ignored by other field types.
    options: { type: [String], default: [] },
    // Show this field only when another field's value matches `condition`.
    condition: { type: conditionSchema, default: () => ({}) },
    // Marks "a new page starts at this field" for the embedded multi-page form.
    newPage: { type: Boolean, default: false },
  },
  { timestamps: false }
);

const INTERNAL_FIELD_TYPES = ["toggle", "select", "checkbox", "longtext", "group", "button"];
const REVIEW_STATUSES = ["pending", "approved", "rejected"];

// Admin-only fields — never sent to (or collected from) the storefront.
// "group" nests a flat list of child fields, one level deep only (a group's
// own `fields` are sanitized to strip out any nested "group" type — see
// sanitizeInternalFields in the controller). "button" is a placeholder for a
// future workflow trigger; today clicking it just records that it was
// clicked, since there's no workflow engine yet to run.
const internalFieldSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    type: { type: String, enum: INTERNAL_FIELD_TYPES, required: true },
    options: { type: [String], default: [] },
    // Only show this field once the entry's approval status matches one of
    // these — empty means always show. The only conditional-display rule
    // this app supports today.
    visibleWhenReviewStatus: { type: [String], enum: REVIEW_STATUSES, default: [] },
  },
  { timestamps: false }
);
internalFieldSchema.add({ fields: { type: [internalFieldSchema], default: undefined } });

// Web-safe fonts only — a fixed whitelist, not free text, so a merchant
// can't break (or inject something into) the storefront embed's CSS.
// Kept in sync by hand with merchant-panel's formTemplates.js FONT_FAMILY_OPTIONS.
const FONT_FAMILY_OPTIONS = [
  "",
  "Arial, sans-serif",
  "Georgia, serif",
  '"Times New Roman", serif',
  '"Courier New", monospace',
  "Verdana, sans-serif",
  '"Trebuchet MS", sans-serif',
];

// Storefront embed styling — deliberately small: a brand colour, corner
// rounding, and a whitelisted font, not a full custom-CSS escape hatch.
const brandingSchema = new mongoose.Schema(
  {
    primaryColor: { type: String, trim: true, default: "#111827" },
    borderRadius: { type: Number, default: 8 },
    fontFamily: { type: String, enum: FONT_FAMILY_OPTIONS, default: "" },
  },
  { _id: false }
);

const formSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: ["draft", "published", "archived"], default: "draft" },
    fields: { type: [fieldSchema], default: [] },
    internalFields: { type: [internalFieldSchema], default: [] },
    settings: {
      // Shown to the customer on the storefront embed — distinct from the
      // top-level `name`, which is the admin-only internal title.
      publicTitle: { type: String, trim: true, default: "" },
      description: { type: String, trim: true, default: "" },
      submitButtonText: { type: String, trim: true, default: "Submit" },
      successMessage: {
        type: String,
        trim: true,
        default: "Thanks! Your submission has been received.",
      },
      // Localises the embed's built-in vocabulary (see LANGUAGES above).
      language: { type: String, enum: LANGUAGES, default: "en" },
      // Surfaces Approve/Reject actions on this form's entries — for
      // registration-style forms where a submission needs a decision
      // before the person becomes a customer.
      enableApprovalWorkflow: { type: Boolean, default: false },
      // Whether entries for this form can be marked read/unread.
      trackReadStatus: { type: Boolean, default: true },
      // Merchant's preference for the (not-yet-built) "New submission
      // notifications" workflow — stored now, acted on once that workflow
      // engine exists.
      notifyOnSubmission: { type: Boolean, default: true },
      branding: { type: brandingSchema, default: () => ({}) },
    },
    shop: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

formSchema.index({ shop: 1, createdAt: -1 });

module.exports = mongoose.model("Form", formSchema);
module.exports.FIELD_TYPES = FIELD_TYPES;
module.exports.INTERNAL_FIELD_TYPES = INTERNAL_FIELD_TYPES;
module.exports.REVIEW_STATUSES = REVIEW_STATUSES;
module.exports.LANGUAGES = LANGUAGES;
module.exports.VALIDATION_CONDITIONS = VALIDATION_CONDITIONS;
module.exports.NAME_SUBFIELD_KEYS = NAME_SUBFIELD_KEYS;
module.exports.FONT_FAMILY_OPTIONS = FONT_FAMILY_OPTIONS;
