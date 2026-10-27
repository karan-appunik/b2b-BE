const { begin, complete, release, hashRequest } = require("../services/idempotency.service");

// These three endpoints let a service that does the work elsewhere (the
// storefront checkout proxy creating a Shopify draft order) use the same
// idempotency store: begin before the work, then complete or release after.

function claimFrom(body) {
  const { shop, scope, key } = body;
  return { shop, scope: String(scope || ""), key: String(key || "") };
}

function valid(claim) {
  return claim.shop && claim.scope && claim.key;
}

// POST /api/internal/idempotency/begin — body: { shop, scope, key, request }
// `request` is whatever identifies the request's content; it is hashed here.
async function beginOperation(req, res, next) {
  try {
    const claim = claimFrom(req.body);
    if (!valid(claim)) return res.status(400).json({ message: "shop, scope and key are required" });

    const result = await begin({ ...claim, requestHash: hashRequest(req.body.request ?? null) });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// POST /api/internal/idempotency/complete — body: { shop, scope, key, response: { status, body } }
async function completeOperation(req, res, next) {
  try {
    const claim = claimFrom(req.body);
    if (!valid(claim) || !req.body.response) {
      return res.status(400).json({ message: "shop, scope, key and response are required" });
    }

    await complete({ ...claim, response: req.body.response });
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// POST /api/internal/idempotency/release — body: { shop, scope, key }
async function releaseOperation(req, res, next) {
  try {
    const claim = claimFrom(req.body);
    if (!valid(claim)) return res.status(400).json({ message: "shop, scope and key are required" });

    await release(claim);
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { beginOperation, completeOperation, releaseOperation };
