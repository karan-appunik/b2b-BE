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
const User = R("src/models/user.model");
const totp = R("src/services/totp.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_stepvalue");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const user = await User.create({ name: "M", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  let call = async (m, p, body, headers = IH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json() };
  };

  // A role, grant or setting changed mid-test makes a context STALE (spec §5.2):
  // refresh it the way the storefront would, then try again.
  {
    const _raw = call;
    call = async (m, p, body, headers) => {
      let r = await _raw(m, p, body, headers);
      if (r.s === 401 && r.j && r.j.code === "CONTEXT_STALE") {
        const qs = new URL("http://x" + p).searchParams;
        const ctxId = (body && body.contextId) || qs.get("contextId");
        const agentId = (body && body.agentShopifyCustomerId) || qs.get("agentShopifyCustomerId");
        if (ctxId && agentId) {
          await _raw("POST", "/api/internal/agent/contexts/" + ctxId + "/refresh", { shop, agentShopifyCustomerId: agentId }, IH);
          r = await _raw(m, p, body, headers);
        }
      }
      return r;
    };
  }
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: gid(name), ...extra });

  await call("GET", "/api/roles", null, AH);
  const mgr = await mkc("mgr", { role: "sales_manager" });   // price.override up to 20%
  const admin = await mkc("admin", { role: "sales_admin" }); // no MFA required in this run
  const custA = await mkc("custA");
  await Grant.create({ shop, agent: mgr._id, scopeType: "customer", scopeId: String(custA._id) });
  const enter = async (n) => (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid(n), customerId: String(custA._id) })).j.contextId;
  const ctxM = await enter("mgr");
  const ctxA = await enter("admin");
  const CART = [{ variantId: "111", quantity: 10 }];
  for (const [n, c] of [["mgr", ctxM], ["admin", ctxA]]) await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid(n), contextId: c, items: CART });

  const ask = (n, c, over = {}) => call("POST", "/api/internal/agent/overrides", {
    shop, agentShopifyCustomerId: gid(n), contextId: c, type: "UNIT_PRICE", lineVariantId: "111",
    baseline: { amount: 10000, currency: "USD" }, proposed: { amount: 9500, currency: "USD" },
    reasonCode: "LOYALTY", reasonText: "test", ...over,
  });
  const pct = (p) => ({ proposed: { amount: Math.round(10000 * (1 - p / 100)), currency: "USD" } });

  // settings
  let r = await call("GET", "/api/agent-settings", null, AH);
  ok("default: step-up above 10%", r.j.stepUpAbovePercent === 10, r.j);
  r = await call("PUT", "/api/agent-settings", { stepUpAbovePercent: 150 }, AH);
  ok("out of range refused", r.s === 400, r);

  // a role that does not use MFA is never asked
  r = await ask("admin", ctxA, pct(40));
  ok("no MFA on the role -> never asked for a code, even for 40%", r.j.status === "AUTO_APPROVED", r.j);

  // the manager's role requires MFA
  await call("PUT", "/api/roles/sales_manager", { requireMfa: true }, AH);
  // enrolment is only needed for the code itself; contexts already exist
  // (an existing context pauses without MFA, so verify the session first)
  const en = await call("POST", "/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: gid("mgr") });
  const secret = en.j.secret;
  const verify = (purpose, plus = 0) => call("POST", "/api/internal/agent/mfa/verify", { shop, agentShopifyCustomerId: gid("mgr"), code: totp.codeForStep(secret, totp.stepAt(Date.now()) + plus), purpose });
  r = await verify("session");
  ok("manager signs in with MFA", r.s === 200, r);
  await Customer.updateOne({ _id: mgr._id }, { $unset: { "mfa.stepUpUntil": 1 } });

  r = await ask("mgr", ctxM, pct(5));
  ok("a 5% change (below the 10% line) goes through without a code", r.j.status === "AUTO_APPROVED", r.j);
  r = await ask("mgr", ctxM, pct(9.99));
  ok("9.99% is still below the line", r.j.status === "AUTO_APPROVED", r.j);
  r = await ask("mgr", ctxM, pct(10));
  ok("exactly 10% is high-value: a code is needed", r.j.status === "DENIED" && r.j.denyReason === "STEP_UP_REQUIRED", r.j);
  r = await ask("mgr", ctxM, pct(15));
  ok("15% needs a code", r.j.status === "DENIED" && r.j.denyReason === "STEP_UP_REQUIRED", r.j);
  r = await ask("mgr", ctxM, pct(15));
  const refused = await mongoose.connection.collection("overriderequests").findOne({ _id: new mongoose.Types.ObjectId(r.j.id) });
  ok("the refusal says STEP_UP_REQUIRED and nothing was approved", refused.status === "DENIED", refused.status);

  r = await verify("step_up", 1);
  ok("a step-up check passes", r.s === 200, r);
  r = await ask("mgr", ctxM, pct(15));
  ok("after it, the 15% change is judged normally (within the manager's 20% -> approved)", r.j.status === "AUTO_APPROVED", r.j);
  r = await ask("mgr", ctxM, pct(25));
  ok("and 25% (over 20%) goes for approval", r.j.status === "PENDING_APPROVAL", r.j);

  // after the check lapses it is asked again, but only for big ones
  await Customer.updateOne({ _id: mgr._id }, { $set: { "mfa.stepUpUntil": new Date(Date.now() - 1000) } });
  r = await ask("mgr", ctxM, pct(3));
  ok("when the check lapses, small changes still don't need one", r.j.status === "AUTO_APPROVED", r.j);
  r = await ask("mgr", ctxM, pct(12));
  ok("...but a big one asks again", r.j.denyReason === "STEP_UP_REQUIRED", r.j);

  // a custom line has no baseline: always high-value
  await call("PUT", "/api/roles/sales_manager", { requireMfa: true, permissions: [
    { key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "cart.create" }, { key: "cart.write" },
    { key: "price.override", constraints: { maxDeltaPercent: 20 } }, { key: "custom_line.create" }, { key: "shipping.override" },
  ] }, AH);
  const custom = (n, c) => call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid(n), contextId: c, type: "CUSTOM_LINE", custom: { title: "Install fee", quantity: 1, taxCode: "STD" }, baseline: { amount: 0, currency: "USD" }, proposed: { amount: 500, currency: "USD" }, reasonCode: "OTHER", reasonText: "fee" });
  r = await custom("mgr", ctxM);
  ok("a custom line (nothing to compare with) always needs the code", r.j.denyReason === "STEP_UP_REQUIRED", r.j);
  // time passes: an earlier code was used, so a later 30-second step is available
  await Customer.updateOne({ _id: mgr._id }, { $set: { "mfa.lastUsedStep": totp.stepAt(Date.now()) - 5 } });
  await verify("step_up", 0);
  r = await custom("mgr", ctxM);
  ok("...and goes through after it", r.j.status === "AUTO_APPROVED", r.j);

  // hard rules come first: a refused request never asks for a code
  await Customer.updateOne({ _id: mgr._id }, { $set: { "mfa.stepUpUntil": new Date(Date.now() - 1000) } });
  await call("PUT", "/api/agent-settings", { hardFloorPercent: 90 }, AH);
  r = await ask("mgr", ctxM, pct(50));
  ok("below the price floor is refused for that reason, not for a missing code", r.j.status === "DENIED" && r.j.denyReason === "BELOW_FLOOR", r.j);
  await call("PUT", "/api/agent-settings", { hardFloorPercent: null }, AH);

  // blank setting: every exception needs the check
  await call("PUT", "/api/agent-settings", { stepUpAbovePercent: null }, AH);
  r = await call("GET", "/api/agent-settings", null, AH);
  ok("setting can be cleared (every exception asks)", r.j.stepUpAbovePercent === null, r.j);
  r = await ask("mgr", ctxM, pct(1));
  ok("then even a 1% change needs the code", r.j.denyReason === "STEP_UP_REQUIRED", r.j);

  // threshold 0 = also every one (>= 0)
  await call("PUT", "/api/agent-settings", { stepUpAbovePercent: 0 }, AH);
  r = await ask("mgr", ctxM, pct(1));
  ok("a threshold of 0% behaves the same", r.j.denyReason === "STEP_UP_REQUIRED", r.j);

  // other high-risk permissions are unchanged: always step-up
  const authorize = (permission) => call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: gid("mgr"), permission });
  await call("PUT", "/api/roles/sales_manager", { requireMfa: true, permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "payment_link.send" }, { key: "customer.create" }] }, AH);
  r = await authorize("customer.create");
  ok("customer creation still always asks for the code (spec: privileged customer creation)", r.j.allowed === false && r.j.reason === "STEP_UP_REQUIRED", r.j);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
