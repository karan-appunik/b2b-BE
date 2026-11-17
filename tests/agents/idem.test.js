const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
const R = (m) => require(require("path").join(ROOT, m));
const mongoose = R("node_modules/mongoose");
const app = R("app");
const Customer = R("src/models/customer.model");
const Grant = R("src/models/agentScopeGrant.model");
const Ctx = R("src/models/contextSession.model");
const Key = R("src/models/idempotencyKey.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_idem");
  await mongoose.connection.dropDatabase();
  await Key.init();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const H = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const call = async (path, body, extra = {}) => {
    const r = await fetch(base + path, { method: "POST", headers: { ...H, ...extra }, body: JSON.stringify(body) });
    return { s: r.status, j: await r.json(), replayed: r.headers.get("idempotent-replayed") };
  };
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: "gid://shopify/Customer/" + name, ...extra });
  const agent = await mkc("agent", { role: "sales_agent" });
  const a = await mkc("custA");
  await Grant.create({ shop, agent: agent._id, scopeType: "customer", scopeId: String(a._id) });
  const aid = "gid://shopify/Customer/agent";
  const enter = { shop, agentShopifyCustomerId: aid, customerId: String(a._id) };

  // ---- middleware on POST /agent/contexts
  let r = await call("/api/internal/agent/contexts", enter, { "Idempotency-Key": "k1" });
  ok("first call creates a context", r.s === 201 && r.replayed === null, r);
  const first = r.j.contextId;
  r = await call("/api/internal/agent/contexts", enter, { "Idempotency-Key": "k1" });
  ok("same key + same request replays the first answer", r.s === 201 && r.j.contextId === first && r.replayed === "true", r);
  ok("only one context was created", (await Ctx.countDocuments({ agent: agent._id })) === 1);
  r = await call("/api/internal/agent/contexts", { ...enter, channel: "other" }, { "Idempotency-Key": "k1" });
  ok("same key + different request -> 409 IDEMPOTENCY_CONFLICT", r.s === 409 && r.j.code === "IDEMPOTENCY_CONFLICT", r);
  r = await call("/api/internal/agent/contexts", enter, { "Idempotency-Key": "k2" });
  ok("a new key does the work again", r.s === 201 && r.j.contextId !== first, r);
  r = await call("/api/internal/agent/contexts", enter);
  ok("no header -> runs normally (key optional here)", r.s === 201, r);

  // failures are not remembered, so a retry can succeed
  const denied = { shop, agentShopifyCustomerId: aid, customerId: String(new mongoose.Types.ObjectId()) };
  r = await call("/api/internal/agent/contexts", denied, { "Idempotency-Key": "k3" });
  ok("a refused request returns its error", r.s === 403, r);
  ok("...and leaves no key behind", (await Key.countDocuments({ key: "k3" })) === 0);

  // ---- begin / complete / release API (used by the checkout proxy)
  const op = (state) => ({ shop, scope: "checkout:1", key: "c1", request: { lines: [1, 2] }, ...state });
  r = await call("/api/internal/idempotency/begin", op());
  ok("begin: new", r.j.state === "new", r);
  r = await call("/api/internal/idempotency/begin", op());
  ok("begin again while running: in_progress", r.j.state === "in_progress", r);
  r = await call("/api/internal/idempotency/begin", op({ request: { lines: [9] } }));
  ok("begin with different content: conflict", r.j.state === "conflict", r);
  r = await call("/api/internal/idempotency/complete", { shop, scope: "checkout:1", key: "c1", response: { status: 200, body: { order: "#1" } } });
  ok("complete stores the result", r.j.ok === true, r);
  r = await call("/api/internal/idempotency/begin", op());
  ok("begin after complete: replay with the stored result", r.j.state === "replay" && r.j.response.body.order === "#1", r);

  r = await call("/api/internal/idempotency/begin", op({ key: "c2" }));
  ok("another key: new", r.j.state === "new", r);
  await call("/api/internal/idempotency/release", { shop, scope: "checkout:1", key: "c2" });
  r = await call("/api/internal/idempotency/begin", op({ key: "c2" }));
  ok("after release the key can be reused", r.j.state === "new", r);

  r = await call("/api/internal/idempotency/begin", op({ scope: "checkout:2" }));
  ok("same key text in another scope doesn't collide", r.j.state === "new", r);
  r = await call("/api/internal/idempotency/begin", { shop });
  ok("missing fields -> 400", r.s === 400, r);

  // a crashed attempt can be taken over once it's stale
  await call("/api/internal/idempotency/begin", op({ key: "c3" }));
  await Key.updateOne({ key: "c3" }, { startedAt: new Date(Date.now() - 5 * 60 * 1000) });
  r = await call("/api/internal/idempotency/begin", op({ key: "c3" }));
  ok("stale in-progress attempt is taken over", r.j.state === "new", r);

  // two simultaneous attempts: exactly one proceeds
  const results = await Promise.all(Array.from({ length: 6 }, () => call("/api/internal/idempotency/begin", op({ key: "race" }))));
  const states = results.map((x) => x.j.state);
  ok("6 simultaneous attempts -> exactly one 'new'", states.filter((x) => x === "new").length === 1 && states.filter((x) => x === "in_progress").length === 5, states);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
