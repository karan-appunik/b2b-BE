function notFound(req, res, next) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

function errorHandler(err, req, res, next) {
  if (err.name === "ValidationError") {
    const message = Object.values(err.errors)
      .map((e) => e.message)
      .join(", ");
    return res.status(400).json({ message });
  }

  if (err.code === 11000 || (Array.isArray(err.writeErrors) && err.writeErrors.some((e) => e.code === 11000))) {
    // bulkWrite({ ordered: false }) throws a MongoBulkWriteError whose own
    // keyValue is empty — the duplicate key/value only shows up inside the
    // raw Mongo errmsg string on the first failing entry in writeErrors, e.g.
    // `dup key: { shop: "x", email: "dup@test.com" }`.
    const dupError = Array.isArray(err.writeErrors)
      ? err.writeErrors.find((e) => e.code === 11000) || err.writeErrors[0]
      : err;
    const errmsg = dupError.errmsg || dupError.err?.errmsg || err.errmsg || "";
    const dupKeyMatch = errmsg.match(/dup key:\s*(\{[^}]*\})/);
    let field = "field";
    let value;
    if (dupKeyMatch) {
      try {
        // The dup key fragment is JS-object-literal shaped, not strict JSON
        // (unquoted keys) — eval-free parse via Function is safe here since
        // it's our own driver-generated string, not user input.
        // eslint-disable-next-line no-new-func
        const parsed = new Function(`return ${dupKeyMatch[1]}`)();
        const keys = Object.keys(parsed);
        field = keys.find((k) => k !== "shop") || keys[0] || "field";
        value = parsed[field];
      } catch {
        // fall through with defaults
      }
    }
    return res.status(400).json({ message: `${field} already in use${value ? ` (${value})` : ""}` });
  }

  if (err.name === "CastError") {
    return res.status(400).json({ message: `Invalid ${err.path}: ${err.value}` });
  }

  console.error(err);
  res.status(err.statusCode || 500).json({ message: err.message || "Server error" });
}

module.exports = { notFound, errorHandler };
