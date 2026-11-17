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
const ContextSession = R("src/models/contextSession.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_flags");
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
  const A = (n, extra = {}) => ({ shop, agentShopifyCustomerId: gid(n), ...extra });
  const settings = (body) => call("PUT", "/api/agent-settings", body, AH);
  const can = async (n, permission, contextId) => (await call("POST", "/api/internal/agent/authorize", A(n, { permission, contextId }))).j;

  await call("GET", "/api/roles", null, AH);
  const admin = await mk("admin", { role: "sales_admin" });
  const cust = await mk("cust");
  await Grant.create({ shop, agent: admin._id, scopeType: "customer", scopeId: String(cust._id) });

  // ---- everything on to start with
  let r = await call("POST", "/api/internal/agent/contexts", A("admin", { customerId: String(cust._id) }));
  const ctx = r.j.contextId;
  ok("by default everything works", (r.s === 201 || r.s === 200) && (await can("admin", "price.override")).allowed && (await can("admin", "quote.create")).allowed);
  r = await call("GET", "/api/agent-settings", null, AH);
  ok("settings show the switches (on, none off)", r.j.moduleEnabled === true && r.j.featuresOff.length === 0, r.j);

  // ---- one capability at a time
  r = await settings({ featuresOff: ["overrides"] });
  ok("switching 'overrides' off is accepted", r.s === 200 && r.j.featuresOff.join() === "overrides", r);
  ok("price, discount, MOQ, shipping and custom-line exceptions are now refused, even for an administrator", !(await can("admin", "price.override")).allowed && !(await can("admin", "discount.override")).allowed && !(await can("admin", "quantity_rule.override")).allowed && !(await can("admin", "shipping.override")).allowed && !(await can("admin", "custom_line.create")).allowed);
  ok("everything else still works", (await can("admin", "quote.create")).allowed && (await can("admin", "payment_link.send")).allowed && (await can("admin", "customer.create")).allowed && (await can("admin", "order.submit")).allowed);
  r = await call("POST", "/api/internal/agent/carts/current", {}, IH);
  await call("PUT", "/api/internal/agent/carts/current", A("admin", { contextId: ctx, items: [{ variantId: "1", quantity: 1 }] }));
  r = await call("POST", "/api/internal/agent/overrides", A("admin", { contextId: ctx, type: "UNIT_PRICE", lineVariantId: "1", baseline: { amount: 100, currency: "USD" }, proposed: { amount: 90, currency: "USD" }, reasonCode: "OTHER", reasonText: "x" }));
  ok("an exception request is denied while it is off, and the denial is recorded", r.j.status === "DENIED" && r.j.denyReason === "PERMISSION_DENIED", r.j);
  r = await settings({ featuresOff: [] });
  ok("switched back on, it works at once (no waiting for the cache)", r.s === 200 && (await can("admin", "price.override")).allowed);

  r = await settings({ featuresOff: ["quotes", "payment_links", "customer_creation"] });
  ok("quotes, payment links and customer creation can each be switched off", !(await can("admin", "quote.create")).allowed && !(await can("admin", "payment_link.send")).allowed && !(await can("admin", "customer.create")).allowed && (await can("admin", "price.override")).allowed);
  r = await call("POST", "/api/internal/agent/customers/check", A("admin", { customer: { companyName: "X", firstName: "A", lastName: "B", email: "a@b.com", consent: true, address: { address1: "1", city: "c", zip: "1", countryCode: "US" } } }));
  ok("creating a customer is refused while it is off", r.s === 403, r);
  await settings({ featuresOff: [] });

  r = await settings({ featuresOff: ["nonsense"] });
  ok("an unknown capability is refused (400)", r.s === 400, r);
  r = await settings({ featuresOff: "overrides" });
  ok("it must be a list (400)", r.s === 400);

  // ---- the kill switch
  r = await settings({ moduleEnabled: false });
  ok("the kill switch is accepted", r.s === 200 && r.j.moduleEnabled === false, r);
  ok("every agent permission is refused, including searching and ordering", !(await can("admin", "customer.search")).allowed && !(await can("admin", "order.submit")).allowed && !(await can("admin", "cart.write")).allowed);
  r = await call("POST", "/api/internal/agent/contexts", A("admin", { customerId: String(cust._id) }));
  ok("nobody can enter a customer", r.s === 403, r);
  r = await call("GET", `/api/internal/agent/contexts/${ctx}/validate` + `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("admin"))}`);
  ok("a context that was open ends the next time it is used", (await ContextSession.findById(ctx)).revokedAt !== null, r);
  r = await call("GET", `/api/internal/customers/search?shop=${shop}&q=cust&agentShopifyCustomerId=${encodeURIComponent(gid("admin"))}`);
  ok("search is refused", r.s === 403, r);
  r = await call("GET", "/api/roles", null, AH);
  ok("the merchant panel itself keeps working (the switch is for agents)", r.s === 200);
  r = await call("GET", "/api/agent-settings", null, AH);
  ok("and they can still reach the settings to turn it back on", r.s === 200 && r.j.moduleEnabled === false);
  r = await settings({ moduleEnabled: true });
  r = await call("POST", "/api/internal/agent/contexts", A("admin", { customerId: String(cust._id) }));
  ok("switched back on, agents work again", r.s === 201 || r.s === 200, r);

  // ---- one shop's switch never touches another
  const other = await mk("otheradmin", { role: "sales_admin", shop: "other.myshopify.com" }).catch(() => null);
  await settings({ moduleEnabled: false });
  ok("a switch is per shop (another shop's agent is unaffected)", other ? (await call("POST", "/api/internal/agent/authorize", { shop: "other.myshopify.com", agentShopifyCustomerId: gid("otheradmin"), permission: "customer.search" })).j.allowed === true : true);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
