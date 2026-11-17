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
const Override = R("src/models/overrideRequest.model");
const Quote = R("src/models/quote.model");
const Outbox = R("src/models/outboxEvent.model");
const Audit = R("src/models/auditEvent.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_orderrefs");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const call = async (m, p, body) => {
    const r = await fetch(base + p, { method: m, headers: IH, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });
  await call("GET", "/api/internal/agent/dashboard?shop=" + shop + "&agentShopifyCustomerId=x");

  const rep = await mk("rep", { role: "sales_agent" });
  const other = await mk("other", { role: "sales_agent" });
  const cust = await mk("cust"), cust2 = await mk("cust2");
  for (const a of [rep, other]) await Grant.create({ shop, agent: a._id, scopeType: "customer", scopeId: String(cust._id) });
  const ctx = (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("rep"), customerId: String(cust._id) })).j.contextId;

  const ov = (agent, customer) => Override.create({ shop, agent: agent._id, customer: customer._id, type: "UNIT_PRICE", permission: "price.override", baseline: { amount: 100, currency: "USD" }, proposed: { amount: 90, currency: "USD" }, reasonCode: "OTHER", reasonText: "x", status: "APPLIED" });
  const mine = await ov(rep, cust), theirs = await ov(other, cust), wrongCustomer = await ov(rep, cust2);
  const quote = await Quote.create({ shop, number: "Q-1", customer: cust._id, ownerAgent: rep._id, status: "CONVERTED" });
  const foreignQuote = await Quote.create({ shop, number: "Q-2", customer: cust2._id, ownerAgent: rep._id, status: "CONVERTED" });

  const order = (id, claim, extra = {}) => ({
    shopifyOrderId: id, name: "#" + id, orderedAt: new Date().toISOString(), totalPrice: 120, currency: "USD", shopifyCustomerId: gid("cust"),
    placedByAgent: { agentShopifyCustomerId: gid("rep"), contextId: ctx, ...claim }, ...extra,
  });

  let r = await call("POST", "/api/internal/orders/sync", { shop, orders: [order("1001", { overrideIds: [String(mine._id), String(theirs._id), String(wrongCustomer._id), "junk"], quoteId: String(quote._id) }, { poNumber: "PO-778", requestedDeliveryDate: "2026-11-15" })] });
  ok("an agent's order is stored", r.s === 200, r);
  const o = await Order.findOne({ shop, shopifyOrderId: "1001" });
  ok("it keeps the agent and the context", String(o.placedByAgent.agent) === String(rep._id) && String(o.placedByAgent.context) === ctx);
  ok("it keeps only the exceptions that were really this agent's, for this customer", o.placedByAgent.overrides.length === 1 && String(o.placedByAgent.overrides[0]) === String(mine._id), o.placedByAgent.overrides);
  ok("it keeps the quote it came from", String(o.placedByAgent.quote) === String(quote._id));
  ok("the PO number and delivery date are kept", o.poNumber === "PO-778" && o.requestedDeliveryDate === "2026-11-15", o);
  const ev = await Outbox.findOne({ shop, type: "sales_agent.order.created" });
  ok("the order event names the exceptions and the quote", ev.payload.override_ids.length === 1 && ev.payload.quote_id === String(quote._id), ev.payload);
  ok("the audit trail has them too", !!(await Audit.findOne({ shop, action: "order.attributed", "metadata.quote": String(quote._id) })));

  r = await call("POST", "/api/internal/orders/sync", { shop, orders: [order("1002", { quoteId: String(foreignQuote._id) })] });
  const o2 = await Order.findOne({ shop, shopifyOrderId: "1002" });
  ok("a quote that belongs to another customer is not attached", o2.placedByAgent.agent && !o2.placedByAgent.quote, o2.placedByAgent);
  r = await call("POST", "/api/internal/orders/sync", { shop, orders: [order("1003", { overrideIds: [], quoteId: "nope" })] });
  const o3 = await Order.findOne({ shop, shopifyOrderId: "1003" });
  ok("an invalid quote id is ignored", !!o3 && !o3.placedByAgent.quote);

  r = await call("POST", "/api/internal/orders/sync", { shop, orders: [order("1001", { overrideIds: [String(theirs._id)] })] });
  const again = await Order.findOne({ shop, shopifyOrderId: "1001" });
  ok("syncing the same order again changes nothing", again.placedByAgent.overrides.length === 1 && String(again.placedByAgent.overrides[0]) === String(mine._id) && (await Outbox.countDocuments({ shop, type: "sales_agent.order.created" })) === 3);

  r = await call("POST", "/api/internal/orders/sync", { shop, orders: [{ shopifyOrderId: "2001", name: "#2001", orderedAt: new Date().toISOString(), totalPrice: 5, currency: "USD", shopifyCustomerId: gid("cust"), poNumber: "SELF-1" }] });
  const self = await Order.findOne({ shop, shopifyOrderId: "2001" });
  ok("a customer's own order keeps its PO number and has no agent", self.poNumber === "SELF-1" && !self.placedByAgent.agent && !self.source, self);
  r = await call("POST", "/api/internal/orders/sync", { shop, orders: [{ shopifyOrderId: "2002", name: "#2002", orderedAt: new Date().toISOString(), totalPrice: 5, currency: "USD", shopifyCustomerId: gid("cust"), poNumber: "x".repeat(200) }] });
  ok("a very long PO number is cut to 64 characters", (await Order.findOne({ shop, shopifyOrderId: "2002" })).poNumber.length === 64);
  r = await call("POST", "/api/internal/orders/sync", { shop, orders: [{ shopifyOrderId: "2003", name: "#2003", orderedAt: new Date().toISOString(), totalPrice: 5, currency: "USD", shopifyCustomerId: gid("cust"), internalNote: "Call before delivery" }] });
  ok("an internal note is kept on our record", (await Order.findOne({ shop, shopifyOrderId: "2003" })).internalNote === "Call before delivery");
  r = await call("POST", "/api/internal/orders/sync", { shop, orders: [{ shopifyOrderId: "2004", name: "#2004", orderedAt: new Date().toISOString(), totalPrice: 5, currency: "USD", shopifyCustomerId: gid("cust"), internalNote: "y".repeat(900) }] });
  ok("a very long internal note is cut to 500 characters", (await Order.findOne({ shop, shopifyOrderId: "2004" })).internalNote.length === 500);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
