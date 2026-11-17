const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Form = require("../models/form.model");
const FormEntry = require("../models/formEntry.model");

// "name"/"address" submit as objects ({ firstName, lastName } / { address1,
// city, zip, country }); a "phone" field with a country-code selector does
// too ({ code, number }). Required just means "at least one part filled in",
// not full validation of every sub-field. "hidden" fields are never shown to
// (or collected from) the visitor, so they can never fail a required check.
function isFieldFilled(field, value) {
  if (field.type === "hidden") return true;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value).some((v) => String(v ?? "").trim());
  }
  return !!String(value ?? "").trim();
}

// Checks a "name" field's per-sub-field required flags (title/first/middle/
// last/suffix) — independent of the field's own top-level `required`, which
// (for "name" fields) only covers the older "at least one part filled in"
// check in isFieldFilled above.
function isNameFieldValid(field, value) {
  const v = value && typeof value === "object" ? value : {};
  return Form.NAME_SUBFIELD_KEYS.every((key) => {
    const sub = field.nameOptions?.[key];
    if (!sub?.enabled || !sub?.required) return true;
    return !!String(v[key] ?? "").trim();
  });
}

// A field with a `condition` is only counted toward required-field validation
// when the field it depends on currently matches that condition — mirrors the
// show/hide behavior the embed script applies for the visitor.
function isFieldVisibleForSubmission(field, values) {
  if (!field.condition?.fieldId) return true;
  const actual = String(values[field.condition.fieldId] ?? "");
  return field.condition.operator === "not_equals"
    ? actual !== field.condition.value
    : actual === field.condition.value;
}

// Enforces the Input-options tab's minLength/maxLength — separate from the
// Validation tab's rules below. "repeatable" fields submit an array; every
// entry is checked. Object-shaped values (name/address/phone-with-code) have
// no single string to measure, so they're skipped — those field types don't
// expose Input options either.
function isLengthValid(field, rawValue) {
  if (field.minLength == null && field.maxLength == null) return true;
  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) return true;

  const values = Array.isArray(rawValue) ? rawValue : [rawValue];
  return values.every((v) => {
    const str = String(v ?? "").trim();
    if (!str) return true; // empty is an optional-field concern, handled by the required check
    if (field.minLength != null && str.length < field.minLength) return false;
    if (field.maxLength != null && str.length > field.maxLength) return false;
    return true;
  });
}

// Evaluates a single Validation-tab rule against one string value. Mirrored
// in admin-frontend's embedScript.server.ts so the storefront can show the
// same result live, client-side, before ever hitting this endpoint.
function evaluateRule(rule, str) {
  switch (rule.condition) {
    case "equals":
      return str === rule.value;
    case "not_equals":
      return str !== rule.value;
    case "length_equals":
      return str.length === Number(rule.value);
    case "length_not_equals":
      return str.length !== Number(rule.value);
    case "length_gt":
      return str.length > Number(rule.value);
    case "length_gte":
      return str.length >= Number(rule.value);
    case "length_lt":
      return str.length < Number(rule.value);
    case "length_lte":
      return str.length <= Number(rule.value);
    case "contains":
      return str.includes(rule.value);
    case "not_contains":
      return !str.includes(rule.value);
    case "starts_with":
      return str.startsWith(rule.value);
    case "ends_with":
      return str.endsWith(rule.value);
    case "matches_pattern": {
      let re;
      try {
        re = new RegExp(rule.value);
      } catch {
        return true; // an invalid regex can't reject anything
      }
      return re.test(str);
    }
    case "is_email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
    case "is_url":
      try {
        new URL(str);
        return true;
      } catch {
        return false;
      }
    case "is_number":
      return str !== "" && !Number.isNaN(Number(str));
    case "is_integer":
      return /^-?\d+$/.test(str);
    case "is_float":
      return /^-?\d+\.\d+$/.test(str);
    case "is_alpha":
      return /^[A-Za-z]+$/.test(str);
    case "is_alphanumeric":
      return /^[A-Za-z0-9]+$/.test(str);
    case "is_empty":
      return str === "";
    case "is_not_empty":
      return str !== "";
    default:
      return true; // no condition selected yet — an incomplete rule never blocks submission
  }
}

const DEFAULT_RULE_MESSAGES = {
  equals: (v) => `Must equal "${v}".`,
  not_equals: (v) => `Must not equal "${v}".`,
  length_equals: (v) => `Must be exactly ${v} characters.`,
  length_not_equals: (v) => `Must not be exactly ${v} characters.`,
  length_gt: (v) => `Must be more than ${v} characters.`,
  length_gte: (v) => `Must be at least ${v} characters.`,
  length_lt: (v) => `Must be less than ${v} characters.`,
  length_lte: (v) => `Must be at most ${v} characters.`,
  contains: (v) => `Must contain "${v}".`,
  not_contains: (v) => `Must not contain "${v}".`,
  starts_with: (v) => `Must start with "${v}".`,
  ends_with: (v) => `Must end with "${v}".`,
  matches_pattern: () => "Must match the required format.",
  is_email: () => "Must be a valid email address.",
  is_url: () => "Must be a valid URL.",
  is_number: () => "Must be a number.",
  is_integer: () => "Must be a whole number.",
  is_float: () => "Must be a decimal number.",
  is_alpha: () => "Must contain only letters.",
  is_alphanumeric: () => "Must contain only letters and numbers.",
  is_empty: () => "Must be empty.",
  is_not_empty: () => "Must not be empty.",
};

function ruleMessage(rule) {
  if (rule.message) return rule.message;
  return DEFAULT_RULE_MESSAGES[rule.condition]?.(rule.value) || "Invalid value.";
}

// A rule about emptiness (is_empty/is_not_empty) always applies; every other
// rule is skipped on a blank value — required-ness is handled separately, so
// an optional field left blank shouldn't fail e.g. "Is email".
function isRuleApplicable(rule, str) {
  if (str !== "") return true;
  return rule.condition === "is_empty" || rule.condition === "is_not_empty";
}

// Checks every Validation-tab rule server-side — the embed script checks the
// same rules client-side, but a direct POST to this endpoint must never be
// able to skip them. "repeatable" fields submit an array; every entry is
// checked. Object-shaped values (name/address/phone-with-code) have no
// single string to validate, so they're left alone here — those field types
// don't expose a Validation tab. Returns the first failing rule (with its
// resolved message), or null if the value satisfies every rule.
function getFailingRule(field, rawValue) {
  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) return null;
  const rules = (field.validationRules || []).filter((r) => r.condition);
  if (rules.length === 0) return null;

  const values = Array.isArray(rawValue) ? rawValue : [rawValue];
  for (const v of values) {
    const str = String(v ?? "").trim();
    for (const rule of rules) {
      if (isRuleApplicable(rule, str) && !evaluateRule(rule, str)) {
        return rule;
      }
    }
  }
  return null;
}

function sanitizeValidationRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((r) => r?.condition && Form.VALIDATION_CONDITIONS.includes(r.condition))
    .map((r) => ({
      condition: r.condition,
      value: r.value || "",
      message: r.message || "",
    }));
}

// Clamps to a non-negative integer, or null if not a valid number — used for
// minLength/maxLength so garbage input can't produce a broken HTML attribute.
// Must check for null/undefined/"" explicitly first — Number(null) is 0, not
// NaN, so without this an unset length would silently become "max length 0"
// and reject every non-empty value.
function sanitizeLength(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Only meaningful for type "name" — ignored (but harmless) on other types.
function sanitizeNameOptions(nameOptions) {
  const out = {};
  for (const key of Form.NAME_SUBFIELD_KEYS) {
    const sub = nameOptions?.[key] || {};
    out[key] = {
      enabled: !!sub.enabled,
      required: !!sub.required,
      defaultValue: sub.defaultValue || "",
    };
  }
  return out;
}

// Only meaningful for type "file" — ignored (but harmless) on other types.
function sanitizeFileOptions(fileOptions) {
  const maxFileSizeMB = Number(fileOptions?.maxFileSizeMB);
  const expiryDays = Number(fileOptions?.expiryDays);
  return {
    maxFileSizeMB: Number.isFinite(maxFileSizeMB) && maxFileSizeMB > 0 ? maxFileSizeMB : 10,
    allowedFileTypes: fileOptions?.allowedFileTypes || "",
    expiryDays: Number.isInteger(expiryDays) && expiryDays > 0 ? expiryDays : null,
    allowMultiple: !!fileOptions?.allowMultiple,
  };
}

// Checks an uploaded file against a field's `allowedFileTypes` — a merchant-
// entered, comma-separated list of MIME wildcards ("image/*"), exact MIME
// types ("application/pdf"), or extensions (".pdf" / "pdf"). Empty/unset
// means no additional restriction beyond the upload endpoint's own hard
// safety allowlist (see formUpload.middleware.js).
function matchesAllowedFileType(allowedFileTypes, mimetype, originalname) {
  const patterns = String(allowedFileTypes || "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (patterns.length === 0) return true;

  const ext = path.extname(originalname || "").slice(1).toLowerCase();
  const mime = String(mimetype || "").toLowerCase();

  return patterns.some((pattern) => {
    if (pattern.endsWith("/*")) return mime.startsWith(pattern.slice(0, -1));
    const normalized = pattern.replace(/^\./, "");
    return pattern === mime || normalized === ext;
  });
}

function sanitizeFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.map((f) => ({
    // Preserve the field's existing _id when editing so previously
    // submitted entries (keyed by field _id) stay matched to the right
    // field instead of becoming orphaned on every save.
    ...(f._id ? { _id: f._id } : {}),
    label: f.label,
    fieldKey: f.fieldKey || "",
    type: f.type,
    description: f.description || "",
    placeholder: f.placeholder || "",
    defaultValue: f.defaultValue || "",
    required: !!f.required,
    readOnly: !!f.readOnly,
    repeatable: !!f.repeatable,
    autocomplete: f.autocomplete || "",
    inputMode: f.inputMode || "",
    autocapitalize: f.autocapitalize || "none",
    spellcheck: f.spellcheck !== undefined ? !!f.spellcheck : true,
    minLength: sanitizeLength(f.minLength),
    maxLength: sanitizeLength(f.maxLength),
    validationRules: sanitizeValidationRules(f.validationRules),
    nameOptions: sanitizeNameOptions(f.nameOptions),
    nameLayout: f.nameLayout === "column" ? "column" : "row",
    showCountryCode: f.showCountryCode !== undefined ? !!f.showCountryCode : true,
    defaultCountry: f.defaultCountry || "",
    fileOptions: sanitizeFileOptions(f.fileOptions),
    options: Array.isArray(f.options) ? f.options.filter(Boolean) : [],
    condition: {
      fieldId: f.condition?.fieldId || null,
      operator: f.condition?.operator === "not_equals" ? "not_equals" : "equals",
      value: f.condition?.value || "",
    },
    newPage: !!f.newPage,
  }));
}

// publicTitle defaults to the form's (internal) name so a brand-new form
// doesn't render with a blank heading on the storefront until the merchant
// explicitly sets a different public-facing title.
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Storefront embed styling — a hex colour (validated so a bad value can't
// break the generated CSS), a clamped corner-radius, and a whitelisted font.
function sanitizeBranding(branding) {
  return {
    primaryColor: HEX_COLOR_RE.test(branding?.primaryColor) ? branding.primaryColor : "#111827",
    borderRadius: Number.isFinite(Number(branding?.borderRadius))
      ? Math.min(50, Math.max(0, Math.round(Number(branding.borderRadius))))
      : 8,
    fontFamily: Form.FONT_FAMILY_OPTIONS.includes(branding?.fontFamily) ? branding.fontFamily : "",
  };
}

function sanitizeSettings(settings, name) {
  return {
    publicTitle: settings?.publicTitle || name || "",
    description: settings?.description || "",
    submitButtonText: settings?.submitButtonText || "Submit",
    successMessage: settings?.successMessage || "Thanks! Your submission has been received.",
    language: Form.LANGUAGES.includes(settings?.language) ? settings.language : "en",
    enableApprovalWorkflow: !!settings?.enableApprovalWorkflow,
    trackReadStatus: settings?.trackReadStatus !== undefined ? !!settings.trackReadStatus : true,
    notifyOnSubmission: settings?.notifyOnSubmission !== undefined ? !!settings.notifyOnSubmission : true,
    branding: sanitizeBranding(settings?.branding),
  };
}

const REVIEW_STATUSES = ["pending", "approved", "rejected"];

// "group" nests one flat level of child fields — a group inside a group is
// silently dropped rather than rejected, so depth stays capped at 1.
function sanitizeInternalFields(fields, depth = 0) {
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((f) => depth === 0 || f.type !== "group")
    .map((f) => ({
      ...(f._id ? { _id: f._id } : {}),
      label: f.label,
      type: f.type,
      options: Array.isArray(f.options) ? f.options.filter(Boolean) : [],
      visibleWhenReviewStatus: Array.isArray(f.visibleWhenReviewStatus)
        ? f.visibleWhenReviewStatus.filter((s) => REVIEW_STATUSES.includes(s))
        : [],
      ...(f.type === "group" ? { fields: sanitizeInternalFields(f.fields, depth + 1) } : {}),
    }));
}

async function getForms(req, res, next) {
  try {
    const forms = await Form.find({ shop: req.user.shop }).sort({ createdAt: -1 });
    const counts = await FormEntry.aggregate([
      { $match: { shop: req.user.shop } },
      {
        $group: {
          _id: "$form",
          entries: { $sum: 1 },
          unread: { $sum: { $cond: [{ $eq: ["$status", "unread"] }, 1, 0] } },
        },
      },
    ]);
    const countsByForm = Object.fromEntries(counts.map((c) => [String(c._id), c]));

    res.status(200).json(
      forms.map((form) => ({
        ...form.toObject(),
        entryCount: countsByForm[String(form._id)]?.entries || 0,
        unreadCount: countsByForm[String(form._id)]?.unread || 0,
      }))
    );
  } catch (err) {
    next(err);
  }
}

async function getForm(req, res, next) {
  try {
    const form = await Form.findOne({ _id: req.params.id, shop: req.user.shop });
    if (!form) {
      return res.status(404).json({ message: "Form not found" });
    }
    res.status(200).json(form);
  } catch (err) {
    next(err);
  }
}

async function createForm(req, res, next) {
  try {
    const { name, status, fields, internalFields, settings } = req.body;
    const form = await Form.create({
      name,
      status: ["published", "archived"].includes(status) ? status : "draft",
      fields: sanitizeFields(fields),
      internalFields: sanitizeInternalFields(internalFields),
      settings: sanitizeSettings(settings, name),
      shop: req.user.shop,
    });
    res.status(201).json(form);
  } catch (err) {
    next(err);
  }
}

async function updateForm(req, res, next) {
  try {
    const { name, status, fields, internalFields, settings } = req.body;

    const existing = await Form.findOne({ _id: req.params.id, shop: req.user.shop });
    if (!existing) {
      return res.status(404).json({ message: "Form not found" });
    }

    const update = {};
    if (name !== undefined) update.name = name;
    if (status !== undefined) {
      update.status = ["published", "archived"].includes(status) ? status : "draft";
    }
    if (fields !== undefined) update.fields = sanitizeFields(fields);
    if (internalFields !== undefined) update.internalFields = sanitizeInternalFields(internalFields);
    if (settings !== undefined) {
      update.settings = sanitizeSettings(settings, name !== undefined ? name : existing.name);
    }

    const form = await Form.findOneAndUpdate({ _id: req.params.id, shop: req.user.shop }, update, {
      new: true,
      runValidators: true,
    });

    if (!form) {
      return res.status(404).json({ message: "Form not found" });
    }

    res.status(200).json(form);
  } catch (err) {
    next(err);
  }
}

async function deleteForm(req, res, next) {
  try {
    const form = await Form.findOneAndDelete({ _id: req.params.id, shop: req.user.shop });
    if (!form) {
      return res.status(404).json({ message: "Form not found" });
    }
    await FormEntry.deleteMany({ form: form._id, shop: req.user.shop });
    res.status(200).json({ message: "Form deleted" });
  } catch (err) {
    next(err);
  }
}

async function getFormEntries(req, res, next) {
  try {
    const form = await Form.findOne({ _id: req.params.id, shop: req.user.shop });
    if (!form) {
      return res.status(404).json({ message: "Form not found" });
    }
    const entries = await FormEntry.find({ form: form._id, shop: req.user.shop }).sort({
      createdAt: -1,
    });
    res.status(200).json(entries);
  } catch (err) {
    next(err);
  }
}

async function getFormEntry(req, res, next) {
  try {
    const entry = await FormEntry.findOneAndUpdate(
      { _id: req.params.entryId, form: req.params.id, shop: req.user.shop, status: "unread" },
      { status: "read" },
      { new: true }
    );

    const result = entry || (await FormEntry.findOne({
      _id: req.params.entryId,
      form: req.params.id,
      shop: req.user.shop,
    }));

    if (!result) {
      return res.status(404).json({ message: "Entry not found" });
    }

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function reviewFormEntry(req, res, next) {
  try {
    const { reviewStatus } = req.body;
    if (!["pending", "approved", "rejected"].includes(reviewStatus)) {
      return res.status(400).json({ message: "reviewStatus must be pending, approved or rejected" });
    }

    const entry = await FormEntry.findOneAndUpdate(
      { _id: req.params.entryId, form: req.params.id, shop: req.user.shop },
      { reviewStatus },
      { new: true }
    );

    if (!entry) {
      return res.status(404).json({ message: "Entry not found" });
    }

    res.status(200).json(entry);
  } catch (err) {
    next(err);
  }
}

async function updateEntryInternalData(req, res, next) {
  try {
    const { internalData } = req.body;
    const entry = await FormEntry.findOneAndUpdate(
      { _id: req.params.entryId, form: req.params.id, shop: req.user.shop },
      { internalData: internalData && typeof internalData === "object" ? internalData : {} },
      { new: true }
    );

    if (!entry) {
      return res.status(404).json({ message: "Entry not found" });
    }

    res.status(200).json(entry);
  } catch (err) {
    next(err);
  }
}

async function deleteFormEntry(req, res, next) {
  try {
    const entry = await FormEntry.findOneAndDelete({
      _id: req.params.entryId,
      form: req.params.id,
      shop: req.user.shop,
    });

    if (!entry) {
      return res.status(404).json({ message: "Entry not found" });
    }

    res.status(200).json({ message: "Entry deleted" });
  } catch (err) {
    next(err);
  }
}

// Public form schema, looked up for rendering the form on the storefront —
// called via admin-frontend's app proxy, never directly by a shopper.
async function getPublicForm(req, res, next) {
  try {
    const { shop } = req.query;
    const form = await Form.findOne({ _id: req.params.id, shop, status: "published" }).select(
      "name fields settings"
    );

    if (!form) {
      return res.status(404).json({ message: "Form not found" });
    }

    res.status(200).json(form);
  } catch (err) {
    next(err);
  }
}

// Storefront submission — called via admin-frontend's app proxy, so the
// caller is never trusted with more than a shop + the field values.
async function submitFormEntry(req, res, next) {
  try {
    const { shop, data } = req.body;
    const form = await Form.findOne({ _id: req.params.id, shop, status: "published" });

    if (!form) {
      return res.status(404).json({ message: "Form not found" });
    }

    const values = data && typeof data === "object" ? data : {};
    const visibleFields = form.fields.filter((f) => isFieldVisibleForSubmission(f, values));

    const missing = visibleFields.filter((f) => f.required && !isFieldFilled(f, values[f._id]));
    if (missing.length > 0) {
      return res.status(400).json({
        message: `Missing required field(s): ${missing.map((f) => f.label).join(", ")}`,
      });
    }

    const missingNameSubfield = visibleFields.find(
      (f) => f.type === "name" && !isNameFieldValid(f, values[f._id])
    );
    if (missingNameSubfield) {
      return res.status(400).json({
        message: `Missing required field(s) in "${missingNameSubfield.label}".`,
      });
    }

    const tooLong = visibleFields.find((f) => !isLengthValid(f, values[f._id]));
    if (tooLong) {
      return res.status(400).json({ message: `Invalid value for "${tooLong.label}".` });
    }

    for (const f of visibleFields) {
      const failingRule = getFailingRule(f, values[f._id]);
      if (failingRule) {
        return res.status(400).json({ message: ruleMessage(failingRule) });
      }
    }

    const entry = await FormEntry.create({ form: form._id, data: values, shop });

    res.status(201).json({ id: entry._id, successMessage: form.settings.successMessage });
  } catch (err) {
    next(err);
  }
}

// Handles a multipart file upload for a "file" field — a separate request
// from the main JSON submit, since the storefront submit body is JSON. The
// returned URL is then included as that field's value in the normal submit.
//
// The upload endpoint's multer middleware only enforces a generous hard cap
// and a broad safety allowlist (see formUpload.middleware.js) — narrower,
// per-field limits (fileOptions.maxFileSizeMB / allowedFileTypes) are
// enforced here, once the field being uploaded to is known from `fieldId`.
async function uploadFormFile(req, res, next) {
  try {
    const { shop } = req.query;
    const { fieldId } = req.body;
    const form = await Form.findOne({ _id: req.params.id, shop, status: "published" });
    if (!form) {
      return res.status(404).json({ message: "Form not found" });
    }
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded, or file type not allowed" });
    }

    const field = form.fields.id(fieldId);
    if (!field || field.type !== "file") {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: "Unknown file field" });
    }

    const fileOptions = sanitizeFileOptions(field.fileOptions);
    const maxBytes = fileOptions.maxFileSizeMB * 1024 * 1024;
    if (req.file.size > maxBytes) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({
        message: `File is too large — maximum size is ${fileOptions.maxFileSizeMB}MB.`,
      });
    }

    if (!matchesAllowedFileType(fileOptions.allowedFileTypes, req.file.mimetype, req.file.originalname)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: "This file type isn't allowed for this field." });
    }

    const relativePath = path
      .relative(path.join(__dirname, "..", "..", "uploads"), req.file.path)
      .split(path.sep)
      .join("/");
    res.status(201).json({ url: `/uploads/${relativePath}` });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getForms,
  getForm,
  createForm,
  updateForm,
  deleteForm,
  getFormEntries,
  getFormEntry,
  reviewFormEntry,
  updateEntryInternalData,
  deleteFormEntry,
  getPublicForm,
  submitFormEntry,
  uploadFormFile,
};
