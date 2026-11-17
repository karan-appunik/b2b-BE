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
const Quote = R("src/models/quote.model");
const Override = R("src/models/overrideRequest.model");
const AgentCart = R("src/models/agentCart.model");
const ContextSession = R("src/models/contextSession.model");
const Notification = R("src/models/notification.model");
const Audit = R("src/models/auditEvent.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_handover");
  await mongoose.connection.dropDatabase();
  await Notification.syncIndexes();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const call = async (m, p, body) => {
    const r = await fetch(base + p, { method: m, headers: AH, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });
  await call("GET", "/api/roles");

  const leaver = await mk("leaver", { role: "sales_agent" });
  const heir = await mk("heir", { role: "sales_agent" });
  const boss = await mk("boss", { role: "sales_manager" });
  const plain = await mk("plain");
  const c1 = await mk("c1"), c2 = await mk("c2");

  const setup = async () => {
    await Quote.deleteMany({}); await Override.deleteMany({}); await AgentCart.deleteMany({}); await Notification.deleteMany({});
    await Customer.updateOne({ _id: leaver._id }, { $set: { role: "sales_agent" } });
    await Quote.create({ shop, number: "Q-1", customer: c1._id, ownerAgent: leaver._id, status: "SENT" });
    await Quote.create({ shop, number: "Q-2", customer: c2._id, ownerAgent: leaver._id, status: "DRAFT" });
    await Quote.create({ shop, number: "Q-3", customer: c1._id, ownerAgent: leaver._id, status: "CONVERTED" });
    await Quote.create({ shop, number: "Q-4", customer: c1._id, ownerAgent: boss._id, status: "SENT" });
    const ov = (status) => Override.create({ shop, agent: leaver._id, customer: c1._id, type: "UNIT_PRICE", permission: "price.override", baseline: { amount: 100, currency: "USD" }, proposed: { amount: 70, currency: "USD" }, reasonCode: "OTHER", reasonText: "x", status });
    await ov("PENDING_APPROVAL"); await ov("APPROVED"); await ov("REJECTED");
    await AgentCart.create({ shop, agent: leaver._id, customer: c1._id, items: [{ variantId: "1", quantity: 1 }] });
    await AgentCart.create({ shop, agent: leaver._id, customer: c2._id, items: [{ variantId: "2", quantity: 1 }] });
    await AgentCart.create({ shop, agent: heir._id, customer: c2._id, items: [{ variantId: "9", quantity: 5 }] });
  };

  // ---- hand over to a named agent
  await setup();
  await Grant.create({ shop, agent: leaver._id, scopeType: "customer", scopeId: String(c1._id) });
  const ctx = await ContextSession.create({ shop, agent: leaver._id, customer: c1._id, issuedAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  let r = await call("PUT", `/api/customers/${leaver._id}`, { role: "customer", handoverTo: String(heir._id) });
  ok("demoting an agent works and reports what happened", r.s === 200 && r.j.handover && r.j.handover.handedTo === "heir", r);
  ok("their open contexts are ended", !!(await ContextSession.findById(ctx._id)).revokedAt);
  ok("waiting and approved exceptions are withdrawn; finished ones are left", (await Override.countDocuments({ status: "CANCELLED" })) === 2 && (await Override.countDocuments({ status: "REJECTED" })) === 1 && r.j.handover.exceptionsWithdrawn === 2, r.j.handover);
  ok("open quotes (sent, draft) go to the new owner; a converted quote and others' quotes are untouched", (await Quote.countDocuments({ ownerAgent: heir._id })) === 2 && (await Quote.findOne({ number: "Q-3" })).ownerAgent.equals(leaver._id) && (await Quote.findOne({ number: "Q-4" })).ownerAgent.equals(boss._id), r.j.handover);
  const moved = await Quote.findOne({ number: "Q-1" });
  ok("the move is on the quote's timeline", moved.activity.some((a) => a.type === "reassigned" && /leaver to heir/.test(a.comment)));
  ok("a cart moves if the new agent has none for that customer; if they do, it stays", (await AgentCart.countDocuments({ agent: heir._id })) === 2 && (await AgentCart.countDocuments({ agent: leaver._id })) === 1 && r.j.handover.cartsMoved === 1, r.j.handover);
  ok("the heir is told", !!(await Notification.findOne({ type: "agent.handover", recipient: heir._id })));
  ok("managers are told what was left (a cart stayed)", !!(await Notification.findOne({ type: "agent.disabled", recipient: boss._id })) && !!(await Notification.findOne({ type: "agent.disabled" })).body.includes("saved cart"));
  ok("the handover is audited", !!(await Audit.findOne({ shop, action: "agent.work_reassigned", objectId: String(leaver._id) })));

  // ---- no successor named
  await setup();
  r = await call("PUT", `/api/customers/${leaver._id}`, { role: "customer" });
  ok("with no successor, quotes stay put and the managers are told they have no owner", r.s === 200 && r.j.handover.quotesMoved === 0 && (await Quote.countDocuments({ ownerAgent: leaver._id })) === 3 && (await Notification.findOne({ type: "agent.disabled", recipient: boss._id })).body.includes("2 open quote(s) still have no new owner"), r.j.handover);
  ok("exceptions are withdrawn all the same", r.j.handover.exceptionsWithdrawn === 2);

  // ---- bad successors are refused before anything changes
  await setup();
  r = await call("PUT", `/api/customers/${leaver._id}`, { role: "customer", handoverTo: String(plain._id) });
  ok("a plain customer can't take over (400), and the agent is NOT demoted", r.s === 400 && r.j.code === "INVALID_HANDOVER" && (await Customer.findById(leaver._id)).role === "sales_agent", r);
  r = await call("PUT", `/api/customers/${leaver._id}`, { role: "customer", handoverTo: String(leaver._id) });
  ok("handing over to themselves is refused (400)", r.s === 400 && (await Customer.findById(leaver._id)).role === "sales_agent", r);
  r = await call("PUT", `/api/customers/${leaver._id}`, { role: "customer", handoverTo: "nonsense" });
  ok("a bad id is refused (400)", r.s === 400, r);
  ok("nothing was moved by the refused attempts", (await Quote.countDocuments({ ownerAgent: leaver._id })) === 3 && (await Override.countDocuments({ status: "CANCELLED" })) === 0);

  // ---- other role changes do not trigger it
  await setup();
  r = await call("PUT", `/api/customers/${leaver._id}`, { role: "sales_manager" });
  ok("changing between sales roles hands nothing over", r.s === 200 && !r.j.handover && (await Quote.countDocuments({ ownerAgent: leaver._id })) === 3);
  r = await call("PUT", `/api/customers/${plain._id}`, { company: "Acme" });
  ok("editing a plain customer hands nothing over", r.s === 200 && !r.j.handover);
  r = await call("PUT", `/api/customers/${leaver._id}`, { name: "leaver" });
  ok("saving other fields of an active agent changes nothing", r.s === 200 && !r.j.handover);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
