const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
delete process.env.AGENT_EVENTS_WEBHOOK_URL;
const http = require("http");
const crypto = require("crypto");
const R = (m) => require(require("path").join(ROOT, m));
const mongoose = R("node_modules/mongoose");
const jwt = R("node_modules/jsonwebtoken");
const app = R("app");
const Customer = R("src/models/customer.model");
const Grant = R("src/models/agentScopeGrant.model");
const Outbox = R("src/models/outboxEvent.model");
const Audit = R("src/models/auditEvent.model");
const User = R("src/models/user.model");
const { dispatchDue, MAX_ATTEMPTS } = R("src/services/outbox.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_outbox");
  await mongoose.connection.dropDatabase();
  await Outbox.init();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const H = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const call = async (m, p, body, headers = H) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json() };
  };
  const user = await User.create({ name: "M", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };

  // a receiver we control
  const received = [];
  let mode = "ok";
  const receiver = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ headers: req.headers, raw });
      res.statusCode = mode === "ok" ? 200 : 500;
      res.end("x");
    });
  });
  await new Promise((r) => receiver.listen(0, r));
  const recvUrl = "http://localhost:" + receiver.address().port + "/hook";

  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: "gid://shopify/Customer/" + name, ...extra });
  const agent = await mkc("agent", { role: "sales_agent" });
  const a = await mkc("custA");
  const b = await mkc("custB");
  await Grant.create({ shop, agent: agent._id, scopeType: "customer", scopeId: String(a._id) });
  const aid = "gid://shopify/Customer/agent";

  // ---- events are queued by business actions
  let r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(a._id) });
  const ctxId = r.j.contextId;
  await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(b._id) });
  await call("POST", "/api/internal/orders/sync", { shop, orders: [{ shopifyOrderId: "gid://shopify/Order/1", name: "#1001", orderedAt: new Date().toISOString(), totalPrice: 125, currency: "USD", shopifyCustomerId: a.shopifyCustomerId, placedByAgent: { agentShopifyCustomerId: aid, contextId: ctxId } }] });

  const types = (await Outbox.find({ shop }).sort({ occurredAt: 1 })).map((e) => e.type);
  ok("context.entered queued", types.includes("sales_agent.context.entered"), types);
  ok("context.denied queued", types.includes("sales_agent.context.denied"), types);
  ok("order.created queued", types.includes("sales_agent.order.created"), types);
  const ev = await Outbox.findOne({ type: "sales_agent.order.created" });
  ok("order.created has the spec's fields", ev.payload.order_id && ev.payload.customer_id && ev.payload.sales_agent_id && ev.payload.totals.amount === 125 && ev.payload.external_refs.shopify_order_id, ev.payload);
  ok("events start pending with a unique id", types.length === 3 && (await Outbox.countDocuments({ status: "pending" })) === 3);

  // ---- nothing is sent until a receiver is configured
  let d = await dispatchDue();
  ok("no webhook URL -> nothing sent, events wait", d.skipped === true && (await Outbox.countDocuments({ status: "pending" })) === 3, d);

  // ---- delivery
  process.env.AGENT_EVENTS_WEBHOOK_URL = recvUrl;
  process.env.AGENT_EVENTS_WEBHOOK_SECRET = "topsecret";
  d = await dispatchDue();
  ok("all 3 delivered", d.delivered === 3 && received.length === 3 && (await Outbox.countDocuments({ status: "delivered" })) === 3, d);
  const first = received[0];
  const body = JSON.parse(first.raw);
  ok("envelope has id, type, version, time, correlation, shop, data", body.event_id && body.type && body.schema_version === 1 && body.occurred_at && "correlation_id" in body && body.shop === shop && body.data, body);
  ok("signature is the HMAC of the exact body", first.headers["x-sparklayer-signature"] === "sha256=" + crypto.createHmac("sha256", "topsecret").update(first.raw).digest("hex"));
  ok("event id header matches the body", first.headers["x-sparklayer-event-id"] === body.event_id);
  ok("delivered in the order they happened", received.map((x) => JSON.parse(x.raw).type).join() === types.join(), received.map((x) => JSON.parse(x.raw).type));
  d = await dispatchDue();
  ok("delivered events are not sent again", d.delivered === 0 && received.length === 3, d);

  // ---- retries with backoff
  mode = "fail";
  await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(a._id) });
  const flaky = await Outbox.findOne({ status: "pending" });
  d = await dispatchDue();
  let row = await Outbox.findById(flaky._id);
  ok("failed delivery goes back to pending with attempts=1 and a later time", d.retried === 1 && row.status === "pending" && row.attempts === 1 && row.nextAttemptAt > new Date() && /500/.test(row.lastError), row);
  d = await dispatchDue();
  ok("not retried before its time", d.delivered === 0 && d.retried === 0, d);
  mode = "ok";
  d = await dispatchDue({ now: new Date(Date.now() + 60 * 1000) });
  row = await Outbox.findById(flaky._id);
  ok("retried once its time comes, then delivered", d.delivered === 1 && row.status === "delivered", { d, row });

  // ---- give up after the limit, audit it, allow a manual retry
  mode = "fail";
  await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(a._id) });
  const doomed = await Outbox.findOne({ status: "pending" });
  let when = Date.now();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    when += 2 * 60 * 60 * 1000;
    await dispatchDue({ now: new Date(when) });
  }
  row = await Outbox.findById(doomed._id);
  ok(`gives up after ${MAX_ATTEMPTS} attempts (status failed)`, row.status === "failed" && row.attempts === MAX_ATTEMPTS, row);
  const audited = await Audit.findOne({ action: "integration.failed", objectId: doomed.eventId });
  ok("integration.failed audited", audited && audited.outcome === "failure", audited);
  d = await dispatchDue({ now: new Date(when + 3 * 60 * 60 * 1000) });
  ok("failed events are left alone", d.delivered === 0 && d.retried === 0, d);

  r = await call("GET", "/api/outbox?status=failed", null, AH);
  ok("outbox API lists failed events + counts", r.s === 200 && r.j.events.length === 1 && r.j.counts.failed === 1 && r.j.counts.delivered >= 4, r);
  r = await call("GET", "/api/outbox?status=nope", null, AH);
  ok("bad status -> 400", r.s === 400, r);
  r = await call("GET", "/api/outbox", null, H);
  ok("internal key can't read the outbox", r.s === 401, r);
  mode = "ok";
  r = await call("POST", `/api/outbox/${doomed._id}/retry`, null, AH);
  ok("manual retry puts it back in the queue", r.s === 200 && r.j.status === "pending" && r.j.attempts === 0, r);
  d = await dispatchDue();
  ok("and it is then delivered", d.delivered === 1, d);
  r = await call("POST", `/api/outbox/${doomed._id}/retry`, null, AH);
  ok("retry of a non-failed event -> 404", r.s === 404, r);

  // ---- a stuck claim is recovered
  const stuck = await Outbox.create({ shop, eventId: crypto.randomUUID(), type: "sales_agent.context.entered", occurredAt: new Date(), payload: {}, status: "sending", lockedUntil: new Date(Date.now() - 1000) });
  d = await dispatchDue();
  ok("event stranded in 'sending' by a crashed dispatcher is picked up", d.delivered === 1 && (await Outbox.findById(stuck._id)).status === "delivered", d);

  // ---- no double delivery with two dispatchers at once
  received.length = 0;
  for (let i = 0; i < 6; i++) await Outbox.create({ shop, eventId: crypto.randomUUID(), type: "sales_agent.context.entered", occurredAt: new Date(), payload: { i } });
  const [d1, d2] = await Promise.all([dispatchDue(), dispatchDue()]);
  ok("two dispatchers at once deliver each event exactly once", d1.delivered + d2.delivered === 6 && received.length === 6, { d1, d2, received: received.length });

  console.log(`\n${pass} passed, ${fail} failed`);
  receiver.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
