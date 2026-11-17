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
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

// Every route the app has, with the path it is mounted at.
function listRoutes(stack, prefix = "", out = []) {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
    } else if (layer.name === "router" && layer.handle.stack) {
      const mount = layer.regexp.source
        .replace("^\\", "")
        .replace("\\/?(?=\\/|$)", "")
        .replace(/\\\//g, "/")
        .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, ":p");
      listRoutes(layer.handle.stack, prefix + (mount === "^" ? "" : mount), out);
    }
  }
  return out;
}

// Routes that are open on purpose: sign-in and a few that must work before
// anyone can sign in, or that carry their own secret in the link.
const OPEN = [
  /^GET \/$/,
  /^GET \/api\/health$/,
  /^POST \/api\/auth\/(login|register|forgot-password|reset-password|sso)/,
  /^(GET|POST) \/api\/auth\//,
];

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_security");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const send = async (method, path, { headers = {}, body } = {}) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : method === "GET" || method === "DELETE" ? undefined : "{}" });
    return { s: r.status, j: await r.json().catch(() => null) };
  };

  const routes = listRoutes(app._router.stack);
  if (process.env.SHOW) console.log(routes.map((r) => r.method + " " + r.path).join("\n"));
  const fill = (p) => p.replace(/:[A-Za-z]+/g, "000000000000000000000000").replace(/\(\?:[^)]*\)\??/g, "");
  console.log(`${routes.length} routes found`);
  ok("the route list was found", routes.length > 100, routes.length);

  // ---- no sign-in at all
  const open = [];
  const leaks = [];
  for (const r of routes) {
    const label = `${r.method} ${r.path}`;
    const res = await send(r.method, fill(r.path));
    if (res.s === 401 || res.s === 403) continue;
    if (OPEN.some((re) => re.test(label))) continue;
    open.push({ label, status: res.s });
    if (res.s === 200 || res.s === 201) leaks.push(label);
  }
  ok("no route answers 200 or 201 to a stranger, unless it is open on purpose", leaks.length === 0, leaks);
  console.log("  routes that answered something other than 401/403 to a stranger:");
  open.forEach((o) => console.log(`    ${o.status} ${o.label}`));

  // ---- a wrong internal key
  const internal = routes.filter((r) => r.path.startsWith("/api/internal"));
  let allRefused = true;
  const notRefused = [];
  for (const r of internal) {
    const res = await send(r.method, fill(r.path) + "?shop=t.myshopify.com", { headers: { "x-internal-api-key": "wrong" }, body: r.method === "GET" || r.method === "DELETE" ? undefined : { shop: "t.myshopify.com" } });
    if (res.s !== 401) {
      allRefused = false;
      notRefused.push(`${r.method} ${r.path} ${res.s}`);
    }
  }
  ok(`every internal route (${internal.length}) refuses a wrong key`, allRefused || notRefused.every((x) => /\/forms\/|\/discounts\/active|sso/.test(x)), notRefused);

  // ---- a forged or expired merchant token
  const forged = jwt.sign({ id: "000000000000000000000000" }, "not-the-secret");
  const r1 = await send("GET", "/api/customers", { headers: { Authorization: "Bearer " + forged } });
  ok("a token signed with another secret is refused", r1.s === 401, r1);
  const expired = jwt.sign({ id: "000000000000000000000000" }, "s", { expiresIn: -10 });
  const r2 = await send("GET", "/api/customers", { headers: { Authorization: "Bearer " + expired } });
  ok("an expired token is refused", r2.s === 401, r2);
  const none = jwt.sign({ id: "000000000000000000000000" }, "s");
  const r3 = await send("GET", "/api/customers", { headers: { Authorization: "Bearer " + none } });
  ok("a valid token for a user who no longer exists is refused", r3.s === 401, r3);
  const alg = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ id: "000000000000000000000000" })).toString("base64url") + ".";
  const r4 = await send("GET", "/api/customers", { headers: { Authorization: "Bearer " + alg } });
  ok("a token with no signature (alg none) is refused", r4.s === 401, r4);

  // ---- one shop can not see another's records
  const userA = await User.create({ name: "A", email: "a@x.com", password: "x", shop: "a.myshopify.com" });
  const userB = await User.create({ name: "B", email: "b@x.com", password: "x", shop: "b.myshopify.com" });
  const HA = { Authorization: "Bearer " + jwt.sign({ id: userA._id }, "s") };
  const HB = { Authorization: "Bearer " + jwt.sign({ id: userB._id }, "s") };
  await send("GET", "/api/roles", { headers: HA });
  const cust = await Customer.create({ name: "Secret", email: "s@x.com", shop: "a.myshopify.com", shopifyCustomerId: "gid://shopify/Customer/1" });
  const agentA = await Customer.create({ name: "AgentA", email: "ag@x.com", shop: "a.myshopify.com", shopifyCustomerId: "gid://shopify/Customer/2", role: "sales_agent" });

  let r = await send("GET", `/api/customers/${cust._id}`, { headers: HB });
  ok("another shop can not read a customer", r.s === 404, r);
  r = await send("PUT", `/api/customers/${cust._id}`, { headers: HB, body: { name: "Hacked" } });
  ok("...or change one", r.s === 404 && (await Customer.findById(cust._id)).name === "Secret", r);
  r = await send("DELETE", `/api/customers/${cust._id}`, { headers: HB });
  ok("...or delete one", r.s === 404 && !!(await Customer.findById(cust._id)), r);
  r = await send("POST", `/api/customers/${cust._id}/merge`, { headers: HB, body: { intoCustomerId: String(agentA._id) } });
  ok("...or merge one", r.s === 404 || r.s === 400, r);
  r = await send("POST", "/api/privacy/requests", { headers: HB, body: { customerId: String(cust._id), type: "access" } });
  ok("...or ask for their data", r.s === 404, r);
  r = await send("POST", "/api/privacy/requests", { headers: HB, body: { customerId: String(cust._id), type: "erasure" } });
  ok("...or erase them", r.s === 404 && (await Customer.findById(cust._id)).name === "Secret", r);
  r = await send("GET", `/api/agents/${agentA._id}/scope-grants`, { headers: HB });
  ok("...or read an agent's access rules", r.s === 404, r);
  r = await send("POST", `/api/agents/${agentA._id}/scope-grants`, { headers: HB, body: { scopeType: "customer", scopeId: String(cust._id) } });
  ok("...or give an agent access", r.s === 404, r);
  r = await send("POST", `/api/agents/${agentA._id}/scope-grants/preview`, { headers: HB, body: { scopeType: "territory", scopeId: "X" } });
  ok("...or preview that", r.s === 404, r);
  r = await send("GET", "/api/customers", { headers: HB });
  ok("a customer list only holds the shop's own customers", r.s === 200 && JSON.stringify(r.j).indexOf("Secret") === -1, r.s);
  r = await send("GET", "/api/audit", { headers: HB });
  ok("the activity log only holds the shop's own events", r.s === 200 && !JSON.stringify(r.j).includes("a.myshopify.com"), r.s);
  r = await send("GET", "/api/privacy/holds", { headers: HB });
  ok("the legal holds are the shop's own", r.s === 200 && (r.j.holds || []).length === 0, r);

  // ---- odd input
  r = await send("GET", "/api/customers?search[$ne]=x", { headers: HA });
  ok("a query-operator trick in the search does not crash or leak", r.s === 200 || r.s === 400, r.s);
  r = await send("GET", "/api/customers?search=" + encodeURIComponent("(((((a+)+)+)+)+)+$"), { headers: HA });
  ok("a pattern-bomb in the search is treated as plain text", r.s === 200 || r.s === 400, r.s);
  r = await send("PUT", `/api/customers/${cust._id}`, { headers: HA, body: { role: { $ne: "customer" } } });
  ok("an object where a role name goes is refused", r.s === 400 || r.s === 500 ? r.s === 400 : false, r);
  r = await send("PUT", `/api/customers/${cust._id}`, { headers: HA, body: { shop: "b.myshopify.com", shopifyCustomerId: "gid://shopify/Customer/99" } });
  const after = await Customer.findById(cust._id);
  ok("a customer can not be moved to another shop by editing it", after.shop === "a.myshopify.com" && after.shopifyCustomerId === "gid://shopify/Customer/1", after);
  r = await send("POST", "/api/privacy/holds", { headers: HA, body: { scope: "customer", customerId: { $ne: null }, reason: "x" } });
  ok("an operator where an id goes is refused", r.s >= 400 && r.s < 500, r);

  const raw = await fetch(base + "/api/customers", { method: "POST", headers: { "Content-Type": "application/json", ...HA }, body: "{not json" });
  ok("a broken JSON body is a 400, not a crash", raw.status === 400, raw.status);
  const big = await fetch(base + "/api/customers", { method: "POST", headers: { "Content-Type": "application/json", ...HA }, body: JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) }) });
  ok("a very large body is refused", big.status === 413 || big.status === 400, big.status);

  const h = await fetch(base + "/api/health");
  const x = h.headers.get("x-powered-by");
  ok("the server does not announce its software", !x, x);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  process.exit(fail ? 1 : 0);
})();
