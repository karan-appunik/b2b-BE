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
const Order = R("src/models/order.model");
const Quote = R("src/models/quote.model");
const Audit = R("src/models/auditEvent.model");
const ContextSession = R("src/models/contextSession.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_preentry");
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
  const mk = (n, extra) => Customer.create({ name: n, email: n.replace(/\s/g, "") + "@x.com", shop, shopifyCustomerId: gid(n.replace(/\s/g, "")), ...extra });
  const q = (n, extra = "") => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}${extra}`;
  await call("GET", "/api/roles", null, AH);

  const rep = await mk("rep", { role: "sales_agent" });
  const acme1 = await mk("Acme Foods Inc", { company: "Acme Foods Inc", creditLimit: 5000, creditBalance: 1200, territory: "North" });
  const acme2 = await mk("Acme Foods", { company: "ACME foods, LLC" });
  const solo = await mk("Zebra Traders", { company: "Zebra Traders" });
  for (const c of [acme1, acme2, solo]) await Grant.create({ shop, agent: rep._id, scopeType: "customer", scopeId: String(c._id) });

  // ---- similar names
  let r = await call("GET", "/api/internal/customers/search" + q("rep", "&q=acme"));
  ok("two accounts that look like the same business are marked similar", r.s === 200 && r.j.length === 2 && r.j.every((a) => a.similar === true), r.j);
  r = await call("GET", "/api/internal/customers/search" + q("rep", "&q=zebra"));
  ok("a one-of-a-kind name is not", r.j.length === 1 && r.j[0].similar === false && r.j[0].status === "active", r.j);
  r = await call("GET", "/api/internal/agent/dashboard" + q("rep"));
  ok("the account list carries the same marks", r.s === 200 && r.j.accounts.filter((a) => a.similar).length === 2 && r.j.accounts.every((a) => a.status), r.j.accounts);

  // ---- suspended
  r = await call("PUT", `/api/customers/${acme2._id}`, { accountStatus: "bogus" }, AH);
  ok("an unknown status is refused", r.s === 400, r);
  const ctxOpen = (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("rep"), customerId: String(acme2._id) })).j.contextId;
  ok("before suspending, the context works", !!ctxOpen);
  r = await call("PUT", `/api/customers/${acme2._id}`, { accountStatus: "suspended" }, AH);
  ok("the merchant suspends the account", r.s === 200 && r.j.accountStatus === "suspended", r);
  ok("an open context for it ends at once", !!(await ContextSession.findById(ctxOpen)).revokedAt && (await ContextSession.findById(ctxOpen)).revokedReason === "ACCOUNT_SUSPENDED");
  ok("the status change is audited", !!(await Audit.findOne({ shop, action: "customer.status_changed", "metadata.to": "suspended" })));
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("rep"), customerId: String(acme2._id) });
  ok("a new context for a suspended account is refused, like any denial", r.s === 403, r);
  ok("and the refusal says why in the audit trail", !!(await Audit.findOne({ shop, action: "context.denied", reasonCode: "ACCOUNT_SUSPENDED" })));
  r = await call("GET", "/api/internal/customers/search" + q("rep", "&q=acme"));
  ok("search still lists it, marked suspended (so an agent knows why)", r.j.find((a) => a.id === String(acme2._id)).status === "suspended", r.j);
  r = await call("PUT", `/api/customers/${acme2._id}`, { accountStatus: "active" }, AH);
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("rep"), customerId: String(acme2._id) });
  ok("once active again it can be entered", r.s === 201 || r.s === 200, r);
  const ctxM = r.j.contextId;
  await Customer.updateOne({ _id: acme2._id }, { $set: { accountStatus: "merged" } });
  r = await call("GET", `/api/internal/agent/contexts/${ctxM}/validate` + q("rep"));
  ok("an account merged while open ends the context when it is next used", r.s !== 200 || r.j.valid === false || r.j.active === false, r);
  ok("...recorded as such", (await ContextSession.findById(ctxM)).revokedReason === "ACCOUNT_MERGED");
  await Customer.updateOne({ _id: acme2._id }, { $set: { accountStatus: "active" } });

  // ---- the summary
  await Order.create({ shop, shopifyOrderId: "1", name: "#1001", orderedAt: new Date(Date.now() - 20 * 864e5), totalPrice: 100, currency: "USD", shopifyCustomerId: gid("AcmeFoodsInc"), fulfillmentStatus: "fulfilled" });
  await Order.create({ shop, shopifyOrderId: "2", name: "#1002", orderedAt: new Date(Date.now() - 2 * 864e5), totalPrice: 250.5, currency: "USD", shopifyCustomerId: gid("AcmeFoodsInc"), fulfillmentStatus: "unfulfilled" });
  await Quote.create({ shop, number: "Q-1", customer: acme1._id, ownerAgent: rep._id, status: "SENT" });
  await Quote.create({ shop, number: "Q-2", customer: acme1._id, ownerAgent: rep._id, status: "CONVERTED" });
  const ctx1 = (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("rep"), customerId: String(acme1._id) })).j.contextId;
  await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctx1, items: [{ variantId: "1", quantity: 1 }, { variantId: "2", quantity: 3 }] });
  r = await call("GET", "/api/internal/agent/customer-summary" + q("rep", "&contextId=" + ctx1));
  const s = r.j;
  ok("the summary names the customer, group and territory", r.s === 200 && s.customer.company === "Acme Foods Inc" && s.customer.territory === "North" && s.customer.group && s.customer.accountStatus === "active", s.customer);
  ok("credit: limit, used and what is left", s.credit && s.credit.limit === 5000 && s.credit.balance === 1200 && s.credit.available === 3800, s.credit);
  ok("orders: 2 in all, 1 still open, and the last one", s.orders.total === 2 && s.orders.open === 1 && s.orders.last.name === "#1002" && s.orders.last.total === 250.5, s.orders);
  ok("open quotes counts only the live ones (1 of 2)", s.openQuotes === 1, s);
  ok("the saved cart's lines", s.savedCartLines === 2);
  ok("payment terms are shown from the group", typeof s.terms.card === "boolean" && "payOnAccount" in s.terms, s.terms);
  r = await call("GET", "/api/internal/agent/customer-summary" + q("rep"));
  ok("without a context there is no summary (401)", r.s === 401, r);
  r = await call("GET", "/api/internal/agent/customer-summary" + q("rep", "&contextId=bad"));
  ok("a bad context id gives nothing (401)", r.s === 401, r);
  const other = await mk("Other Agent", { role: "sales_agent" });
  r = await call("GET", "/api/internal/agent/customer-summary" + q("OtherAgent", "&contextId=" + ctx1));
  ok("someone else's context can't be used (401)", r.s === 401, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
