const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
const R = (m) => require(require("path").join(ROOT, m));
const mongoose = R("node_modules/mongoose");
const jwt = R("node_modules/jsonwebtoken");
const app = R("app");
const { activation } = R("src/services/agentOverview.service");
const Customer = R("src/models/customer.model");
const Grant = R("src/models/agentScopeGrant.model");
const Quote = R("src/models/quote.model");
const Override = R("src/models/overrideRequest.model");
const AgentCart = R("src/models/agentCart.model");
const ContextSession = R("src/models/contextSession.model");
const Audit = R("src/models/auditEvent.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  const now = new Date("2026-10-10T12:00:00Z");
  ok("no dates -> active", activation({}, now) === "active" && activation(undefined, now) === "active");
  ok("a start date in the future -> scheduled", activation({ validFrom: "2026-11-01" }, now) === "scheduled");
  ok("an end date in the past -> expired", activation({ validTo: "2026-10-01" }, now) === "expired");
  ok("inside both dates -> active", activation({ validFrom: "2026-10-01", validTo: "2026-12-01" }, now) === "active");
  ok("the end date itself is already over", activation({ validTo: "2026-10-10T12:00:00Z" }, now) === "expired");

  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_agents");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const call = async (m, p, body, headers = AH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get("content-type") || "";
    return { s: r.status, j: ct.includes("json") ? await r.json().catch(() => null) : null, text: ct.includes("csv") ? await r.text() : null, ct };
  };
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });
  await call("GET", "/api/roles");

  const boss = await mk("boss", { role: "sales_manager", territory: "North" });
  const rep = await mk("rep", { role: "sales_agent", agentProfile: { managerId: boss._id } });
  const c1 = await mk("c1"), c2 = await mk("c2"), c3 = await mk("c3");
  for (const c of [c1, c2]) await Grant.create({ shop, agent: rep._id, scopeType: "customer", scopeId: String(c._id) });
  await Grant.create({ shop, agent: boss._id, scopeType: "all" });
  await ContextSession.create({ shop, agent: rep._id, customer: c1._id, issuedAt: new Date("2026-10-05T09:00:00Z"), expiresAt: new Date("2026-10-05T17:00:00Z") });
  await Quote.create({ shop, number: "Q-1", customer: c1._id, ownerAgent: rep._id, status: "SENT" });
  await Quote.create({ shop, number: "Q-2", customer: c1._id, ownerAgent: rep._id, status: "CONVERTED" });
  await Override.create({ shop, agent: rep._id, customer: c1._id, type: "UNIT_PRICE", permission: "price.override", baseline: { amount: 100, currency: "USD" }, proposed: { amount: 50, currency: "USD" }, reasonCode: "OTHER", reasonText: "x", status: "PENDING_APPROVAL" });
  await AgentCart.create({ shop, agent: rep._id, customer: c1._id, items: [{ variantId: "1", quantity: 1 }] });
  await AgentCart.create({ shop, agent: rep._id, customer: c2._id, items: [] });

  let r = await call("GET", "/api/agents/overview");
  const row = r.j.agents.find((a) => a.name === "rep");
  ok("the list has one row per agent with a customer count (2 granted)", r.s === 200 && r.j.agents.length === 2 && row.customerCount === 2, r.j);
  ok("the manager is named", row.manager === "boss" && String(row.managerId) === String(boss._id), row);
  ok("last active is the latest context entry", new Date(row.lastActiveAt).toISOString() === "2026-10-05T09:00:00.000Z", row.lastActiveAt);
  ok("open work: 1 live quote (the converted one is not), 1 waiting exception, 1 saved cart (the empty one is not)", row.openWork.quotes === 1 && row.openWork.exceptions === 1 && row.openWork.carts === 1, row.openWork);
  ok("a manager whose role is limited to assigned accounts and has none reaches 0 (an all-grant alone does not widen a role)", r.j.agents.find((a) => a.name === "boss").customerCount === 0);
  ok("status and mfa are given", row.status === "active" && ["not required", "set up", "not set up"].includes(row.mfa), row);

  r = await call("GET", "/api/agents/export");
  ok("a CSV of the same list downloads", r.s === 200 && /csv/.test(r.ct) && r.text.startsWith("name,email,role,") && r.text.trim().split("\r\n").length === 3, r.text);
  r = await call("GET", "/api/agents/overview", null, { "Content-Type": "application/json" });
  ok("login required (401)", r.s === 401);

  // ---- profile
  r = await call("PUT", `/api/customers/${rep._id}`, { agentProfile: { managerId: String(boss._id), validFrom: "2026-01-01", validTo: "2027-01-01", locale: "en-GB" } });
  ok("manager, dates and language can be set", r.s === 200 && (await Customer.findById(rep._id)).agentProfile.locale === "en-GB", r.j);
  ok("and the change is audited", !!(await Audit.findOne({ shop, action: "agent.profile_updated", objectId: String(rep._id) })));
  r = await call("PUT", `/api/customers/${rep._id}`, { agentProfile: { managerId: String(rep._id) } });
  ok("an agent can't be their own manager (400)", r.s === 400 && r.j.code === "INVALID_MANAGER", r.j);
  r = await call("PUT", `/api/customers/${rep._id}`, { agentProfile: { managerId: String(c3._id) } });
  ok("a plain customer can't be a manager (400)", r.s === 400 && r.j.code === "INVALID_MANAGER", r.j);
  r = await call("PUT", `/api/customers/${rep._id}`, { agentProfile: { validFrom: "2027-02-01", validTo: "2027-01-01" } });
  ok("the end must come after the start (400)", r.s === 400 && r.j.code === "INVALID_DATES", r.j);
  r = await call("PUT", `/api/customers/${rep._id}`, { agentProfile: { validTo: "not a date" } });
  ok("a bad date is refused (400)", r.s === 400 && r.j.code === "INVALID_DATE", r.j);
  r = await call("PUT", `/api/customers/${rep._id}`, { agentProfile: { locale: "english please" } });
  ok("a bad locale is refused (400)", r.s === 400 && r.j.code === "INVALID_LOCALE", r.j);
  r = await call("PUT", `/api/customers/${c3._id}`, { agentProfile: { locale: "en" } });
  ok("a plain customer has no agent profile (404)", r.s === 404, r.j);

  // ---- dates are enforced
  const can = async (n, p) => (await call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: gid(n), permission: p }, IH)).j;
  ok("inside the dates the agent works", (await can("rep", "customer.search")).allowed === true);
  await call("PUT", `/api/customers/${rep._id}`, { agentProfile: { validFrom: "2099-01-01", validTo: "2099-12-01" } });
  ok("before their start date every permission is refused", (await can("rep", "customer.search")).allowed === false);
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("rep"), customerId: String(c1._id) }, IH);
  ok("...and no customer can be entered (403)", r.s === 403, r);
  r = await call("GET", "/api/agents/overview");
  ok("the list shows them as scheduled", r.j.agents.find((a) => a.name === "rep").status === "scheduled");
  await call("PUT", `/api/customers/${rep._id}`, { agentProfile: { validFrom: "2020-01-01", validTo: "2020-12-01" } });
  ok("after their end date they are refused too", (await can("rep", "customer.search")).allowed === false && (await call("GET", "/api/agents/overview")).j.agents.find((a) => a.name === "rep").status === "expired");
  await call("PUT", `/api/customers/${rep._id}`, { agentProfile: { validFrom: "", validTo: "", managerId: "" } });
  ok("clearing the dates lets them work again; clearing the manager works", (await can("rep", "customer.search")).allowed === true && !(await Customer.findById(rep._id)).agentProfile.managerId);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
