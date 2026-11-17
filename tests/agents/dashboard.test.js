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
const Quote = R("src/models/quote.model");
const Override = R("src/models/overrideRequest.model");
const AgentCart = R("src/models/agentCart.model");
const ContextSession = R("src/models/contextSession.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_dashboard");
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

  const rep = await mk("rep", { role: "sales_agent" });
  const boss = await mk("boss", { role: "sales_manager" });
  const cs = [];
  for (let i = 1; i <= 12; i++) cs.push(await mk("c" + i));
  const outside = await mk("outside");
  for (const c of cs) await Grant.create({ shop, agent: rep._id, scopeType: "customer", scopeId: String(c._id) });
  await Grant.create({ shop, agent: boss._id, scopeType: "customer", scopeId: String(cs[0]._id) });

  // ---- metrics
  await AgentCart.create({ shop, agent: rep._id, customer: cs[0]._id, items: [{ variantId: "1", quantity: 1 }] });
  await AgentCart.create({ shop, agent: rep._id, customer: cs[1]._id, items: [{ variantId: "1", quantity: 1 }] });
  await AgentCart.create({ shop, agent: rep._id, customer: cs[2]._id, items: [] });
  for (const status of ["DRAFT", "SENT", "PENDING_APPROVAL", "CONVERTED", "CHANGES_REQUESTED"]) {
    await Quote.create({ shop, number: "Q-" + status, customer: cs[0]._id, ownerAgent: rep._id, status });
  }
  await Override.create({ shop, agent: rep._id, customer: cs[0]._id, type: "UNIT_PRICE", permission: "price.override", baseline: { amount: 100, currency: "USD" }, proposed: { amount: 80, currency: "USD" }, deltaPercent: 20, reasonCode: "OTHER", reasonText: "x", status: "PENDING_APPROVAL" });
  let r = await call("GET", "/api/internal/agent/dashboard" + q("rep"));
  ok("assigned accounts, open carts (the empty one is not), pending quotes (sent, waiting, changes: 3)", r.s === 200 && r.j.assignedCount === 12 && r.j.metrics.openCarts === 2 && r.j.metrics.pendingQuotes === 3, r.j.metrics);
  ok("approvals the agent may decide: none for a sales agent", r.j.metrics.approvalsToDecide === 0);
  r = await call("GET", "/api/internal/agent/dashboard" + q("boss"));
  ok("approvals waiting for a manager who may decide them (1)", r.j.metrics.approvalsToDecide === 1, r.j.metrics);
  r = await call("GET", "/api/internal/agent/dashboard" + q("rep"));
  ok("carts to resume: the two customers with items, newest first", r.j.cartAccounts.length === 2, r.j.cartAccounts);

  // ---- recent
  r = await call("GET", "/api/internal/agent/dashboard" + q("rep"));
  ok("no visits yet -> no recent accounts", r.j.recent.length === 0);
  for (let i = 0; i < 7; i++) {
    await ContextSession.create({ shop, agent: rep._id, customer: cs[i]._id, issuedAt: new Date(Date.now() - (10 - i) * 60000), expiresAt: new Date(Date.now() + 3600e3) });
  }
  await ContextSession.create({ shop, agent: rep._id, customer: cs[0]._id, issuedAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  r = await call("GET", "/api/internal/agent/dashboard" + q("rep"));
  ok("recent: last 5 distinct accounts, most recent first (c1 visited again, then c7, c6, c5, c4)", r.j.recent.map((a) => a.name).join() === "c1,c7,c6,c5,c4", r.j.recent.map((a) => a.name));

  // ---- pins
  const pin = (n, id, pinned) => call("POST", "/api/internal/agent/pins", { shop, agentShopifyCustomerId: gid(n), customerId: String(id), pinned });
  r = await pin("rep", cs[8]._id, true);
  ok("pinning an account works", r.s === 200 && r.j.pinned === true, r);
  r = await pin("rep", cs[8]._id, true);
  ok("pinning twice is harmless", r.s === 200);
  r = await call("GET", "/api/internal/agent/dashboard" + q("rep"));
  ok("pinned accounts are listed, and flagged in the main list", r.j.pinned.length === 1 && r.j.pinned[0].name === "c9" && r.j.accounts.find((a) => a.name === "c9").pinned === true && r.j.accounts.find((a) => a.name === "c1").pinned === false, r.j.pinned);
  r = await pin("rep", outside._id, true);
  ok("an account the agent has no access to can't be pinned (404)", r.s === 404, r);
  r = await pin("boss", cs[8]._id, true);
  ok("...nor someone else's account (404)", r.s === 404, r);
  r = await call("POST", "/api/internal/agent/pins", { shop, agentShopifyCustomerId: gid("rep"), customerId: "nope", pinned: true });
  ok("a bad id is refused (404)", r.s === 404, r);
  r = await pin("rep", cs[8]._id, false);
  r = await call("GET", "/api/internal/agent/dashboard" + q("rep"));
  ok("unpinning removes it", r.j.pinned.length === 0);
  for (let i = 0; i < 10; i++) await pin("rep", cs[i]._id, true);
  r = await pin("rep", cs[10]._id, true);
  ok("at most 10 pins (400)", r.s === 400 && r.j.code === "TOO_MANY_PINS", r);
  r = await call("POST", "/api/internal/agent/pins", { shop, agentShopifyCustomerId: gid("ghost"), customerId: String(cs[0]._id), pinned: true });
  ok("a non-agent can't pin (403)", r.s === 403);

  // ---- a pinned account the agent later loses access to disappears
  await Grant.deleteOne({ shop, agent: rep._id, scopeId: String(cs[0]._id) });
  r = await call("GET", "/api/internal/agent/dashboard" + q("rep"));
  ok("an account whose access was taken away leaves pinned and recent lists", !r.j.pinned.some((a) => a.name === "c1") && !r.j.recent.some((a) => a.name === "c1"), [r.j.pinned.map((a) => a.name), r.j.recent.map((a) => a.name)]);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
