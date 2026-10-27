const crypto = require("crypto");

// Time-based one-time passwords (RFC 6238) — the 6-digit codes authenticator
// apps show. SHA-1, 30-second steps, 6 digits: the defaults every
// authenticator app understands.

const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of String(text).toUpperCase().replace(/=+$/, "").replace(/\s+/g, "")) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

// A fresh random secret, base32 text as authenticator apps expect.
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeForStep(secretBase32, step, digits = DIGITS) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const hmac = crypto.createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];

  return String(binary % 10 ** digits).padStart(digits, "0");
}

function stepAt(timeMs) {
  return Math.floor(timeMs / 1000 / STEP_SECONDS);
}

// Checks a code against the current step and one step either side (clock
// drift). Returns the matching step, or null. Callers store the step so the
// same code can't be used twice (`afterStep`: only steps after it count).
function verifyCode(secretBase32, code, { now = Date.now(), afterStep = -1, window = 1 } = {}) {
  const text = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(text)) return null;

  const current = stepAt(now);
  for (let step = current - window; step <= current + window; step++) {
    if (step <= afterStep) continue;

    const expected = codeForStep(secretBase32, step);
    const a = Buffer.from(expected);
    const b = Buffer.from(text);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return step;
  }

  return null;
}

// The link authenticator apps import (also what a QR code would contain).
function otpauthUrl({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = {
  STEP_SECONDS,
  base32Encode,
  base32Decode,
  generateSecret,
  codeForStep,
  stepAt,
  verifyCode,
  otpauthUrl,
};
