const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
const R = (m) => require(require("path").join(ROOT, m));
const mongoose = R("node_modules/mongoose");
const app = R("app");
const Customer = R("src/models/customer.model");
const totp = R("src/services/totp.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_enroll");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const H = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const call = async (p, body) => {
    const r = await fetch(base + p, { method: "POST", headers: H, body: JSON.stringify(body) });
    return { s: r.status, j: await r.json() };
  };
  const agent = await Customer.create({ name: "agent", email: "a@x.com", shop, shopifyCustomerId: "gid://shopify/Customer/agent", role: "sales_agent" });
  const aid = "gid://shopify/Customer/agent";

  const first = await call("/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: aid });
  const second = await call("/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: aid });
  const third = await call("/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: aid });
  ok("asking again (reload / second click) shows the SAME key", first.j.secret === second.j.secret && second.j.secret === third.j.secret, [first.j.secret, second.j.secret]);
  ok("and the same authenticator link", first.j.otpauthUrl === third.j.otpauthUrl);

  // the key shown first still works after several re-asks
  const code = totp.codeForStep(first.j.secret, totp.stepAt(Date.now()));
  const v = await call("/api/internal/agent/mfa/verify", { shop, agentShopifyCustomerId: aid, code, purpose: "session" });
  ok("a code from the first key confirms enrolment", v.s === 200 && v.j.enrolled === true, v);

  // an old unconfirmed key is replaced after the reuse window
  const other = await Customer.create({ name: "b", email: "b@x.com", shop, shopifyCustomerId: "gid://shopify/Customer/b", role: "sales_agent" });
  const b1 = await call("/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: "gid://shopify/Customer/b" });
  await Customer.updateOne({ _id: other._id }, { $set: { "mfa.enrollStartedAt": new Date(Date.now() - 31 * 60 * 1000) } });
  const b2 = await call("/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: "gid://shopify/Customer/b" });
  ok("a key older than 30 minutes is replaced by a fresh one", b1.j.secret !== b2.j.secret, [b1.j.secret, b2.j.secret]);
  const b3 = await call("/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: "gid://shopify/Customer/b" });
  ok("and that fresh one is then stable too", b2.j.secret === b3.j.secret);

  // a pre-fix pending record (no start time) is replaced once, then stable
  const legacy = await Customer.create({ name: "c", email: "c@x.com", shop, shopifyCustomerId: "gid://shopify/Customer/c", role: "sales_agent" });
  const mfa = R("src/services/mfa.service");
  await Customer.updateOne({ _id: legacy._id }, { $set: { mfa: { enabled: false, secretEnc: mfa.encrypt(totp.generateSecret()), failedCount: 0, lastUsedStep: -1 } } });
  const c1 = await call("/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: "gid://shopify/Customer/c" });
  const c2 = await call("/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: "gid://shopify/Customer/c" });
  ok("a record from before this fix gets one fresh key, then stays stable", c1.s === 200 && c1.j.secret === c2.j.secret, [c1.j.secret, c2.j.secret]);

  // already enrolled -> still refused
  const again = await call("/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: aid });
  ok("enrolled agents still can't enrol again", again.s === 409, again);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
