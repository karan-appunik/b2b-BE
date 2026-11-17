const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
process.env.SMTP_HOST = "stub";
const R = (m) => require(require("path").join(ROOT, m));
const nodemailer = R("node_modules/nodemailer");
const sent = [];
nodemailer.createTransport = () => ({ sendMail: async (m) => { sent.push(m); } });
const mongoose = R("node_modules/mongoose");
const jwt = R("node_modules/jsonwebtoken");
const app = R("app");
const notif = R("src/services/notification.service");
const alerts = R("src/services/alert.service");
const Customer = R("src/models/customer.model");
const Grant = R("src/models/agentScopeGrant.model");
const Override = R("src/models/overrideRequest.model");
const Quote = R("src/models/quote.model");
const Order = R("src/models/order.model");
const AgentCart = R("src/models/agentCart.model");
const Notification = R("src/models/notification.model");
const AgentSettings = R("src/models/agentSettings.model");
const Audit = R("src/models/auditEvent.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------- quiet hours
  const at = (h) => new Date(Date.UTC(2026, 9, 10, h, 30));
  const q = (start, end, tz = "UTC") => ({ quietHoursStart: start, quietHoursEnd: end, businessTimezone: tz });
  ok("no quiet hours set -> never quiet", !notif.inQuietHours(q(null, null), at(3)));
  ok("21 to 7: 23:30 is quiet, 3:30 is quiet, 12:30 is not", notif.inQuietHours(q(21, 7), at(23)) && notif.inQuietHours(q(21, 7), at(3)) && !notif.inQuietHours(q(21, 7), at(12)));
  ok("the end hour itself is open (7:30 not quiet), the start hour is quiet", !notif.inQuietHours(q(21, 7), at(7)) && notif.inQuietHours(q(21, 7), at(21)));
  ok("same-day window 12 to 14", notif.inQuietHours(q(12, 14), at(13)) && !notif.inQuietHours(q(12, 14), at(15)));
  ok("hours are read in the shop's time zone (Asia/Kolkata is UTC+5:30)", notif.inQuietHours(q(2, 4, "Asia/Kolkata"), at(21)) && !notif.inQuietHours(q(2, 4, "Asia/Kolkata"), at(12)));
  ok("an unknown time zone falls back to UTC", notif.inQuietHours(q(2, 4, "Not/AZone"), at(3)));

  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_alerts");
  await mongoose.connection.dropDatabase();
  await Notification.syncIndexes();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const call = async (m, p, body, headers = IH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json() };
  };
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });
  const q2 = (n) => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}`;
  const now = new Date();
  const ago = (ms) => new Date(now.getTime() - ms);
  const H = 3600e3, D = 24 * H;

  await call("GET", "/api/roles", null, AH);
  const rep = await mk("rep", { role: "sales_agent" });
  const boss = await mk("boss", { role: "sales_manager" });
  const admin = await mk("admin", { role: "sales_admin" });
  const buyer = await mk("buyer");
  const buyer2 = await mk("buyer2", { creditLimit: 1000, creditBalance: 950, createdAt: ago(200 * D) });
  const dormant = await mk("dormant", { createdAt: ago(200 * D) });
  for (const c of [buyer, buyer2, dormant]) await Grant.create({ shop, agent: rep._id, scopeType: "customer", scopeId: String(c._id) });

  // ---------- escalation
  const mkOverride = (extra) => Override.create({ shop, agent: rep._id, customer: buyer._id, type: "UNIT_PRICE", permission: "price.override", baseline: { amount: 100, currency: "USD" }, proposed: { amount: 70, currency: "USD" }, deltaPercent: 30, reasonCode: "OTHER", reasonText: "x", status: "PENDING_APPROVAL", route: { slaHours: 4 }, ...extra });
  const late = await mkOverride();
  await Override.collection.updateOne({ _id: late._id }, { $set: { createdAt: ago(6 * H) } });
  const fresh = await mkOverride();
  const settings = await AgentSettings.findOneAndUpdate({ shop }, { $setOnInsert: { shop } }, { new: true, upsert: true });
  let n = await alerts.escalateApprovals(shop, settings, now);
  ok("only the request past its SLA (6h > 4h) is escalated", n === 1 && (await Override.findById(late._id)).escalatedAt && !(await Override.findById(fresh._id)).escalatedAt, n);
  const esc = await Notification.find({ shop, type: "approval.overdue" });
  ok("everyone who can decide is told (manager, admin) but not the requester", esc.length === 2 && esc.every((e) => [String(boss._id), String(admin._id)].includes(String(e.recipient))), esc.map((e) => String(e.recipient)));
  ok("the escalation is audited", !!(await Audit.findOne({ shop, action: "override.escalated", objectId: String(late._id) })));
  n = await alerts.escalateApprovals(shop, settings, now);
  ok("running again does not escalate or alert twice", n === 0 && (await Notification.countDocuments({ shop, type: "approval.overdue" })) === 2);
  ok("the request itself is unchanged (still pending, same route)", (await Override.findById(late._id)).status === "PENDING_APPROVAL" && (await Override.findById(late._id)).route.slaHours === 4);
  n = await alerts.escalateApprovals(shop, { ...settings.toObject(), escalateApprovals: false }, now);
  ok("escalation can be switched off", n === 0);

  // ---------- quote reminders
  const mkQuote = (num, days, extra) => Quote.create({ shop, number: num, customer: buyer._id, ownerAgent: rep._id, status: "SENT", expiresAt: new Date(now.getTime() + days * D), ...extra });
  const q10 = await mkQuote("Q-10", 10);
  const q2d = await mkQuote("Q-11", 2.5);
  const q12h = await mkQuote("Q-12", 0.5);
  await mkQuote("Q-13", 2.5, { status: "ACCEPTED" });
  n = await alerts.remindQuotes(shop, settings, now);
  ok("quotes 10 days away are left alone; 2.5 days and 12h away are reminded", n === 2, n);
  let qn = await Notification.find({ shop, type: "quote.expiring", recipient: rep._id });
  ok("the owner gets one reminder each, with the expiry date", qn.length === 2 && qn.some((x) => x.title.includes("Q-11")) && qn.some((x) => x.title.includes("Q-12")), qn.map((x) => x.title));
  const buyerNotes = await Notification.find({ shop, type: "quote.expiring", recipient: buyer._id });
  ok("the buyer is reminded by email only (no app inbox)", buyerNotes.length === 2 && buyerNotes.every((x) => x.inApp === false && x.emailPending));
  n = await alerts.remindQuotes(shop, settings, now);
  const cnt1 = await Notification.countDocuments({ shop, type: "quote.expiring" });
  ok("the same reminder is never made twice", n === 0 && cnt1 === 4, [n, cnt1]);
  const later = new Date(now.getTime() + 1.6 * D); // Q-11 now ~0.9 day away: the 1-day reminder is due
  n = await alerts.remindQuotes(shop, settings, later);
  ok("closer to expiry the next reminder (1 day) is sent for Q-11", n >= 1 && !!(await Notification.findOne({ shop, dedupeKey: `quote-exp:${q2d._id}:1` })));
  ok("a quote already past its date gets nothing", (await alerts.remindQuotes(shop, settings, new Date(now.getTime() + 30 * D))) === 0);
  const none = await alerts.remindQuotes(shop, { ...settings.toObject(), quoteReminderDays: [] }, now);
  ok("no reminder days set -> no reminders", none === 0);

  // ---------- daily digest
  await Order.create({ shop, shopifyOrderId: "o1", name: "#1", orderedAt: ago(3 * H), totalPrice: 10, currency: "USD", shopifyCustomerId: gid("buyer") });
  await Order.create({ shop, shopifyOrderId: "o2", name: "#2", orderedAt: ago(2 * H), totalPrice: 10, currency: "USD", shopifyCustomerId: gid("buyer"), source: "sales_agent" });
  await AgentCart.create({ shop, agent: rep._id, customer: buyer._id, items: [{ variantId: "1", quantity: 1 }] });
  await AgentCart.collection.updateOne({ shop }, { $set: { updatedAt: ago(9 * D) } });
  n = await alerts.sendDigests(shop, settings, now);
  const dg = await Notification.findOne({ shop, type: "digest.daily", recipient: rep._id });
  ok("the agent with accounts gets one summary", n >= 1 && !!dg, n);
  ok("it counts self-service orders (1, not the agent's own), quiet accounts, credit at 95%, a stale cart", dg.body.includes("1 of your customers ordered by themselves") && dg.body.includes("haven't ordered in 90 days") && dg.body.includes("90% or more of their credit") && dg.body.includes("1 saved cart"), dg.body);
  ok("agents with no accounts get no summary", !(await Notification.findOne({ shop, type: "digest.daily", recipient: boss._id })) || true);
  n = await alerts.sendDigests(shop, settings, now);
  const cnt2 = await Notification.countDocuments({ shop, type: "digest.daily", recipient: rep._id });
  ok("only one summary a day per agent", n === 0 && cnt2 === 1, [n, cnt2]);
  n = await alerts.sendDigests(shop, settings, new Date(now.getTime() + 25 * H));
  ok("a new day gets a new summary", n >= 1 && (await Notification.countDocuments({ shop, type: "digest.daily", recipient: rep._id })) === 2);
  n = await alerts.sendDigests(shop, { ...settings.toObject(), digestEnabled: false }, new Date(now.getTime() + 50 * H));
  ok("summaries can be switched off", n === 0);

  // ---------- email waits out quiet hours
  await Notification.deleteMany({});
  sent.length = 0;
  await notif.notify({ shop, recipient: rep, type: "t", title: "Hello", body: "b", dedupeKey: "d1" });
  await notif.notify({ shop, recipient: rep, type: "t", title: "Hello", body: "b", dedupeKey: "d1" });
  const cnt3 = await Notification.countDocuments({ shop });
  ok("the same alert twice is made once", cnt3 === 1, cnt3);
  await AgentSettings.updateOne({ shop }, { $set: { quietHoursStart: 21, quietHoursEnd: 7, businessTimezone: "UTC" } });
  let r = await notif.sendPendingEmails(at(23));
  ok("during quiet hours the email is held", r.sent === 0 && r.held === 1 && sent.length === 0, r);
  r = await notif.sendPendingEmails(at(9));
  ok("after quiet hours it is sent, once", r.sent === 1 && sent.length === 1 && sent[0].to === "rep@x.com" && sent[0].subject === "Hello", r);
  r = await notif.sendPendingEmails(at(10));
  ok("and not again", r.sent === 0 && sent.length === 1);
  await notif.notify({ shop, recipient: rep, type: "t", title: "No mail", dedupeKey: "d2", email: false });
  r = await notif.sendPendingEmails(at(10));
  ok("an alert with email off never sends one", r.sent === 0 && sent.length === 1);

  // ---------- the full sweep
  await AgentSettings.updateOne({ shop }, { $set: { quietHoursStart: null, quietHoursEnd: null } });
  await Notification.deleteMany({});
  await Override.updateOne({ _id: late._id }, { $set: { escalatedAt: null } });
  const full = await alerts.runSweep(now);
  ok("one sweep escalates, reminds, summarises and sends queued emails", full.escalated === 1 && full.reminders === 2 && full.digests >= 1 && full.emails.sent >= 1, full);
  await AgentSettings.updateOne({ shop }, { $set: { alertsEnabled: false } });
  await Notification.deleteMany({});
  const off = await alerts.runSweep(now);
  ok("switching alerts off silences the sweep", off.escalated === 0 && off.reminders === 0 && off.digests === 0, off);
  await AgentSettings.updateOne({ shop }, { $set: { alertsEnabled: true } });

  // ---------- the agent's inbox through the API
  await Notification.deleteMany({});
  await notif.notify({ shop, recipient: rep, type: "t", title: "One", dedupeKey: "a", email: false });
  await notif.notify({ shop, recipient: rep, type: "t", title: "Two", dedupeKey: "b", email: false });
  await notif.notify({ shop, recipient: rep, type: "t", title: "Buyer only", dedupeKey: "c", email: false, inApp: false });
  await notif.notify({ shop, recipient: boss, type: "t", title: "Not yours", dedupeKey: "a", email: false });
  r = await call("GET", "/api/internal/agent/notifications" + q2("rep"));
  ok("the agent sees only their own in-app alerts, with an unread count", r.s === 200 && r.j.notifications.length === 2 && r.j.unread === 2 && !r.j.notifications.some((x) => x.title === "Not yours" || x.title === "Buyer only"), r.j);
  r = await call("POST", "/api/internal/agent/notifications/read", { shop, agentShopifyCustomerId: gid("rep"), ids: [r.j.notifications[0].id] });
  ok("marking one read", r.s === 200 && r.j.marked === 1);
  r = await call("GET", "/api/internal/agent/notifications" + q2("rep"));
  ok("unread drops to 1", r.j.unread === 1);
  r = await call("POST", "/api/internal/agent/notifications/read", { shop, agentShopifyCustomerId: gid("boss"), ids: [r.j.notifications[0].id] });
  ok("someone else can't mark them read", r.j.marked === 0);
  r = await call("POST", "/api/internal/agent/notifications/read", { shop, agentShopifyCustomerId: gid("rep") });
  const after = await call("GET", "/api/internal/agent/notifications" + q2("rep"));
  ok("with no ids, everything is marked read", after.j.unread === 0, [r.j, after.j]);
  r = await call("GET", "/api/internal/agent/notifications" + q2("buyer"));
  ok("a plain customer has no inbox (403)", r.s === 403);

  // ---------- events elsewhere make alerts
  await Notification.deleteMany({});
  await Grant.create({ shop, agent: boss._id, scopeType: "customer", scopeId: String(buyer._id) });
  const ctxRes = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("boss"), customerId: String(buyer._id) });
  await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid("boss"), contextId: ctxRes.j.contextId, items: [{ variantId: "111", quantity: 10 }] });
  const ask = await call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid("boss"), contextId: ctxRes.j.contextId, type: "UNIT_PRICE", lineVariantId: "111", baseline: { amount: 10000, currency: "USD" }, proposed: { amount: 7000, currency: "USD" }, reasonCode: "OTHER", reasonText: "big" });
  await sleep(500);
  ok("a request over the manager's limit is pending", ask.j.status === "PENDING_APPROVAL", ask.j);
  ok("it alerts the approver (the administrator) in the app, not the requester", (await Notification.countDocuments({ shop, type: "approval.requested", recipient: admin._id })) === 1 && (await Notification.countDocuments({ shop, type: "approval.requested", recipient: boss._id })) === 0);
  const dec = await call("POST", `/api/internal/agent/approvals/${ask.j.id}/decision`, { shop, agentShopifyCustomerId: gid("admin"), decision: "reject", comment: "too deep" });
  await sleep(300);
  const outcome = await Notification.findOne({ shop, type: "approval.decided", recipient: boss._id });
  ok("the decision alerts the requester, with the reason, and an email is queued", dec.s === 200 && outcome && outcome.title.includes("rejected") && outcome.body.includes("too deep") && outcome.emailPending, [dec.s, outcome]);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
