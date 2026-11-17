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
const Role = R("src/models/role.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_rbac");
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
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: "gid://shopify/Customer/" + name, ...extra });
  const gid = (n) => "gid://shopify/Customer/" + n;
  const q = (n, extra = "") => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}${extra}`;
  const authorize = (n, permission, contextId) => call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: gid(n), permission, contextId });

  const agent = await mkc("agent", { role: "sales_agent" });
  const ext = await mkc("ext", { role: "sales_manager" });
  const admin = await mkc("admin", { role: "sales_admin" });
  const a = await mkc("custA");
  const b = await mkc("custB");
  for (const ag of [agent, ext]) await Grant.create({ shop, agent: ag._id, scopeType: "customer", scopeId: String(a._id) });

  // ---- role catalog
  let r = await call("GET", "/api/roles?all=true", null, AH);
  ok("lists the 3 spec roles (agent, manager, admin) + catalog", r.s === 200 && r.j.roles.map((x) => x.key).join() === "sales_agent,sales_manager,sales_admin" && r.j.catalog.length >= 14, r.j.roles && r.j.roles.map((x) => x.key));
  ok("member counts shown", r.j.roles.find((x) => x.key === "sales_agent").memberCount === 1, r.j.roles.map((x) => [x.key, x.memberCount]));
  r = await call("GET", "/api/roles", null, IH);
  ok("internal key can't manage roles", r.s === 401, r);

  // ---- permission checks (deny by default)
  r = await authorize("agent", "order.submit");
  ok("sales_agent may submit orders", r.j.allowed === true, r);
  r = await authorize("agent", "price.override");
  ok("sales_agent may NOT override prices (default deny)", r.j.allowed === false, r);
  r = await authorize("ext", "order.submit");
  ok("sales_manager may submit orders", r.j.allowed === true, r);
  r = await authorize("ext", "price.override");
  ok("sales_manager may override prices, capped at 20%", r.j.allowed === true && r.j.constraints && r.j.constraints.maxDeltaPercent === 20, r);
  r = await authorize("ext", "customer.create");
  ok("sales_manager may NOT create customers (not in the spec's manager list)", r.j.allowed === false, r);
  r = await authorize("ext", "audit.read");
  ok("sales_manager may read activity (team monitoring)", r.j.allowed === true, r);
  r = await authorize("agent", "audit.read");
  ok("sales_agent may read only their own activity", r.j.allowed === true && r.j.constraints && r.j.constraints.scope === "own", r);
  r = await authorize("admin", "price.override");
  ok("sales_admin may override prices", r.j.allowed === true, r);
  r = await authorize("custA", "order.submit");
  ok("plain customer has no permissions", r.j.allowed === false, r);
  r = await authorize("agent", "made.up.key");
  ok("unknown permission -> 400", r.s === 400, r);

  // ---- creating custom roles
  r = await call("POST", "/api/roles", { name: "Regional Rep", description: "x", permissions: [{ key: "customer.search", effect: "allow" }, { key: "customer.context.enter", effect: "allow", constraints: { scope: "assigned" } }, { key: "cart.create", effect: "allow" }] }, AH);
  ok("custom role created", r.s === 201 && r.j.key === "regional_rep" && r.j.version === 1, r);
  r = await call("POST", "/api/roles", { name: "Regional Rep", permissions: [] }, AH);
  ok("duplicate name rejected", r.s === 400, r);
  r = await call("POST", "/api/roles", { name: "Bad", permissions: [{ key: "nope", effect: "allow" }] }, AH);
  ok("unknown permission key rejected", r.s === 400, r);
  r = await call("POST", "/api/roles", { name: "Bad2", permissions: [{ key: "price.override", constraints: { maxDeltaPercent: 500 } }] }, AH);
  ok("constraint out of range rejected", r.s === 400, r);
  r = await call("POST", "/api/roles", { name: "Bad3", permissions: [{ key: "cart.write" }, { key: "cart.write" }] }, AH);
  ok("duplicate permission rejected", r.s === 400, r);
  r = await call("POST", "/api/roles", { name: "Customer", permissions: [] }, AH);
  ok("reserved name 'customer' rejected", r.s === 400, r);

  // ---- assigning roles
  const rep = await mkc("rep", {});
  r = await call("PUT", `/api/customers/${rep._id}`, { role: "no_such_role" }, AH);
  ok("assigning unknown role -> 400", r.s === 400, r);
  r = await call("PUT", `/api/customers/${rep._id}`, { role: "regional_rep" }, AH);
  ok("assigning custom role works", r.s === 200 && r.j.role === "regional_rep", r);
  const changed = await Audit.findOne({ action: "agent.role_changed", objectId: String(rep._id) });
  ok("role change audited (from -> to)", changed && changed.metadata.from === "customer" && changed.metadata.to === "regional_rep", changed);
  await Grant.create({ shop, agent: rep._id, scopeType: "customer", scopeId: String(a._id) });

  // ---- custom role enforcement
  r = await call("GET", "/api/internal/customers/search" + q("rep", "&q=cust"));
  ok("custom role with customer.search sees granted customer", r.s === 200 && r.j.length === 1, r);
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("rep"), customerId: String(a._id) });
  ok("custom role may enter context", r.s === 201, r);
  const ctxRep = r.j.contextId;
  r = await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctxRep, items: [{ variantId: "1", quantity: 1 }] });
  ok("cart.write missing -> 403 PERMISSION_DENIED", r.s === 403 && r.j.code === "PERMISSION_DENIED", r);
  r = await call("GET", `/api/internal/agent/carts/current?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("rep"))}&contextId=${ctxRep}`);
  ok("cart.create present -> may open cart", r.s === 200, r);

  // ---- editing a role: version bump, audit, immediate effect
  r = await call("PUT", "/api/roles/regional_rep", { permissions: [{ key: "customer.search", effect: "allow" }, { key: "cart.create", effect: "allow" }, { key: "cart.write", effect: "allow" }] }, AH);
  ok("role updated, version bumped to 2", r.s === 200 && r.j.version === 2, r);
  const upd = await Audit.findOne({ action: "role.updated", objectId: "regional_rep" });
  ok("role update audited with before/after", upd && upd.metadata.before.length === 3 && upd.metadata.after.length === 3 && upd.metadata.version === 2, upd);
  r = await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctxRep, items: [{ variantId: "1", quantity: 1 }] });
  ok("context died: customer.context.enter was removed from role", r.s === 401 && r.j.code === "CONTEXT_REVOKED", r);
  ok("lost-permission revocation audited", !!(await Audit.findOne({ action: "context.revoked", reasonCode: "ACCESS_LOST" })));
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("rep"), customerId: String(a._id) });
  ok("re-entry denied with PERMISSION_DENIED", r.s === 403, r);
  const den = await Audit.findOne({ action: "context.denied", reasonCode: "PERMISSION_DENIED" });
  ok("denial reason audited", !!den, den);

  // ---- explicit deny beats allow
  r = await call("PUT", "/api/roles/regional_rep", { permissions: [{ key: "customer.search", effect: "allow" }, { key: "customer.search", effect: "deny" }] }, AH);
  ok("same permission as allow+deny in one save is rejected", r.s === 400, r);
  await Role.updateOne({ shop, key: "regional_rep" }, { $set: { permissions: [{ key: "customer.search", effect: "allow" }, { key: "customer.search", effect: "deny" }] } });
  r = await authorize("rep", "customer.search");
  ok("explicit deny beats allow", r.j.allowed === false, r);

  // ---- global scope comes from the role
  r = await call("POST", "/api/roles", { name: "Area Manager", permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "all" } }] }, AH);
  const mgr = await mkc("mgr", { role: "area_manager" });
  r = await call("GET", "/api/internal/customers/search" + q("mgr", "&q=cust"));
  ok("role with scope=all sees every customer", r.s === 200 && r.j.length === 2, r);
  r = await call("POST", `/api/agents/${agent._id}/scope-grants`, { scopeType: "all", effect: "allow" }, AH);
  ok("allow-all grant refused for a non-global role", r.s === 400, r);
  r = await call("POST", `/api/agents/${mgr._id}/scope-grants`, { scopeType: "all", effect: "allow" }, AH);
  ok("allow-all grant fine for a global role", r.s === 201, r);

  // ---- deleting roles
  r = await call("DELETE", "/api/roles/sales_agent", null, AH);
  ok("built-in role can't be deleted", r.s === 400, r);
  r = await call("DELETE", "/api/roles/area_manager", null, AH);
  ok("role still in use can't be deleted (409)", r.s === 409, r);
  await Customer.updateOne({ _id: mgr._id }, { role: "customer" });
  r = await call("DELETE", "/api/roles/area_manager", null, AH);
  ok("unused custom role deleted", r.s === 200, r);
  ok("deletion audited", !!(await Audit.findOne({ action: "role.deleted", objectId: "area_manager" })));

  // ---- demoting still works
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("agent"), customerId: String(a._id) });
  const ctxAgent = r.j.contextId;
  await call("PUT", `/api/customers/${agent._id}`, { role: "customer" }, AH);
  r = await call("GET", `/api/internal/agent/contexts/${ctxAgent}/validate` + q("agent"));
  ok("demoting to customer kills the context", r.s === 401, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
