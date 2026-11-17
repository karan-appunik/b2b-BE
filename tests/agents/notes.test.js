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
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_notes");
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
  await call("GET", "/api/roles", null, AH);

  const rep = await mk("rep", { role: "sales_agent" });
  const mgr = await mk("mgr", { role: "sales_manager" });
  const cust = await mk("cust");
  for (const a of [rep, mgr]) await Grant.create({ shop, agent: a._id, scopeType: "customer", scopeId: String(cust._id) });

  let r = await call("PUT", `/api/customers/${cust._id}`, { internalNotes: "Pays late in December. Call Ana, not the owner." }, AH);
  ok("the merchant saves a note", r.s === 200 && r.j.internalNotes.startsWith("Pays late"), r);
  ok("the audit trail records that it changed, not what it said", !!(await Audit.findOne({ shop, action: "customer.notes_updated", "metadata.length": "Pays late in December. Call Ana, not the owner.".length })) && !JSON.stringify(await Audit.find({ shop })).includes("Pays late"));
  r = await call("PUT", `/api/customers/${cust._id}`, { internalNotes: "x".repeat(2001) }, AH);
  ok("a note is limited to 2000 characters (400)", r.s === 400, r);

  const summary = async (n) => {
    const ctx = (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid(n), customerId: String(cust._id) })).j.contextId;
    return (await call("GET", `/api/internal/agent/customer-summary?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}&contextId=${ctx}`)).j;
  };
  const m = await summary("mgr");
  ok("a manager (role has the right) sees the note", m.internalNotes && m.internalNotes.startsWith("Pays late"), m);
  const a = await summary("rep");
  ok("a sales agent (role lacks it) gets no notes field at all", a.internalNotes === undefined && !JSON.stringify(a).includes("Pays late"), a);
  const rolesNow = (await call("GET", "/api/roles?all=true", null, AH)).j.roles;
  ok("the right is in the built-in manager and administrator roles, not the agent role", rolesNow.find((x) => x.key === "sales_manager").permissions.some((p) => p.key === "customer.notes.read") && rolesNow.find((x) => x.key === "sales_admin").permissions.some((p) => p.key === "customer.notes.read") && !rolesNow.find((x) => x.key === "sales_agent").permissions.some((p) => p.key === "customer.notes.read"));
  r = await call("GET", `/api/customers/${cust._id}`, null, AH);
  ok("the merchant panel reads it back", r.j.internalNotes.startsWith("Pays late"));

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
