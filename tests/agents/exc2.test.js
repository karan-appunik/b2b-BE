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
const CustomerGroup = R("src/models/customerGroup.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_exc2");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  let call = async (m, p, body, headers = IH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) };
  };

  // A role, grant or setting changed mid-test makes a context STALE (spec §5.2):
  // refresh it the way the storefront would, then try again.
  {
    const _raw = call;
    call = async (m, p, body, headers) => {
      let r = await _raw(m, p, body, headers);
      if (r.s === 401 && r.j && r.j.code === "CONTEXT_STALE") {
        const qs = new URL("http://x" + p).searchParams;
        const ctxId = (body && body.contextId) || qs.get("contextId");
        const agentId = (body && body.agentShopifyCustomerId) || qs.get("agentShopifyCustomerId");
        if (ctxId && agentId) {
          await _raw("POST", "/api/internal/agent/contexts/" + ctxId + "/refresh", { shop, agentShopifyCustomerId: agentId }, IH);
          r = await _raw(m, p, body, headers);
        }
      }
      return r;
    };
  }
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });
  const q = (n, extra = "") => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}${extra}`;

  const roles = (await call("GET", "/api/roles?all=true", null, AH)).j.roles;
  const keysOf = (k) => roles.find((r) => r.key === k).permissions.map((p) => p.key);
  ok("the two new rights exist in the catalogue and in the built-in roles", keysOf("sales_admin").includes("address.override") && keysOf("sales_admin").includes("credit.override") && keysOf("sales_manager").includes("credit.override") && !keysOf("sales_agent").includes("credit.override"));

  const admin = await mk("admin", { role: "sales_admin" });
  const mgr = await mk("mgr", { role: "sales_manager" });
  const rep = await mk("rep", { role: "sales_agent" });
  const cust = await mk("cust");
  for (const a of [admin, mgr, rep]) await Grant.create({ shop, agent: a._id, scopeType: "customer", scopeId: String(cust._id) });
  const ctx = {};
  for (const n of ["admin", "mgr", "rep"]) {
    ctx[n] = (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid(n), customerId: String(cust._id) })).j.contextId;
    await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid(n), contextId: ctx[n], items: [{ variantId: "111", quantity: 10 }] });
  }
  const ask = (n, over) => call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid(n), contextId: ctx[n], reasonCode: "OTHER", reasonText: "because", ...over });

  // ================= custom line: tax code =================
  const custom = (n, c) => ask(n, { type: "CUSTOM_LINE", custom: { title: "Setup fee", quantity: 1, ...c }, baseline: { amount: 0, currency: "USD" }, proposed: { amount: 5000, currency: "USD" } });
  let r = await custom("admin", {});
  ok("a taxable custom line without a tax code is refused", r.s === 400 && r.j.code === "TAX_CODE_REQUIRED", r);
  r = await custom("admin", { taxCode: "SERVICES-STD", accountingCode: "4100" });
  ok("with a tax code and an accounting code it is accepted and kept", r.s === 201 && r.j.custom.taxable === true && r.j.custom.taxCode === "SERVICES-STD" && r.j.custom.accountingCode === "4100", r);
  r = await custom("admin", { taxable: false });
  ok("a non-taxable line needs no tax code", r.s === 201 && r.j.custom.taxable === false && r.j.custom.taxCode === null, r);
  r = await custom("admin", { taxCode: "x".repeat(41) });
  ok("codes are limited to 40 characters", r.s === 400, r);

  // ================= one-off address =================
  const addr = { company: "Branch 2", address1: "9 Dock Road", city: "Leeds", zip: "LS1 4AB", countryCode: "gb", phone: "+44 113 000 0000" };
  const addrAsk = (n, a) => ask(n, { type: "ADDRESS", address: a, baseline: { amount: 0, currency: "USD" }, proposed: { amount: 0, currency: "USD" } });
  r = await addrAsk("admin", addr);
  ok("an administrator may ship to a one-off address; it is kept, country upper-cased", r.s === 201 && r.j.status === "AUTO_APPROVED" && r.j.address.address1 === "9 Dock Road" && r.j.address.countryCode === "GB", r);
  r = await addrAsk("rep", addr);
  ok("a sales agent role may not (denied, and the attempt is kept)", r.j.status === "DENIED" && r.j.denyReason === "PERMISSION_DENIED", r.j);
  r = await addrAsk("admin", { ...addr, address1: "" });
  ok("a street is required", r.s === 400 && r.j.code === "INVALID_ADDRESS", r);
  r = await addrAsk("admin", { ...addr, countryCode: "GBR" });
  ok("the country must be 2 letters", r.s === 400 && r.j.code === "INVALID_ADDRESS", r);
  ok("it is never added to the customer's address book", (await Customer.findById(cust._id)).addresses.length === 0);
  await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid("admin"), contextId: ctx.admin, items: [{ variantId: "999", quantity: 1 }] });
  r = await call("GET", "/api/internal/agent/overrides/usable" + q("admin", "&contextId=" + ctx.admin));
  ok("the address exception stays usable when the cart's lines change", r.j.overrides.some((o) => o.type === "ADDRESS" && o.status === "AUTO_APPROVED"), r.j);
  await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid("admin"), contextId: ctx.admin, items: [{ variantId: "111", quantity: 10 }] });

  // ================= credit =================
  const credit = (n, avail, total) => ask(n, { type: "CREDIT_LIMIT", baseline: { amount: avail, currency: "USD" }, proposed: { amount: total, currency: "USD" } });
  r = await credit("mgr", 100000, 105000);
  ok("5% over the credit left is within the manager's 10% -> approved", r.j.status === "AUTO_APPROVED" && r.j.deltaPercent === 5, r.j);
  r = await credit("mgr", 100000, 130000);
  ok("30% over is beyond the manager's 10% -> waits for approval", r.j.status === "PENDING_APPROVAL" && r.j.deltaPercent === 30, r.j);
  r = await credit("admin", 100000, 300000);
  ok("an administrator (no limit) may go any amount over", r.j.status === "AUTO_APPROVED" && r.j.deltaPercent === 200, r.j);
  r = await credit("mgr", 100000, 90000);
  ok("an order inside the credit left needs no exception (DENIED: not needed)", r.j.status === "DENIED" && r.j.denyReason === "NOT_NEEDED", r.j);
  r = await credit("rep", 100000, 105000);
  ok("a sales agent role may not", r.j.status === "DENIED" && r.j.denyReason === "PERMISSION_DENIED", r.j);
  r = await credit("admin", 0, 5000);
  ok("with no credit at all it still works (no percent to show)", r.j.status === "AUTO_APPROVED" && r.j.deltaPercent === null, r.j);
  r = await ask("admin", { type: "CREDIT_LIMIT", baseline: { amount: 100, currency: "USD" }, proposed: { amount: 500, currency: "EUR" } });
  ok("currencies must match", r.j.status === "DENIED" && r.j.denyReason === "CURRENCY_MISMATCH", r.j);

  // ================= pack size (increment) =================
  await R("src/services/customerGroup.service").ensureBaseGroup(shop);
  const grp = await CustomerGroup.findOneAndUpdate({ shop, isBase: true }, { $set: { orderLimits: { quantity: { min: null, max: null, increment: 6 }, total: [] } } }, { new: true });
  ok("a group can carry a pack size", grp.orderLimits.quantity.increment === 6);
  r = await call("GET", `/api/internal/customers/order-limits?shop=${shop}&shopifyCustomerId=${encodeURIComponent(gid("cust"))}`);
  ok("and the order-limits endpoint returns it", r.j.quantity.increment === 6, r.j);
  r = await call("POST", "/api/v1/carts/current/validate", { shop, agentShopifyCustomerId: gid("admin"), contextId: ctx.admin });
  ok("10 is not a multiple of 6: the cart check says so", r.j.valid === false && r.j.issues.some((i) => i.code === "NOT_IN_PACK_SIZE" && i.increment === 6), r.j);
  r = await ask("admin", { type: "QUANTITY_RULE", rule: "INCREMENT", lineVariantId: "111", baseline: { amount: 6, currency: "QTY" }, proposed: { amount: 10, currency: "QTY" } });
  ok("an increment exception is recorded as INCREMENT, apart from the minimum", r.s === 201 && r.j.rule === "INCREMENT" && r.j.status === "AUTO_APPROVED", r.j);
  r = await call("POST", "/api/v1/carts/current/validate", { shop, agentShopifyCustomerId: gid("admin"), contextId: ctx.admin });
  ok("once approved, the pack-size check is waived for this order", !r.j.issues.some((i) => i.code === "NOT_IN_PACK_SIZE"), r.j);
  r = await ask("rep", { type: "QUANTITY_RULE", rule: "INCREMENT", lineVariantId: "111", baseline: { amount: 6, currency: "QTY" }, proposed: { amount: 10, currency: "QTY" } });
  ok("a role without the right is refused", r.j.status === "DENIED", r.j);
  r = await ask("admin", { type: "QUANTITY_RULE", lineVariantId: "111", baseline: { amount: 12, currency: "QTY" }, proposed: { amount: 10, currency: "QTY" } });
  ok("with no rule named it is a minimum-quantity exception (MOQ)", r.s === 201 && r.j.rule === "MOQ", r.j);
  r = await call("POST", "/api/v1/carts/current/validate", { shop, agentShopifyCustomerId: gid("mgr"), contextId: ctx.mgr });
  ok("someone with no exception still sees the pack-size error", r.j.issues.some((i) => i.code === "NOT_IN_PACK_SIZE"), r.j);

  // ================= listings keep the new details =================
  r = await call("GET", "/api/internal/agent/approvals" + q("admin"));
  ok("approvers can list requests (the credit one waits for the administrator)", r.s === 200 && r.j.approvals.some((a) => a.type === "CREDIT_LIMIT" && a.deltaPercent === 30), r.j);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
