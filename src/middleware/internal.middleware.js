function protectInternal(req, res, next) {
  const key = req.headers["x-internal-api-key"];

  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ message: "Not authorized" });
  }

  // POST routes send `shop` in the body; the read-only GET lookups
  // (customer search, agent context) send it as a query param instead.
  const shop = req.body?.shop || req.query?.shop;

  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ message: "shop is required" });
  }

  next();
}

module.exports = { protectInternal };
