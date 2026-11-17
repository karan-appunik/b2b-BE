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
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_inherit");
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
  const authorize = (n, permission) => call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: gid(n), permission });
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: gid(name), ...extra });

  await call("GET", "/api/roles", null, AH); // seeds built-ins

  let r = await call("POST", "/api/roles", { name: "Junior", inheritsFrom: "sales_agent", permissions: [{ key: "payment_link.send" }] }, AH);
  ok("role created inheriting sales_agent", r.s === 201 && r.j.inheritsFrom === "sales_agent", r);
  const junior = await mkc("junior", { role: "junior" });

  r = await authorize("junior", "order.submit");
  ok("inherits order.submit from parent", r.j.allowed === true, r);
  r = await authorize("junior", "payment_link.send");
  ok("has its own added permission", r.j.allowed === true, r);
  r = await authorize("junior", "price.override");
  ok("still denied what neither grants", r.j.allowed === false, r);

  r = await call("PUT", "/api/roles/junior", { permissions: [{ key: "payment_link.send" }, { key: "order.submit", effect: "deny" }] }, AH);
  r = await authorize("junior", "order.submit");
  ok("child can override (deny) an inherited permission", r.j.allowed === false, r);
  await call("PUT", "/api/roles/junior", { permissions: [{ key: "payment_link.send" }] }, AH);

  r = await call("PUT", "/api/roles/sales_agent", { permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }] }, AH);
  r = await authorize("junior", "order.submit");
  ok("changing the parent changes the child too", r.j.allowed === false, r);
  r = await authorize("junior", "customer.search");
  ok("child keeps what parent still grants", r.j.allowed === true, r);

  // cycles / bad parents
  r = await call("PUT", "/api/roles/sales_agent", { inheritsFrom: "junior" }, AH);
  ok("cycle (parent inherits from child) rejected", r.s === 400, r);
  r = await call("PUT", "/api/roles/junior", { inheritsFrom: "junior" }, AH);
  ok("inheriting from itself rejected", r.s === 400, r);
  r = await call("PUT", "/api/roles/junior", { inheritsFrom: "ghost" }, AH);
  ok("unknown parent rejected", r.s === 400, r);
  r = await call("PUT", "/api/roles/junior", { inheritsFrom: "customer" }, AH);
  ok("customer role can't be a parent", r.s === 400, r);

  // scope inherited
  r = await call("POST", "/api/roles", { name: "Super Junior", inheritsFrom: "sales_admin", permissions: [] }, AH);
  await mkc("sj", { role: "super_junior" });
  await mkc("target");
  r = await call("GET", `/api/internal/customers/search?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("sj"))}&q=target`);
  ok("global scope can be inherited (sees every customer)", r.s === 200 && r.j.length === 1, r);

  // preview of who is affected
  r = await call("GET", "/api/roles/sales_admin/members", null, AH);
  ok("members preview: includes inheriting role's people", r.s === 200 && r.j.people.some((p) => p.name === "sj") && r.j.inheritingRoles.some((x) => x.key === "super_junior"), r);
  r = await call("GET", "/api/roles/junior/members", null, AH);
  ok("members preview for a leaf role", r.j.people.length === 1 && r.j.people[0].name === "junior" && r.j.inheritingRoles.length === 0, r);
  r = await call("GET", "/api/roles/ghost/members", null, AH);
  ok("members preview of unknown role -> 404", r.s === 404, r);

  // deleting a parent
  r = await call("DELETE", "/api/roles/sales_admin", null, AH);
  ok("built-in still not deletable", r.s === 400, r);
  await call("POST", "/api/roles", { name: "Mid", inheritsFrom: "junior", permissions: [] }, AH);
  await Customer.updateOne({ shop, name: "junior" }, { role: "customer" });
  r = await call("DELETE", "/api/roles/junior", null, AH);
  ok("role others inherit from can't be deleted (409, names them)", r.s === 409 && /Mid/.test(r.j.message), r);

  r = await call("GET", "/api/roles", null, AH);
  ok("list exposes inheritsFrom", r.j.roles.find((x) => x.key === "junior").inheritsFrom === "sales_agent", r.j.roles.map((x) => [x.key, x.inheritsFrom]));

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
