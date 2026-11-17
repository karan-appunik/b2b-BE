const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
const R = (m) => require(require("path").join(ROOT, m));
const mongoose = R("node_modules/mongoose");
const jwt = R("node_modules/jsonwebtoken");
const app = R("app");
const Customer = R("src/models/customer.model");
const Grant = R("src/models/agentScopeGrant.model");
const Audit = R("src/models/auditEvent.model");
const User = R("src/models/user.model");
const totp = R("src/services/totp.service");
const mfaSvc = R("src/services/mfa.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  // ---- RFC 6238 test vectors (secret = ASCII "12345678901234567890")
  const rfcSecret = totp.base32Encode(Buffer.from("12345678901234567890"));
  ok("RFC 6238: T=59 -> 94287082 (8 digits)", totp.codeForStep(rfcSecret, totp.stepAt(59 * 1000), 8) === "94287082");
  ok("RFC 6238: T=1111111109 -> 07081804", totp.codeForStep(rfcSecret, totp.stepAt(1111111109 * 1000), 8) === "07081804");
  ok("RFC 6238: T=1234567890 -> 89005924", totp.codeForStep(rfcSecret, totp.stepAt(1234567890 * 1000), 8) === "89005924");
  ok("6-digit code is the last 6 of the 8-digit one", totp.codeForStep(rfcSecret, totp.stepAt(59 * 1000)) === "287082");
  ok("base32 round-trips", totp.base32Decode(totp.base32Encode(Buffer.from("hello world"))).toString() === "hello world");
  const sec0 = totp.generateSecret();
  ok("generated secret is 32 base32 characters", /^[A-Z2-7]{32}$/.test(sec0), sec0);

  const t0 = 1700000000000;
  const c0 = totp.codeForStep(sec0, totp.stepAt(t0));
  ok("accepts the current code", totp.verifyCode(sec0, c0, { now: t0 }) === totp.stepAt(t0));
  ok("accepts one step of clock drift", totp.verifyCode(sec0, totp.codeForStep(sec0, totp.stepAt(t0) - 1), { now: t0 }) !== null);
  ok("rejects two steps away", totp.verifyCode(sec0, totp.codeForStep(sec0, totp.stepAt(t0) + 2), { now: t0 }) === null);
  ok("rejects a code already used (replay)", totp.verifyCode(sec0, c0, { now: t0, afterStep: totp.stepAt(t0) }) === null);
  ok("rejects non-numeric / short input", totp.verifyCode(sec0, "12ab56", { now: t0 }) === null && totp.verifyCode(sec0, "123", { now: t0 }) === null);
  ok("secret encryption round-trips", mfaSvc.decrypt(mfaSvc.encrypt(sec0)) === sec0);
  let tampered = false;
  try { const e = mfaSvc.encrypt(sec0).split("."); e[2] = Buffer.from("zzzz").toString("base64"); mfaSvc.decrypt(e.join(".")); } catch (e) { tampered = true; }
  ok("tampered ciphertext is rejected", tampered);

  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_mfa");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const user = await User.create({ name: "M", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const call = async (m, p, body, headers = IH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json() };
  };
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: gid(name), ...extra });
  const status = (n) => call("GET", `/api/internal/agent/mfa/status?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}`);
  const enroll = (n) => call("POST", "/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: gid(n) });
  const verify = (n, code, purpose) => call("POST", "/api/internal/agent/mfa/verify", { shop, agentShopifyCustomerId: gid(n), code, purpose });
  const enter = (n, c) => call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid(n), customerId: String(c._id) });
  const nowCode = (secret, plusSteps = 0) => totp.codeForStep(secret, totp.stepAt(Date.now()) + plusSteps);

  const agent = await mkc("agent", { role: "sales_agent" });
  const mgr = await mkc("mgr", { role: "sales_manager" });
  const admin = await mkc("admin", { role: "sales_admin" });
  const custA = await mkc("custA");
  for (const ag of [agent, mgr]) await Grant.create({ shop, agent: ag._id, scopeType: "customer", scopeId: String(custA._id) });
  await call("GET", "/api/roles", null, AH);

  // ---- not required by default
  let r = await status("agent");
  ok("MFA not required by default", r.j.required === false && r.j.enrolled === false, r);
  r = await enter("agent", custA);
  ok("so entering a customer works without it", r.s === 201, r);

  // ---- turn it on for the role
  r = await call("PUT", "/api/roles/sales_agent", { requireMfa: true }, AH);
  ok("role can require MFA", r.s === 200 && r.j.requireMfa === true, r);
  r = await status("agent");
  ok("status now says required, not enrolled", r.j.required === true && r.j.enrolled === false && r.j.verified === false, r);
  r = await enter("agent", custA);
  ok("entering a customer is refused with MFA_REQUIRED", r.s === 403 && r.j.code === "MFA_REQUIRED", r);
  const refused = await Audit.findOne({ action: "context.denied", reasonCode: "MFA_REQUIRED" });
  ok("refusal audited", !!refused, refused);
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("agent"), customerId: String(new mongoose.Types.ObjectId()) });
  ok("MFA check comes first: an unknown customer gives the same answer (no customer leak)", r.s === 403 && r.j.code === "MFA_REQUIRED", r);

  // ---- enrolment
  r = await verify("agent", "123456");
  ok("verifying before setting up -> NOT_ENROLLED", r.s === 409 && r.j.code === "NOT_ENROLLED", r);
  r = await enroll("agent");
  ok("enrol returns a secret and an otpauth link", r.s === 200 && /^[A-Z2-7]{32}$/.test(r.j.secret) && r.j.otpauthUrl.startsWith("otpauth://totp/") && r.j.otpauthUrl.includes("secret=" + r.j.secret), r);
  const secret = r.j.secret;
  const raw = await Customer.findById(agent._id).select("+mfa.secretEnc").lean();
  ok("secret is stored encrypted, not in clear", raw.mfa.secretEnc && !JSON.stringify(raw).includes(secret), raw.mfa);
  const plainRead = await Customer.findById(agent._id).lean();
  ok("secret is not returned by normal reads", plainRead.mfa.secretEnc === undefined);
  r = await status("agent");
  ok("not switched on until a code is confirmed", r.j.enrolled === false, r);

  r = await verify("agent", "000000");
  ok("wrong code -> 401 WRONG_CODE", r.s === 401 && r.j.code === "WRONG_CODE", r);
  r = await verify("agent", nowCode(secret));
  ok("right code confirms enrolment", r.s === 200 && r.j.verified === true && r.j.enrolled === true, r);
  ok("enrolment audited", !!(await Audit.findOne({ action: "mfa.enrolled", actor: agent._id })));
  ok("wrong attempt audited", !!(await Audit.findOne({ action: "mfa.failed", reasonCode: "WRONG_CODE" })));
  r = await verify("agent", nowCode(secret));
  ok("the same code can't be used twice (replay)", r.s === 401, r);
  r = await enroll("agent");
  ok("can't enrol again while enrolled", r.s === 409 && r.j.code === "ALREADY_ENROLLED", r);

  r = await status("agent");
  ok("status: enrolled + verified", r.j.enrolled === true && r.j.verified === true && r.j.required === true, r);
  r = await enter("agent", custA);
  ok("entering a customer now works", r.s === 201, r);
  const ctx = r.j.contextId;

  // ---- session lapses: context pauses, not ends
  await Customer.updateOne({ _id: agent._id }, { $set: { "mfa.verifiedUntil": new Date(Date.now() - 1000) } });
  r = await call("GET", `/api/internal/agent/contexts/${ctx}/validate?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("agent"))}`);
  ok("lapsed MFA pauses the context (401 MFA_REQUIRED)", r.s === 401 && r.j.code === "MFA_REQUIRED", r);
  r = await verify("agent", nowCode(secret, 1));
  ok("a fresh code (next time step) passes", r.s === 200, r);
  r = await call("GET", `/api/internal/agent/contexts/${ctx}/validate?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("agent"))}`);
  ok("and the same context carries on (it was never ended)", r.s === 200, r);

  // ---- lockout
  let last;
  for (let i = 0; i < 5; i++) last = await verify("agent", "000000");
  ok("5 wrong codes lock the agent out (429)", last.s === 429 && last.j.code === "LOCKED", last);
  r = await verify("agent", nowCode(secret, 1));
  ok("even a right code is refused while locked", r.s === 429, r);
  ok("lockout audited", !!(await Audit.findOne({ action: "mfa.failed", reasonCode: "LOCKED_OUT" })));
  // time passes: the lock ends, and a later 30-second step is available
  await Customer.updateOne({ _id: agent._id }, { $set: { "mfa.lockedUntil": new Date(Date.now() - 1000), "mfa.lastUsedStep": totp.stepAt(Date.now()) - 5 } });
  r = await verify("agent", nowCode(secret));
  ok("after the lock ends the right code works", r.s === 200, r);

  // ---- step-up for high-risk permissions
  await call("PUT", "/api/roles/sales_manager", { requireMfa: true }, AH);
  const authorize = (n, permission) => call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: gid(n), permission });
  r = await authorize("mgr", "order.submit");
  ok("ordinary permission needs no step-up", r.j.allowed === true, r);
  r = await authorize("mgr", "price.override");
  ok("high-risk permission asks for step-up", r.j.allowed === false && r.j.reason === "STEP_UP_REQUIRED", r);
  const mgrEnroll = await enroll("mgr");
  r = await verify("mgr", nowCode(mgrEnroll.j.secret), "step_up");
  ok("a step-up check (also confirms enrolment)", r.s === 200, r);
  r = await authorize("mgr", "price.override");
  ok("high-risk permission now allowed", r.j.allowed === true && r.j.constraints.maxDeltaPercent === 20, r);
  await Customer.updateOne({ _id: mgr._id }, { $set: { "mfa.stepUpUntil": new Date(Date.now() - 1000) } });
  r = await authorize("mgr", "price.override");
  ok("step-up expires after a few minutes", r.j.allowed === false && r.j.reason === "STEP_UP_REQUIRED", r);

  // ---- roles that don't require it are untouched
  r = await authorize("admin", "price.override");
  ok("a role without requireMfa never asks", r.j.allowed === true, r);

  // ---- reset by an administrator
  r = await call("POST", `/api/agents/${agent._id}/mfa/reset`, null, AH);
  ok("merchant can reset an agent's MFA", r.s === 200, r);
  r = await status("agent");
  ok("after reset the agent must set up again", r.j.enrolled === false && r.j.verified === false, r);
  ok("reset audited", !!(await Audit.findOne({ action: "mfa.reset", objectId: String(agent._id) })));
  r = await call("POST", `/api/agents/${agent._id}/mfa/reset`, null, IH);
  ok("reset needs a merchant login", r.s === 401, r);
  r = await enter("agent", custA);
  ok("until then, entering a customer is refused again", r.s === 403 && r.j.code === "MFA_REQUIRED", r);

  // ---- not an agent
  const plain = await mkc("plain");
  r = await status("plain");
  ok("a plain customer gets nothing", r.s === 403, r);
  r = await enroll("plain");
  ok("...and can't enrol", r.s === 403, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
