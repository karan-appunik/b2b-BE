const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
const R = (m) => require(require("path").join(ROOT, m));
const mongoose = R("node_modules/mongoose");
const jwt = R("node_modules/jsonwebtoken");
const app = R("app");
const User = R("src/models/user.model");
const Customer = R("src/models/customer.model");
const Grant = R("src/models/agentScopeGrant.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_entity");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const user = await User.create({ name: "M", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const adm = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: AH, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => null) }; };
  const int = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: IH, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => null) }; };
  await adm("GET", "/api/roles");
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });
  const agent = await mk("agent", { role: "sales_agent" });
  const inC = await mk("inc", { legalEntity: "LE_IN" });
  const ukC = await mk("ukc", { legalEntity: "LE_UK" });
  const noC = await mk("noc");
  for (const c of [inC, ukC, noC]) await Grant.create({ shop, agent: agent._id, scopeType: "customer", scopeId: String(c._id) });
  const enter = (c, channel) => int("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("agent"), customerId: String(c._id), channel });

  let r = await enter(ukC);
  ok("no legal entities set on the agent: any customer is fine", r.s === 201 || r.s === 200, r);

  r = await adm("PUT", `/api/customers/${agent._id}`, { agentProfile: { legalEntities: "LE_IN, LE_US" } });
  ok("admin sets the agent's legal entities", r.s === 200 && (await Customer.findById(agent._id)).agentProfile.legalEntities.join() === "LE_IN,LE_US", r);
  r = await enter(inC);
  ok("a customer in one of their entities: allowed", r.s < 300, r);
  const sess = r.j.context || r.j;
  r = await enter(ukC);
  ok("a customer in another entity: refused", r.s >= 400, r);
  r = await enter(noC);
  ok("a customer with no entity set: allowed", r.s < 300, r);

  await adm("PUT", `/api/customers/${noC._id}`, { allowedChannels: "retail" });
  r = await enter(noC, "b2b_web");
  ok("a customer limited to other channels: refused on this channel", r.s >= 400, r);
  r = await enter(noC, "retail");
  ok("...and allowed on their channel", r.s < 300, r);
  r = await adm("PUT", `/api/customers/${noC._id}`, { allowedChannels: "" });
  r = await enter(noC, "b2b_web");
  ok("clearing the channels lifts the limit", r.s < 300, r);

  const ctx = await R("src/models/contextSession.model").findOne({ customer: inC._id });
  ok("the context keeps the customer's legal entity", ctx && ctx.legalEntity === "LE_IN", ctx);

  // changing entities mid-session ends the context on the next check
  const cur = await R("src/models/contextSession.model").findOne({ customer: noC._id }).sort({ issuedAt: -1 });
  await adm("PUT", `/api/customers/${noC._id}`, { allowedChannels: "retail" });
  r = await int("GET", `/api/internal/agent/contexts/${cur._id}/validate?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("agent"))}`);
  ok("limiting the channel while a context is open ends it", r.s >= 400 || (r.j && r.j.valid === false), r);

  const list = await adm("GET", "/api/agents/overview");
  const row = ((list.j || {}).agents || []).find((a) => a.name === "agent");
  ok("the agents list shows entities and last login field", row && Array.isArray(row.legalEntities) && "lastLoginAt" in row, list);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  process.exit(fail ? 1 : 0);
})();
