function protectInternal(req, res, next) {
  const key = req.headers["x-internal-api-key"];

  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ message: "Not authorized" });
  }

  next();
}

module.exports = { protectInternal };
