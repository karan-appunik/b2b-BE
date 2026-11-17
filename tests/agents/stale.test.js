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
const ContextSession = R("src/models/contextSession.model");
const Audit = R("src/models/auditEvent.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_stale");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const call = async (m, p, body, headers = IH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });
  const q = (n) => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}`;
  await call("GET", "/api/roles", null, AH);

  const rep = await mk("rep", { role: "sales_admin" });
  const other = await mk("other", { role: "sales_admin" });
  const c1 = await mk("c1"), c2 = await mk("c2");
  await Grant.create({ shop, agent: rep._id, scopeType: "customer", scopeId: String(c1._id) });

  const enter = async () => (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("rep"), customerId: String(c1._id) })).j;
  const state = async () => (await call("GET", "/api/internal/agent/contexts/current" + q("rep"))).j.state;
  const auth = (permission, ctx) => call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctx, permission });

  let c = await enter();
  const ctx = c.contextId;
  ok("a new context is ACTIVE", c.state === "ACTIVE" && (await state()) === "ACTIVE", c);
  let r = await auth("order.submit", ctx);
  ok("and sensitive actions are allowed", r.s === 200 && r.j.allowed === true, r);

  // ---- a role change makes it stale
  const adminRole = (await call("GET", "/api/roles", null, AH)).j.roles.find((x) => x.key === "sales_admin");
  r = await call("PUT", `/api/roles/sales_admin`, { name: adminRole.name, description: "changed", permissions: adminRole.permissions }, AH);
  ok("the role is edited", r.s === 200, r);
  ok("the context is now STALE", (await state()) === "STALE");
  r = await auth("order.submit", ctx);
  ok("placing an order is refused until refreshed (401 CONTEXT_STALE)", r.s === 401 && r.j.code === "CONTEXT_STALE", r);
  r = await auth("price.override", ctx);
  ok("so is an exception", r.s === 401 && r.j.code === "CONTEXT_STALE", r);
  r = await call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctx, type: "SHIPPING_PRICE", baseline: { amount: 1, currency: "USD" }, proposed: { amount: 0, currency: "USD" }, reasonCode: "OTHER", reasonText: "x" });
  ok("creating an exception is refused too (401)", r.s === 401 && r.j.code === "CONTEXT_STALE", r);
  r = await auth("customer.search", ctx);
  ok("reading carries on (a non-sensitive permission still answers)", r.s === 200 && r.j.allowed === true, r);
  r = await call("GET", `/api/internal/agent/carts/current${q("rep")}&contextId=${ctx}`);
  ok("the cart can still be read", r.s === 200, r);

  // ---- refreshing
  r = await call("POST", `/api/internal/agent/contexts/${ctx}/refresh`, { shop, agentShopifyCustomerId: gid("rep") });
  ok("refresh makes it ACTIVE again", r.s === 200 && r.j.state === "ACTIVE" && (await state()) === "ACTIVE", r);
  ok("the refresh is audited", !!(await Audit.findOne({ shop, action: "context.refreshed", objectId: ctx })));
  r = await auth("order.submit", ctx);
  ok("and sensitive actions work again", r.s === 200 && r.j.allowed === true, r);
  r = await call("POST", `/api/internal/agent/contexts/${ctx}/refresh`, { shop, agentShopifyCustomerId: gid("other") });
  ok("someone else can't refresh it (401)", r.s === 401, r);

  // ---- other things that make it stale
  await Grant.create({ shop, agent: rep._id, scopeType: "customer", scopeId: String(c2._id) });
  ok("a new access grant makes it stale", (await state()) === "STALE");
  await call("POST", `/api/internal/agent/contexts/${ctx}/refresh`, { shop, agentShopifyCustomerId: gid("rep") });
  r = await call("PUT", "/api/agent-settings", { stepUpAbovePercent: 25 }, AH);
  ok("a change to the pricing rules makes it stale", (await state()) === "STALE");
  await call("POST", `/api/internal/agent/contexts/${ctx}/refresh`, { shop, agentShopifyCustomerId: gid("rep") });
  r = await call("PUT", "/api/agent-settings", { quietHoursStart: 21, quietHoursEnd: 7, digestEnabled: false }, AH);
  ok("a change to alert times or summaries does NOT", (await state()) === "ACTIVE");

  // ---- an old context with no snapshot is left alone
  await ContextSession.updateOne({ _id: ctx }, { $unset: { "authzSnapshot.roleVersion": 1, "authzSnapshot.grantsHash": 1, "authzSnapshot.policyStamp": 1 } });
  await call("PUT", "/api/agent-settings", { stepUpAbovePercent: 30 }, AH);
  ok("a context from before this feature is never stale", (await state()) === "ACTIVE");

  // ---- access lost: a refresh ends it (a role limited to assigned accounts)
  await Customer.updateOne({ _id: rep._id }, { $set: { role: "sales_agent" } });
  c = await enter();
  const ctx2 = c.contextId;
  await Grant.deleteOne({ shop, agent: rep._id, scopeId: String(c1._id) });
  r = await call("POST", `/api/internal/agent/contexts/${ctx2}/refresh`, { shop, agentShopifyCustomerId: gid("rep") });
  ok("if access to the customer is gone, refreshing ends the context (401)", r.s === 401 && !!(await ContextSession.findById(ctx2)).revokedAt, r);
  r = await call("POST", `/api/internal/agent/contexts/notanid/refresh`, { shop, agentShopifyCustomerId: gid("rep") });
  ok("a bad context id (401)", r.s === 401);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
