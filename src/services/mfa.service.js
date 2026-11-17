const crypto = require("crypto");

const Customer = require("../models/customer.model");
const { generateSecret, verifyCode, stepAt, otpauthUrl } = require("./totp.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");

const ISSUER = "SparkLayer";
const SESSION_MS = (Number(process.env.MFA_SESSION_HOURS) || 12) * 60 * 60 * 1000;
const STEP_UP_MS = 10 * 60 * 1000;
// How long an unconfirmed key keeps being shown again before a fresh one is made.
const ENROLL_REUSE_MS = 30 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

// ---- secret at rest: AES-256-GCM, never stored or logged in clear

let warnedAboutDerivedKey = false;

function encryptionKey() {
  const configured = process.env.MFA_ENCRYPTION_KEY;
  if (configured) return crypto.createHash("sha256").update(configured).digest();

  if (!warnedAboutDerivedKey) {
    warnedAboutDerivedKey = true;
    console.warn("[mfa] MFA_ENCRYPTION_KEY is not set — deriving a key from JWT_SECRET. Set a dedicated key in production.");
  }
  return crypto.createHash("sha256").update(`${process.env.JWT_SECRET || ""}:mfa`).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

function decrypt(stored) {
  const [iv, tag, data] = stored.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// ---- state

async function loadAgent(agentId) {
  return Customer.findById(agentId).select("+mfa.secretEnc");
}

function agentActor(agent) {
  return { actorType: "sales_agent", actor: agent._id, actorShopifyCustomerId: agent.shopifyCustomerId };
}

function isLocked(agent, now = new Date()) {
  return !!(agent.mfa && agent.mfa.lockedUntil && agent.mfa.lockedUntil > now);
}

// What the agent's MFA looks like right now, for callers deciding what to ask.
function describe(agent, now = new Date()) {
  const mfa = agent.mfa || {};
  return {
    enrolled: !!mfa.enabled,
    verified: !!(mfa.enabled && mfa.verifiedUntil && mfa.verifiedUntil > now),
    stepUpValid: !!(mfa.enabled && mfa.stepUpUntil && mfa.stepUpUntil > now),
    locked: isLocked(agent, now),
  };
}

// Starts enrolment: makes a secret and returns it for the authenticator app.
// It only counts once a code from the app has been confirmed. Asking again
// shortly afterwards (a reload, a second click) returns the SAME key, so the
// one already typed into the phone keeps working; a new key is only made when
// the earlier one is old.
async function beginEnrollment(agent, now = new Date()) {
  const current = await loadAgent(agent._id);
  if (current && current.mfa && current.mfa.enabled) return { ok: false, reason: "ALREADY_ENROLLED" };

  const mfa = (current && current.mfa) || {};
  const recent = mfa.secretEnc && mfa.enrollStartedAt && now.getTime() - mfa.enrollStartedAt.getTime() < ENROLL_REUSE_MS;

  let secret;
  if (recent) {
    secret = decrypt(mfa.secretEnc);
  } else {
    secret = generateSecret();
    await Customer.updateOne(
      { _id: agent._id },
      {
        $set: {
          mfa: { enabled: false, secretEnc: encrypt(secret), failedCount: 0, lastUsedStep: -1, enrollStartedAt: now },
        },
      }
    );
  }

  return {
    ok: true,
    secret,
    otpauthUrl: otpauthUrl({ secret, account: agent.email, issuer: ISSUER }),
  };
}

// Checks a code. `purpose` is "session" (normal sign-in check) or "step_up"
// (re-check before a risky action). The first valid code of an unconfirmed
// enrolment switches MFA on. Returns { ok, reason? , until? }.
async function verify(shop, agentId, code, purpose = "session", now = new Date()) {
  const agent = await loadAgent(agentId);
  if (!agent || !agent.mfa || !agent.mfa.secretEnc) return { ok: false, reason: "NOT_ENROLLED" };

  if (isLocked(agent, now)) return { ok: false, reason: "LOCKED", lockedUntil: agent.mfa.lockedUntil };

  const step = verifyCode(decrypt(agent.mfa.secretEnc), code, {
    now: now.getTime(),
    afterStep: agent.mfa.lastUsedStep ?? -1,
  });

  if (step === null) {
    const failedCount = (agent.mfa.failedCount || 0) + 1;
    const lock = failedCount >= MAX_FAILURES;

    await Customer.updateOne(
      { _id: agent._id },
      {
        $set: {
          "mfa.failedCount": lock ? 0 : failedCount,
          ...(lock ? { "mfa.lockedUntil": new Date(now.getTime() + LOCK_MS) } : {}),
        },
      }
    );
    await recordAudit({
      shop,
      ...agentActor(agent),
      action: AUDIT_ACTIONS.MFA_FAILED,
      outcome: "denied",
      reasonCode: lock ? "LOCKED_OUT" : "WRONG_CODE",
      metadata: { purpose },
    });

    return { ok: false, reason: lock ? "LOCKED" : "WRONG_CODE" };
  }

  const firstConfirmation = !agent.mfa.enabled;
  const until = new Date(now.getTime() + (purpose === "step_up" ? STEP_UP_MS : SESSION_MS));

  const set = {
    "mfa.enabled": true,
    "mfa.lastUsedStep": step,
    "mfa.failedCount": 0,
    "mfa.lockedUntil": null,
    // A confirmed code satisfies the sign-in check as well as a step-up.
    "mfa.verifiedUntil": purpose === "step_up" ? agent.mfa.verifiedUntil || until : until,
  };
  if (purpose === "step_up" || firstConfirmation) set["mfa.stepUpUntil"] = new Date(now.getTime() + STEP_UP_MS);
  if (firstConfirmation) set["mfa.enrolledAt"] = now;

  if (purpose !== "step_up") set["agentProfile.lastLoginAt"] = now;
  await Customer.updateOne({ _id: agent._id }, { $set: set });

  await recordAudit({
    shop,
    ...agentActor(agent),
    action: firstConfirmation ? AUDIT_ACTIONS.MFA_ENROLLED : AUDIT_ACTIONS.MFA_VERIFIED,
    metadata: { purpose },
  });

  return { ok: true, until, enrolled: firstConfirmation };
}

// An administrator clears an agent's MFA (lost phone): they enrol again.
async function reset(shop, agentId, byUserId) {
  const agent = await Customer.findOneAndUpdate(
    { _id: agentId, shop },
    { $unset: { mfa: 1 } },
    { new: true }
  );
  if (!agent) return null;

  await recordAudit({
    shop,
    actorType: "merchant_user",
    actor: byUserId,
    action: AUDIT_ACTIONS.MFA_RESET,
    objectType: "customer",
    objectId: String(agent._id),
  });

  return agent;
}

module.exports = {
  SESSION_MS,
  STEP_UP_MS,
  MAX_FAILURES,
  LOCK_MS,
  encrypt,
  decrypt,
  describe,
  beginEnrollment,
  verify,
  reset,
};
