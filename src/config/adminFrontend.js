const fs = require("fs");
const path = require("path");

// admin-frontend's dev port changes on every restart (Shopify CLI assigns it
// dynamically). admin-frontend/vite.config.ts writes its current port here on
// every start, so we read it fresh on every call instead of relying on a
// hardcoded ADMIN_FRONTEND_URL in .env that goes stale between restarts.
// Only trust this file outside production — a deployed backend must always
// use ADMIN_FRONTEND_URL.
function getAdminFrontendUrl() {
  if (process.env.NODE_ENV !== "production") {
    try {
      const filePath = path.resolve(__dirname, "../../.dev-admin-url.json");
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (data.url) return data.url;
    } catch {
      // fall through to env var
    }
  }
  return process.env.ADMIN_FRONTEND_URL;
}

module.exports = { getAdminFrontendUrl };
