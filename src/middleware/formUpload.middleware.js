const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const UPLOADS_ROOT = path.join(__dirname, "..", "..", "uploads", "forms");

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
  // Windows/Excel often reports CSV as this generic spreadsheet MIME type.
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_ROOT, req.query.shop || "unknown-shop", req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

// This is a hard outer ceiling only — the real, per-field limit
// (fileOptions.maxFileSizeMB, merchant-configurable in the form builder) is
// enforced in form.controller.js's uploadFormFile once the target field is
// known. Likewise ALLOWED_MIME_TYPES is a broad safety allowlist; a field's
// own (narrower) fileOptions.allowedFileTypes is also checked there.
const HARD_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

const uploadFormFile = multer({
  storage,
  limits: { fileSize: HARD_MAX_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED_MIME_TYPES.has(file.mimetype));
  },
});

module.exports = { uploadFormFile, UPLOADS_ROOT };
