// Basic hardening for every request (spec §11.3 threat scenarios).

// A value that is meant to be text or an id can't be a query operator. A body or
// a query string that carries a key starting with "$" ({"customerId":{"$ne":null}})
// is how an operator is smuggled into a database lookup, so it is refused
// before it reaches any handler. Nothing the app sends legitimately has one.
function hasOperatorKey(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 12) return false;
  for (const key of Object.keys(value)) {
    if (key.startsWith("$")) return true;
    if (hasOperatorKey(value[key], depth + 1)) return true;
  }
  return false;
}

function rejectOperatorKeys(req, res, next) {
  if (hasOperatorKey(req.body) || hasOperatorKey(req.query) || hasOperatorKey(req.params)) {
    return res.status(400).json({ code: "INVALID_INPUT", message: "That request has a field the server does not accept" });
  }
  next();
}

// Headers that tell the browser not to guess or embed.
function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

module.exports = { hasOperatorKey, rejectOperatorKeys, securityHeaders };
