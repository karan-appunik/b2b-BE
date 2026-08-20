function protectInternal(req, res, next) {
  const key = req.headers["x-internal-api-key"];

  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ message: "Not authorized" });
  }

  if (!req.body.shop || typeof req.body.shop !== "string") {
    return res.status(400).json({ message: "shop is required" });
  }

  next();
}

module.exports = { protectInternal };
