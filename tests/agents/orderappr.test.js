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
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_orderappr");
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
  const q = (n, extra = "") => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}${extra}`;
  await call("GET", "/api/roles", null, AH);
  await call("POST", "/api/roles", { name: "Careful", permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "cart.create" }, { key: "cart.write" }, { key: "order.submit", constraints: { mode: "approval_first" } }] }, AH);

  const careful = await mk("careful", { role: "careful" });
  const direct = await mk("direct", { role: "sales_admin" });
  const mgr = await mk("mgr", { role: "sales_manager" });
  const cust = await mk("cust");
  for (const a of [careful, mgr]) await Grant.create({ shop, agent: a._id, scopeType: "customer", scopeId: String(cust._id) });
  await Grant.create({ shop, agent: direct._id, scopeType: "customer", scopeId: String(cust._id) });

  const ctx = {};
  for (const n of ["careful", "direct", "mgr"]) {
    ctx[n] = (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid(n), customerId: String(cust._id) })).j.contextId;
    await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid(n), contextId: ctx[n], items: [{ variantId: "111", quantity: 10 }] });
  }
  const ask = (n) => call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid(n), contextId: ctx[n], type: "ORDER_APPROVAL", baseline: { amount: 50000, currency: "USD" }, proposed: { amount: 50000, currency: "USD" }, reasonCode: "OTHER", reasonText: "please approve this order" });

  let r = await call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: gid("careful"), contextId: ctx.careful, permission: "order.submit" });
  ok("the role's order mode is told to the storefront", r.j.allowed === true && r.j.constraints && r.j.constraints.mode === "approval_first", r.j);
  r = await call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: gid("direct"), contextId: ctx.direct, permission: "order.submit" });
  ok("a direct role has no mode to wait on", r.j.allowed === true && !(r.j.constraints && r.j.constraints.mode === "approval_first"), r.j);

  r = await ask("direct");
  ok("a direct role has nothing to ask for (DENIED, not needed)", r.j.status === "DENIED" && r.j.denyReason === "NOT_NEEDED", r.j);

  r = await ask("careful");
  ok("an approval-first role's order waits for a manager", r.s === 201 && r.j.status === "PENDING_APPROVAL" && r.j.type === "ORDER_APPROVAL", r.j);
  const id = r.j.id;

  r = await call("POST", `/api/internal/agent/approvals/${id}/decision`, { shop, agentShopifyCustomerId: gid("careful"), decision: "approve", comment: "me" });
  ok("the agent can't approve their own order (403)", r.s === 403, r);
  r = await call("GET", "/api/internal/agent/approvals" + q("mgr"));
  ok("the manager sees it in their queue (their % limit does not apply to an order)", r.j.approvals.some((a) => a.id === id && a.type === "ORDER_APPROVAL"), r.j);
  r = await call("POST", `/api/internal/agent/approvals/${id}/decision`, { shop, agentShopifyCustomerId: gid("mgr"), decision: "reject", comment: "" });
  ok("rejecting needs a comment", r.s === 400 && r.j.code === "COMMENT_REQUIRED", r);
  r = await call("POST", `/api/internal/agent/approvals/${id}/decision`, { shop, agentShopifyCustomerId: gid("mgr"), decision: "approve", comment: "fine" });
  ok("the manager approves", r.s === 200 && r.j.status === "APPROVED", r);

  r = await call("GET", "/api/internal/agent/overrides/usable" + q("careful", "&contextId=" + ctx.careful));
  ok("the approval can now be used for this cart", r.j.overrides.some((o) => o.id === id && o.type === "ORDER_APPROVAL" && o.status === "APPROVED"), r.j);

  await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid("careful"), contextId: ctx.careful, items: [{ variantId: "111", quantity: 20 }] });
  r = await call("GET", "/api/internal/agent/overrides/usable" + q("careful", "&contextId=" + ctx.careful));
  ok("changing the cart afterwards cancels the approval (it was for exactly that order)", !r.j.overrides.some((o) => o.id === id), r.j);

  r = await ask("careful");
  ok("a new request can be made for the new cart", r.j.status === "PENDING_APPROVAL");
  r = await call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid("careful"), contextId: ctx.careful, type: "ORDER_APPROVAL", baseline: { amount: 1, currency: "USD" }, proposed: { amount: 1, currency: "USD" }, reasonCode: "OTHER", reasonText: " " });
  ok("a written reason is still needed (400)", r.s === 400 && r.j.code === "REASON_REQUIRED", r);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
