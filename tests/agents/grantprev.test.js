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
const Group = R("src/models/customerGroup.model");
const Grant = R("src/models/agentScopeGrant.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_grantprev");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const user = await User.create({ name: "M", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const adm = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: AH, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => null) }; };
  await adm("GET", "/api/roles");
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });
  const agent = await mk("agent", { role: "sales_agent" });
  const other = await mk("other", { role: "sales_agent" });
  const c1 = await mk("c1", { territory: "North" });
  const c2 = await mk("c2", { territory: "North" });
  const c3 = await mk("c3", { territory: "North" });
  const c4 = await mk("c4", { territory: "South" });
  const prev = (agentId, body) => adm("POST", `/api/agents/${agentId}/scope-grants/preview`, body);
  const count = () => Grant.countDocuments();

  let r = await prev(agent._id, { scopeType: "territory", scopeId: "North", effect: "allow" });
  ok("a territory rule says how many customers it covers, with names", r.s === 200 && r.j.customersCovered === 3 && r.j.sample.length === 3 && r.j.willBeAdded === 3 && r.j.conflicts.length === 0, r.j);
  ok("a preview saves nothing", (await count()) === 0);

  await adm("POST", `/api/agents/${agent._id}/scope-grants`, { scopeType: "customer", scopeId: String(c1._id) });
  r = await prev(agent._id, { scopeType: "territory", scopeId: "North", effect: "allow" });
  ok("customers the agent already reaches are not counted as new", r.j.alreadyReached === 1 && r.j.willBeAdded === 2, r.j);

  await adm("POST", `/api/agents/${agent._id}/scope-grants`, { scopeType: "customer", scopeId: String(c2._id), effect: "deny" });
  r = await prev(agent._id, { scopeType: "territory", scopeId: "North", effect: "allow" });
  ok("a deny rule that keeps a customer out is reported", r.j.blockedByDeny === 1 && r.j.conflicts.some((c) => c.code === "BLOCKED_BY_DENY" && c.count === 1), r.j);
  ok("...and that customer is not counted as new", r.j.willBeAdded === 1, r.j);

  r = await prev(agent._id, { scopeType: "customer", scopeId: String(c1._id), effect: "allow" });
  ok("the same rule again is flagged as a duplicate", r.j.conflicts.some((c) => c.code === "DUPLICATE"), r.j);
  r = await prev(agent._id, { scopeType: "customer", scopeId: String(c1._id), effect: "deny" });
  ok("the opposite rule for the same customer says a deny wins", r.j.conflicts.some((c) => c.code === "OPPOSITE_SAME_SCOPE"), r.j);
  ok("a deny says whom it would take away", r.j.willBeRemoved === 1 && r.j.conflicts.some((c) => c.code === "REMOVES_ACCESS"), r.j);

  await adm("POST", `/api/agents/${other._id}/scope-grants`, { scopeType: "territory", scopeId: "South" });
  r = await prev(agent._id, { scopeType: "territory", scopeId: "South", effect: "allow" });
  ok("another agent with the same rule is mentioned", r.j.conflicts.some((c) => c.code === "OTHER_AGENTS_SAME_SCOPE" && /other/.test(c.message)), r.j);

  r = await prev(agent._id, { scopeType: "customer", scopeId: String(c3._id), effect: "allow", validTo: new Date(Date.now() - 86400e3).toISOString() });
  ok("an end date in the past is flagged", r.j.conflicts.some((c) => c.code === "ALREADY_EXPIRED"), r.j);

  r = await prev(agent._id, { scopeType: "bogus", effect: "allow" });
  ok("a bad rule is refused the same way as saving it", r.s === 400, r);
  r = await prev(agent._id, { scopeType: "customer", scopeId: String(new mongoose.Types.ObjectId()), effect: "allow" });
  ok("an unknown customer is a 404", r.s === 404, r);
  r = await prev(new mongoose.Types.ObjectId(), { scopeType: "territory", scopeId: "North" });
  ok("an unknown agent is a 404", r.s === 404, r);
  r = await prev(agent._id, { scopeType: "all", effect: "deny" });
  ok("deny everything would take away every customer they reach now (only c1)", r.j.willBeRemoved === 1 && r.j.customersCovered === 4, r.j);

  r = await adm("POST", `/api/agents/${agent._id}/scope-grants`, { scopeType: "territory", scopeId: "North" });
  ok("saving a rule still works the same way", r.s === 201 && r.j.scopeId === "North", r);
  r = await adm("POST", `/api/agents/${agent._id}/scope-grants`, { scopeType: "bogus" });
  ok("saving a bad rule is still refused", r.s === 400, r);
  r = await adm("POST", `/api/agents/${agent._id}/scope-grants`, { scopeType: "all" });
  ok("global access for a role without it is still refused", r.s === 400 && /Global access/.test(r.j.message), r);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  process.exit(fail ? 1 : 0);
})();
