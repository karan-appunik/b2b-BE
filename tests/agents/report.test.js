const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
const R = (m) => require(require("path").join(ROOT, m));
const mongoose = R("node_modules/mongoose");
const jwt = R("node_modules/jsonwebtoken");
const app = R("app");
const reports = R("src/services/report.service");
const Customer = R("src/models/customer.model");
const CustomerGroup = R("src/models/customerGroup.model");
const Order = R("src/models/order.model");
const Quote = R("src/models/quote.model");
const Override = R("src/models/overrideRequest.model");
const AgentCart = R("src/models/agentCart.model");
const Outbox = R("src/models/outboxEvent.model");
const Audit = R("src/models/auditEvent.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  // ---------- pure arithmetic
  const A = { key: "a", label: "Alice" }, B = { key: "b", label: "Bob" };
  let r = reports.aggregate({
    orders: [
      { bucket: A, amount: 100, currency: "USD", customer: "c1" },
      { bucket: A, amount: 50.5, currency: "USD", customer: "c1" },
      { bucket: A, amount: 200, currency: "EUR", customer: "c2" },
      { bucket: B, amount: 30, currency: "USD", customer: "c3" },
    ],
    quotes: [
      { bucket: A, status: "DRAFT" }, { bucket: A, status: "SENT" }, { bucket: A, status: "CONVERTED" },
      { bucket: A, status: "ACCEPTED" }, { bucket: A, status: "DECLINED" }, { bucket: B, status: "WITHDRAWN" },
    ],
    overrides: [{ bucket: A }, { bucket: A }, { bucket: B }],
    newCustomers: [{ bucket: B }, { bucket: B }],
  });
  const a = r.rows.find((x) => x.key === "a"), b = r.rows.find((x) => x.key === "b");
  ok("orders, revenue per currency", a.orders === 3 && a.revenue.USD === 150.5 && a.revenue.EUR === 200, a);
  ok("average order value per currency (150.5/2 and 200/1)", a.averageOrderValue.USD === 75.25 && a.averageOrderValue.EUR === 200, a.averageOrderValue);
  ok("active accounts counts each customer once", a.activeAccounts === 2 && b.activeAccounts === 1 && r.total.activeAccounts === 3, [a.activeAccounts, b.activeAccounts, r.total.activeAccounts]);
  ok("quotes: created 5, sent 4 (sent and later), accepted 2, converted 1", a.quotes.created === 5 && a.quotes.sent === 4 && a.quotes.accepted === 2 && a.quotes.converted === 1, a.quotes);
  ok("quote conversion = converted / sent = 25%", a.quoteConversion === 25, a.quoteConversion);
  ok("a bucket with no sent quotes has no conversion (null, not 0)", b.quoteConversion === null, b);
  ok("override rate = overrides per order: 2/3 = 66.7%", a.overrideRate === 66.7 && b.overrideRate === 100, [a.overrideRate, b.overrideRate]);
  ok("new customers per bucket", b.newCustomers === 2 && a.newCustomers === 0);
  ok("the total row adds up", r.total.orders === 4 && r.total.revenue.USD === 180.5 && r.total.quotes.created === 6 && r.total.overrides === 3 && r.total.newCustomers === 2, r.total);
  ok("rows are ordered by orders, busiest first", r.rows[0].key === "a");
  r = reports.aggregate({ orders: [], quotes: [], overrides: [], newCustomers: [] });
  ok("an empty period is all zeros, no rate", r.rows.length === 0 && r.total.orders === 0 && r.total.overrideRate === null && r.total.quoteConversion === null && r.total.activeAccounts === 0, r.total);

  // ---------- period rules
  const now = new Date("2026-10-10T00:00:00Z");
  let p = reports.parsePeriod(undefined, undefined, now);
  ok("default period is the last 30 days", Math.round((p.to - p.from) / 864e5) === 30);
  for (const [f, t, label] of [["x", undefined, "bad date"], ["2026-10-02", "2026-10-01", "start after end"], ["2024-01-01", "2026-01-01", "more than a year"]]) {
    let err; try { reports.parsePeriod(f, t, now); } catch (e) { err = e; }
    ok("refuses " + label, err && err.code === "INVALID_PERIOD", err && err.message);
  }

  // ---------- through the API with real data
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_report");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const get = async (p2, headers = AH) => { const x = await fetch(base + p2, { headers }); return { s: x.status, j: await x.json() }; };
  const gid = (n) => "gid://shopify/Customer/" + n;

  const g = await CustomerGroup.create({ shop, name: "Wholesale", handle: "wholesale", shopifyTag: "ws" });
  const alice = await Customer.create({ name: "Alice", email: "a@x.com", shop, shopifyCustomerId: gid("alice"), role: "sales_agent", territory: "North" });
  const bob = await Customer.create({ name: "Bob", email: "b@x.com", shop, shopifyCustomerId: gid("bob"), role: "sales_agent", territory: "South" });
  const c1 = await Customer.create({ name: "C1", email: "c1@x.com", shop, shopifyCustomerId: gid("c1"), territory: "North", customerGroup: g._id });
  const c2 = await Customer.create({ name: "C2", email: "c2@x.com", shop, shopifyCustomerId: gid("c2"), territory: "South" });
  await Customer.create({ name: "Fresh", email: "f@x.com", shop, shopifyCustomerId: gid("fresh"), createdByAgent: alice._id, provisional: true });
  const when = new Date(Date.now() - 5 * 864e5);
  const mk = (id, cust, agent, price, src = "sales_agent") => Order.create({ shop, shopifyOrderId: id, name: "#" + id, orderedAt: when, totalPrice: price, currency: "USD", shopifyCustomerId: gid(cust), source: src === "none" ? undefined : src, placedByAgent: agent ? { agent: agent._id } : undefined });
  await mk("1", "c1", alice, 100); await mk("2", "c1", alice, 300); await mk("3", "c2", bob, 50); await mk("4", "c2", null, 999, "none");
  await Order.create({ shop, shopifyOrderId: "old", name: "#old", orderedAt: new Date(Date.now() - 90 * 864e5), totalPrice: 5000, currency: "USD", shopifyCustomerId: gid("c1"), source: "sales_agent", placedByAgent: { agent: alice._id } });
  await Quote.create({ shop, number: "Q-1", customer: c1._id, ownerAgent: alice._id, status: "CONVERTED" });
  await Quote.create({ shop, number: "Q-2", customer: c2._id, ownerAgent: bob._id, status: "SENT", expiresAt: new Date(Date.now() + 864e5) });
  await Override.create({ shop, agent: alice._id, customer: c1._id, type: "UNIT_PRICE", permission: "price.override", baseline: { amount: 100, currency: "USD" }, proposed: { amount: 90, currency: "USD" }, reasonCode: "OTHER", reasonText: "x", status: "APPROVED" });
  await Override.create({ shop, agent: alice._id, customer: c1._id, type: "UNIT_PRICE", permission: "price.override", baseline: { amount: 100, currency: "USD" }, proposed: { amount: 90, currency: "USD" }, reasonCode: "OTHER", reasonText: "x", status: "DENIED" });

  let x = await get("/api/reports/sales-agents?groupBy=agent");
  const al = x.j.rows.find((q) => q.label === "Alice");
  ok("by agent: Alice has 2 assisted orders worth 400", x.s === 200 && al.orders === 2 && al.revenue.USD === 400, x.j.rows);
  ok("assisted orders only: the self-service order and the old one are left out", x.j.total.orders === 3 && x.j.total.revenue.USD === 450, x.j.total);
  ok("order sources are told apart", x.j.sources.assisted.orders === 3 && x.j.sources.other.orders === 1 && x.j.sources.other.revenue.USD === 999, x.j.sources);
  ok("Alice: 1 quote converted, 1 override counted (denied one is not), 1 new customer", al.quotes.converted === 1 && al.overrides === 1 && al.newCustomers === 1 && al.overrideRate === 50, al);
  x = await get("/api/reports/sales-agents?groupBy=territory");
  ok("by territory: North 400 (from the customers' territory), South 50", x.j.rows.find((q) => q.label === "North").revenue.USD === 400 && x.j.rows.find((q) => q.label === "South").revenue.USD === 50, x.j.rows);
  x = await get("/api/reports/sales-agents?groupBy=segment");
  ok("by segment: Wholesale 400, No group 50", x.j.rows.find((q) => q.label === "Wholesale").revenue.USD === 400 && x.j.rows.find((q) => q.label === "No group").revenue.USD === 50, x.j.rows);
  x = await get("/api/reports/sales-agents?groupBy=none");
  ok("no grouping: one row 'All' equals the total", x.j.rows.length === 1 && x.j.rows[0].orders === x.j.total.orders, x.j.rows);
  x = await get("/api/reports/sales-agents?groupBy=nonsense");
  ok("unknown grouping is refused", x.s === 400 && x.j.code === "INVALID_GROUP", x);
  x = await get("/api/reports/sales-agents?from=2026-10-02&to=2026-10-01");
  ok("bad period is refused", x.s === 400 && x.j.code === "INVALID_PERIOD", x);
  x = await get("/api/reports/sales-agents", { "Content-Type": "application/json" });
  ok("login required (401)", x.s === 401, x);
  x = await get("/api/reports/sales-agents?from=" + new Date(Date.now() - 100 * 864e5).toISOString() + "&to=" + new Date().toISOString() + "&groupBy=agent");
  ok("a wider period brings the old order in", x.j.total.orders === 4 && x.j.total.revenue.USD === 5450, x.j.total);

  // ---------- operational report
  await AgentCart.create({ shop, agent: alice._id, customer: c1._id, items: [{ variantId: "1", quantity: 1 }] });
  await AgentCart.collection.updateOne({ shop }, { $set: { updatedAt: new Date(Date.now() - 10 * 864e5) } });
  await Quote.create({ shop, number: "Q-3", customer: c1._id, ownerAgent: alice._id, status: "SENT", expiresAt: new Date(Date.now() + 864e5) });
  await Quote.create({ shop, number: "Q-4", customer: c1._id, ownerAgent: alice._id, status: "SENT", expiresAt: new Date(Date.now() + 20 * 864e5) });
  const old = await Override.create({ shop, agent: bob._id, customer: c2._id, type: "UNIT_PRICE", permission: "price.override", baseline: { amount: 100, currency: "USD" }, proposed: { amount: 80, currency: "USD" }, reasonCode: "OTHER", reasonText: "x", status: "PENDING_APPROVAL", route: { slaHours: 4 } });
  await Override.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 6 * 36e5) } });
  await Override.create({ shop, agent: bob._id, customer: c2._id, type: "UNIT_PRICE", permission: "price.override", baseline: { amount: 100, currency: "USD" }, proposed: { amount: 80, currency: "USD" }, reasonCode: "OTHER", reasonText: "x", status: "PENDING_APPROVAL", route: { slaHours: 24 } });
  await Outbox.create({ shop, eventId: "e1", type: "t", occurredAt: new Date(), status: "failed" });
  await Outbox.create({ shop, eventId: "e2", type: "t", occurredAt: new Date(Date.now() - 3600e3), status: "pending" });
  await Outbox.create({ shop, eventId: "e3", type: "t", occurredAt: new Date(), status: "delivered" });
  for (let i = 0; i < 6; i++) await Audit.create({ shop, actorType: "sales_agent", actorShopifyCustomerId: gid("bob"), action: "context.denied", outcome: "denied" });
  for (let i = 0; i < 2; i++) await Audit.create({ shop, actorType: "sales_agent", actorShopifyCustomerId: gid("alice"), action: "context.denied", outcome: "denied" });

  x = await get("/api/reports/operations");
  const o = x.j;
  ok("pending approvals: 2, one past its SLA (6h > 4h), oldest ~6h", x.s === 200 && o.pendingApprovals.count === 2 && o.pendingApprovals.slaBreaches === 1 && o.pendingApprovals.oldestHours === 6, o.pendingApprovals);
  ok("stale carts: 1 (untouched 10 days)", o.staleCarts.count === 1, o.staleCarts);
  ok("quotes expiring within 3 days: 2 (Q-2 and Q-3; Q-4 is 20 days away)", o.expiringQuotes.count === 2, o.expiringQuotes);
  ok("integrations: 1 failed, 1 stuck in the backlog (delivered ones ignored); no webhook set so flagged as not configured", o.integrations.failed === 1 && o.integrations.backlog === 1 && o.integrations.webhookConfigured === false, o.integrations);
  ok("access anomalies: Bob (6 denials) is listed, Alice (2) is not", o.accessAnomalies.length === 1 && o.accessAnomalies[0].agent === gid("bob") && o.accessAnomalies[0].deniedLast24h === 6, o.accessAnomalies);
  x = await get("/api/reports/operations", { "Content-Type": "application/json" });
  ok("operations report needs login (401)", x.s === 401);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
