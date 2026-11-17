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
const Notification = R("src/models/notification.model");
const Outbox = R("src/models/outboxEvent.model");
const Audit = R("src/models/auditEvent.model");
const { dispatchDue, MAX_ATTEMPTS } = R("src/services/outbox.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_orderfail");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const user = await User.create({ name: "M", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const adm = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: AH, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => null) }; };
  const int = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: IH, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => null) }; };
  await adm("GET", "/api/roles");
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });
  const agent = await mk("agent", { role: "sales_agent" });
  const boss = await mk("boss", { role: "sales_manager" });
  const other = await mk("other", { role: "sales_agent" });
  const buyer = await mk("buyer", { company: "Buyer Co" });
  const fail1 = (key, extra) => int("POST", "/api/internal/agent/order-failed", { shop, agentShopifyCustomerId: gid("agent"), customerId: String(buyer._id), key, code: "SHOPIFY_ERROR", message: "Could not complete order", ...extra });

  let r = await fail1("k1");
  ok("the first failure is only noted", r.s === 200 && r.j.attempts === 1 && r.j.alerted === false && (await Notification.countDocuments({ type: "order.failed" })) === 0, r.j);
  r = await fail1("k1");
  ok("the second failure of the same order raises the alert", r.j.attempts === 2 && r.j.alerted === true, r.j);
  const notes = await Notification.find({ type: "order.failed" }).lean();
  ok("the agent is told", notes.some((n) => String(n.recipient) === String(agent._id) && /Buyer Co/.test(n.body) && /Could not complete order/.test(n.body)), notes);
  ok("their manager is told, another agent is not", notes.some((n) => String(n.recipient) === String(boss._id)) && !notes.some((n) => String(n.recipient) === String(other._id)), notes.map((n) => String(n.recipient)));
  r = await fail1("k1");
  ok("a third failure does not alert again", r.j.alerted === false && (await Notification.countDocuments({ type: "order.failed" })) === notes.length, r.j);
  r = await fail1("k2");
  ok("a different order starts its own count", r.j.attempts === 1 && r.j.alerted === false, r.j);
  ok("the alert is audited", !!(await Audit.findOne({ shop, action: "order.failed" })));
  ok("the alert is an event", !!(await Outbox.findOne({ type: "sales_agent.order.failed" })));

  r = await int("POST", "/api/internal/agent/order-failed", { shop, agentShopifyCustomerId: gid("nobody"), key: "k3" });
  ok("someone who is not an agent is not recorded", r.j.recorded === false, r.j);

  r = await adm("PUT", "/api/agent-settings", { orderFailAlertAfter: 1 });
  ok("the merchant can alert on the first failure", r.s === 200 && r.j.orderFailAlertAfter === 1, r);
  r = await fail1("k4");
  ok("...and then one failure is enough", r.j.alerted === true, r.j);
  r = await adm("PUT", "/api/agent-settings", { orderFailAlertAfter: 0 });
  ok("a count under 1 is refused", r.s === 400, r);

  // ---- an event nobody could deliver
  process.env.AGENT_EVENTS_WEBHOOK_URL = "http://localhost:1/none";
  await Outbox.create({ shop, eventId: "ev-1", type: "sales_agent.order.created", occurredAt: new Date(), payload: {}, attempts: MAX_ATTEMPTS - 1, status: "pending", nextAttemptAt: new Date(Date.now() - 1000) });
  const failing = async () => { throw new Error("connection refused"); };
  await dispatchDue({ fetchImpl: failing });
  await new Promise((res) => setTimeout(res, 300));
  const intNotes = await Notification.find({ type: "integration.failed" }).lean();
  ok("when delivery is given up, managers are told once", intNotes.length === 1 && String(intNotes[0].recipient) === String(boss._id) && /connection refused/.test(intNotes[0].body), intNotes);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  process.exit(fail ? 1 : 0);
})();
