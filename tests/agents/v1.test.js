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
const Override = R("src/models/overrideRequest.model");
const CustomerGroup = R("src/models/customerGroup.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_v1");
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
  const A = (n, extra = {}) => ({ shop, agentShopifyCustomerId: gid(n), ...extra });
  const q = (n, extra = "") => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}${extra}`;

  await call("GET", "/api/roles", null, AH);
  await call("POST", "/api/roles", { name: "No Cart", permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }] }, AH);

  const rep = await mk("rep", { role: "sales_agent" });
  const mgr = await mk("mgr", { role: "sales_manager" });
  const nocart = await mk("nocart", { role: "no_cart" });
  const custA = await mk("custA", { company: "Acme Foods", phone: "+1 (555) 010-2000", taxId: "TX-77", region: { countryCode: "US", zip: "78701" } });
  const custB = await mk("custB", { company: "Other Co" });
  for (const a of [rep, mgr, nocart]) await Grant.create({ shop, agent: a._id, scopeType: "customer", scopeId: String(custA._id) });

  // ---- the context endpoints under the doc's paths
  let r = await call("GET", "/api/v1/agent/customers" + q("rep", "&q=acme"));
  ok("GET /v1/agent/customers searches the agent's scope", r.s === 200 && r.j.length === 1 && r.j[0].company === "Acme Foods", r);
  r = await call("GET", "/api/v1/agent/customers" + q("rep", "&q=other"));
  ok("...and never shows a customer outside it", r.s === 200 && r.j.length === 0, r);
  r = await call("GET", "/api/v1/agent/customers" + q("rep", "&q=78701"));
  ok("search by postcode", r.j.length === 1, r);
  r = await call("GET", "/api/v1/agent/customers" + q("rep", "&q=555 010 2000"));
  const byDigits = await call("GET", "/api/v1/agent/customers" + q("rep", "&q=5550102000"));
  ok("search by phone digits (formatting ignored)", byDigits.j.length === 1, byDigits);
  r = await call("GET", "/api/v1/agent/customers" + q("rep", "&q=TX-77"));
  ok("search by tax id", r.j.length === 1, r);

  r = await call("POST", "/api/v1/agent/contexts", A("rep", { customerId: String(custA._id) }));
  ok("POST /v1/agent/contexts creates a context", r.s === 201 || r.s === 200, r);
  const ctx = r.j.contextId;
  r = await call("POST", "/api/v1/agent/contexts", A("rep", { customerId: String(custB._id) }));
  ok("...and refuses a customer outside the scope", r.s === 403, r);

  r = await call("GET", "/api/v1/context" + q("rep"));
  ok("GET /v1/context reads the current context", r.s === 200 && r.j.active === true && r.j.customer, r);

  // ---- carts
  r = await call("POST", "/api/v1/carts", A("rep", { contextId: ctx }));
  ok("POST /v1/carts creates the cart", r.s === 201 && r.j.items.length === 0 && r.j.id, r);
  const cartId = r.j.id;
  r = await call("POST", "/api/v1/carts", { ...A("rep"), }, { ...IH, "x-context-id": ctx });
  ok("...resumes it if there is one (context given in the X-Context-Id header)", r.s === 200 && r.j.id === cartId, r);
  r = await call("POST", "/api/v1/carts", A("rep"));
  ok("...needs a context (401)", r.s === 401, r);
  r = await call("POST", "/api/v1/carts", A("nocart", { contextId: "bad" }));
  ok("...bad context id (401)", r.s === 401, r);

  r = await call("POST", `/api/v1/carts/${cartId}/items`, A("rep", { contextId: ctx, variantId: "111", quantity: 3 }));
  ok("POST /v1/carts/{id}/items adds a line", r.s === 200 && r.j.items.length === 1 && r.j.items[0].quantity === 3 && r.j.version === 2, r);
  r = await call("POST", `/api/v1/carts/${cartId}/items`, A("rep", { contextId: ctx, variantId: "111", quantity: 2 }));
  ok("the same variant is added together", r.j.items[0].quantity === 5 && r.j.version === 3, r.j);
  r = await call("POST", `/api/v1/carts/${cartId}/items`, A("rep", { contextId: ctx, variantId: "222", quantity: 1, expectedVersion: 1 }));
  ok("a stale version is refused (409) with the current cart", r.s === 409 && r.j.code === "VERSION_CONFLICT" && r.j.items.length === 1, r);
  r = await call("POST", `/api/v1/carts/${cartId}/items`, A("rep", { contextId: ctx, variantId: "abc", quantity: 1 }));
  ok("a bad variant is refused", r.s === 400 && r.j.code === "INVALID_ITEM", r);
  r = await call("POST", `/api/v1/carts/${cartId}/items`, A("rep", { contextId: ctx, variantId: "9", quantity: 0 }));
  ok("a bad quantity is refused", r.s === 400, r);
  r = await call("POST", `/api/v1/carts/${new mongoose.Types.ObjectId()}/items`, A("rep", { contextId: ctx, variantId: "9", quantity: 1 }));
  ok("someone else's cart id is not found (404)", r.s === 404, r);
  const ctxNo = (await call("POST", "/api/internal/agent/contexts", A("nocart", { customerId: String(custA._id) }))).j.contextId;
  r = await call("POST", `/api/v1/carts/${cartId}/items`, A("nocart", { contextId: ctxNo, variantId: "9", quantity: 1 }));
  ok("a role without cart.write is refused (403)", r.s === 403, r);

  // ---- overrides under the doc path
  r = await call("POST", `/api/v1/carts/${cartId}/overrides`, A("rep", { contextId: ctx, type: "UNIT_PRICE", lineVariantId: "111", baseline: { amount: 10000, currency: "USD" }, proposed: { amount: 9500, currency: "USD" }, reasonCode: "OTHER", reasonText: "x" }));
  ok("POST /v1/carts/{id}/overrides requests an exception", r.s === 201 && r.j.type === "UNIT_PRICE", r);

  // ---- validate
  r = await call("POST", `/api/v1/carts/${cartId}/validate`, A("rep", { contextId: ctx }));
  ok("POST /v1/carts/{id}/validate: a good cart is valid, and says what it did not check", r.s === 200 && r.j.valid === true && r.j.quantity === 5 && r.j.leftForCheckout.includes("prices") && r.j.checked.length >= 3, r);
  await Override.create({ shop, agent: rep._id, customer: custA._id, type: "UNIT_PRICE", permission: "price.override", baseline: { amount: 100, currency: "USD" }, proposed: { amount: 50, currency: "USD" }, reasonCode: "OTHER", reasonText: "x", status: "PENDING_APPROVAL" });
  r = await call("POST", `/api/v1/carts/${cartId}/validate`, A("rep", { contextId: ctx }));
  ok("a pending approval makes it invalid", r.j.valid === false && r.j.issues.some((i) => i.code === "APPROVAL_PENDING"), r.j);
  await Override.deleteMany({ status: "PENDING_APPROVAL" });
  const base0 = await CustomerGroup.findOneAndUpdate({ shop, isBase: true }, { $set: { orderLimits: { quantity: { min: 10, max: null }, total: [] } } }, { new: true });
  r = await call("POST", `/api/v1/carts/${cartId}/validate`, A("rep", { contextId: ctx }));
  ok("below the group's minimum quantity (5 < 10) is invalid", r.j.valid === false && r.j.issues.some((i) => i.code === "BELOW_MINIMUM_QUANTITY" && i.minimum === 10), r.j);
  await CustomerGroup.updateOne({ _id: base0._id }, { $set: { orderLimits: { quantity: { min: null, max: 3 }, total: [] } } });
  r = await call("POST", `/api/v1/carts/${cartId}/validate`, A("rep", { contextId: ctx }));
  ok("above the maximum is invalid", r.j.issues.some((i) => i.code === "ABOVE_MAXIMUM_QUANTITY"), r.j);
  await CustomerGroup.updateOne({ _id: base0._id }, { $set: { orderLimits: { quantity: { min: null, max: null }, total: [] } } });
  const cartDoc = await mongoose.connection.db.collection("agentcarts").findOne({ _id: new mongoose.Types.ObjectId(cartId) });
  await mongoose.connection.db.collection("agentcarts").updateOne({ _id: cartDoc._id }, { $set: { items: [] } });
  r = await call("POST", `/api/v1/carts/${cartId}/validate`, A("rep", { contextId: ctx }));
  ok("an empty cart is invalid", r.j.valid === false && r.j.issues[0].code === "EMPTY_CART", r.j);

  // ---- quotes under the doc paths
  const items = [{ variantId: "111", title: "Bracelet", sku: "B-1", quantity: 2, baselineUnit: 4000, unitPrice: 3800 }];
  r = await call("POST", "/api/v1/quotes", A("rep", { contextId: ctx, items, currency: "usd" }));
  ok("POST /v1/quotes creates a quote", r.s === 201 && r.j.number === "Q-0001", r);
  const quoteId = r.j.id;
  r = await call("POST", `/api/v1/quotes/${quoteId}/send`, A("rep"));
  ok("POST /v1/quotes/{id}/send sends it", r.s === 200 && r.j.status === "SENT", r);
  r = await call("POST", `/api/v1/quotes/${quoteId}/accept`, { shop, buyerShopifyCustomerId: gid("custA") });
  ok("POST /v1/quotes/{id}/accept: the buyer accepts", r.s === 200 && r.j.status === "ACCEPTED", r);
  r = await call("POST", `/api/v1/quotes/${quoteId}/accept`, { shop, buyerShopifyCustomerId: gid("custB") });
  ok("another customer can't (404)", r.s === 404, r);
  r = await call("POST", `/api/v1/quotes/${quoteId}/convert`, A("rep", { orderId: "gid://shopify/DraftOrder/1" }));
  ok("POST /v1/quotes/{id}/convert marks it converted", r.s === 200 && r.j.status === "CONVERTED", r);

  // ---- not served here
  r = await call("GET", "/api/v1/catalog/products?shop=" + shop);
  ok("catalog says it is served by the storefront (501)", r.s === 501 && r.j.code === "SERVED_BY_STOREFRONT", r);
  r = await call("POST", "/api/v1/orders", { shop });
  ok("orders likewise (501)", r.s === 501, r);
  r = await call("GET", "/api/v1/context", null, { "Content-Type": "application/json" });
  ok("no internal key -> 401", r.s === 401, r);

  // ---- audit
  r = await call("GET", "/api/v1/agent/audit" + q("rep"));
  ok("GET /v1/agent/audit: the agent role reads only their own activity", r.s === 200 && r.j.scope === "own" && r.j.events.length > 0 && r.j.events.every((e) => e.actorType === "sales_agent"), r.j && { scope: r.j.scope, n: r.j.events && r.j.events.length });
  const mine = await Audit.countDocuments({ shop, actor: rep._id });
  ok("...and that is all of them, no one else's", r.j.events.length === Math.min(mine, 50), [r.j.events.length, mine]);
  r = await call("GET", "/api/v1/agent/audit" + q("mgr"));
  ok("a manager reads everyone's", r.s === 200 && r.j.scope === "all" && r.j.events.some((e) => e.actorType === "sales_agent"), r.j && r.j.scope);
  ok("hashes and internal fields are not returned", !JSON.stringify(r.j).includes("prevHash") && !JSON.stringify(r.j).includes("\"hash\""));
  r = await call("GET", "/api/v1/agent/audit" + q("nocart"));
  ok("a role without audit.read is refused (403)", r.s === 403, r);
  r = await call("GET", "/api/v1/agent/audit" + q("mgr", "&action=quote.created"));
  ok("filter by action", r.j.events.length >= 1 && r.j.events.every((e) => e.action === "quote.created"), r.j);
  r = await call("GET", "/api/v1/agent/audit" + q("mgr", "&from=nonsense"));
  ok("a bad date is refused (400)", r.s === 400, r);
  r = await call("GET", "/api/v1/agent/audit" + q("mgr", "&limit=2"));
  ok("limit is respected", r.j.events.length === 2, r.j.events.length);
  r = await call("GET", `/api/v1/agent/audit?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("ghost"))}`);
  ok("not an agent (403)", r.s === 403, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
