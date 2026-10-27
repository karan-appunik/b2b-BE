const crypto = require("crypto");

const IdempotencyKey = require("../models/idempotencyKey.model");

const KEEP_MS = 24 * 60 * 60 * 1000;
// An operation still "in progress" after this long is assumed to have died
// (crash, lost connection) and may be taken over by a retry.
const STALE_AFTER_MS = 2 * 60 * 1000;

function hashRequest(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// Claims a key. Returns one of:
//   { state: "new" }                       — go ahead and do the work
//   { state: "replay", response }          — already done: return this again
//   { state: "in_progress" }               — another attempt is still running
//   { state: "conflict" }                  — same key, different request
async function begin({ shop, scope, key, requestHash }) {
  const now = new Date();

  try {
    await IdempotencyKey.create({
      shop,
      scope,
      key,
      requestHash,
      expiresAt: new Date(now.getTime() + KEEP_MS),
    });
    return { state: "new" };
  } catch (err) {
    if (err.code !== 11000) throw err;
  }

  const existing = await IdempotencyKey.findOne({ shop, scope, key });
  if (!existing) return begin({ shop, scope, key, requestHash }); // expired between the two calls

  if (existing.requestHash !== requestHash) return { state: "conflict" };
  if (existing.status === "completed") return { state: "replay", response: existing.response };

  if (now.getTime() - existing.startedAt.getTime() > STALE_AFTER_MS) {
    // Take over only if nobody else did first.
    const taken = await IdempotencyKey.findOneAndUpdate(
      { _id: existing._id, status: "in_progress", startedAt: existing.startedAt },
      { $set: { startedAt: now } }
    );
    if (taken) return { state: "new" };
  }

  return { state: "in_progress" };
}

async function complete({ shop, scope, key, response }) {
  await IdempotencyKey.updateOne({ shop, scope, key }, { $set: { status: "completed", response } });
}

// The attempt failed: forget the key so a retry can run the work again.
async function release({ shop, scope, key }) {
  await IdempotencyKey.deleteOne({ shop, scope, key, status: "in_progress" });
}

// Express wrapper: when the request carries an `Idempotency-Key` header, a
// repeat of the same request returns the first response instead of running
// the handler again. Only successful (2xx) responses are remembered; a
// failure releases the key so the caller can retry. Requests without the
// header run normally unless `required` is set.
function idempotent(scope, { required = false } = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    try {
      const key = req.headers["idempotency-key"];

      if (!key) {
        if (!required) return next();
        return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "An Idempotency-Key header is required" });
      }

      const shop = (req.body && req.body.shop) || (req.query && req.query.shop);
      const claim = {
        shop,
        scope,
        key: String(key),
        requestHash: hashRequest({ method: req.method, path: req.baseUrl + req.path, body: req.body || null }),
      };

      const result = await begin(claim);

      if (result.state === "replay") {
        res.set("Idempotent-Replayed", "true");
        return res.status(result.response.status).json(result.response.body);
      }
      if (result.state === "conflict") {
        return res.status(409).json({
          code: "IDEMPOTENCY_CONFLICT",
          message: "This Idempotency-Key was already used for a different request",
        });
      }
      if (result.state === "in_progress") {
        return res.status(409).json({
          code: "IDEMPOTENCY_IN_PROGRESS",
          message: "This request is already being processed",
        });
      }

      const send = res.json.bind(res);
      res.json = (body) => {
        const done =
          res.statusCode >= 200 && res.statusCode < 300
            ? complete({ ...claim, response: { status: res.statusCode, body } })
            : release(claim);

        done.catch((err) => console.error("[idempotency] could not record result", err));
        return send(body);
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { hashRequest, begin, complete, release, idempotent };
