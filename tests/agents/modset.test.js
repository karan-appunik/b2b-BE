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
const Grant = R("src/models/agentScopeGrant.model");
const Ctx = R("src/models/contextSession.model");
const Notification = R("src/models/notification.model");
const Outbox = R("src/models/outboxEvent.model");
const { notify } = R("src/services/notification.service");
const { emitEvent } = R("src/services/outbox.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_modset");
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
  const agent = await mk("agent", { role: "sales_agent", agentProfile: { locale: "fr-FR" } });
  const c1 = await mk("c1", { territory: "North" });
  await Grant.create({ shop, agent: agent._id, scopeType: "customer", scopeId: String(c1._id) });
  const enter = () => int("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("agent"), customerId: String(c1._id) });
  const valid = (id) => int("GET", `/api/internal/agent/contexts/${id}/validate?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("agent"))}`);

  // ---- session lifetime
  let r = await enter();
  let ctx = await Ctx.findOne({ customer: c1._id });
  ok("default lifetime is 8 hours", Math.round((ctx.expiresAt - ctx.issuedAt) / 60000) === 480, ctx.expiresAt);
  r = await adm("PUT", "/api/agent-settings", { contextAbsoluteMinutes: 60, contextIdleMinutes: 10 });
  ok("admin sets 60 minutes absolute and 10 idle", r.s === 200 && r.j.contextAbsoluteMinutes === 60 && r.j.contextIdleMinutes === 10, r);
  r = await adm("PUT", "/api/agent-settings", { contextAbsoluteMinutes: 5 });
  ok("a lifetime under 15 minutes is refused", r.s === 400, r);
  r = await adm("PUT", "/api/agent-settings", { contextIdleMinutes: 2 });
  ok("an idle limit under 5 minutes is refused", r.s === 400, r);
  await enter();
  ctx = await Ctx.findOne({ customer: c1._id }).sort({ issuedAt: -1 });
  ok("a new context lives 60 minutes", Math.round((ctx.expiresAt - ctx.issuedAt) / 60000) === 60, ctx);
  r = await valid(ctx._id);
  ok("it is usable while active", r.j && r.j.valid !== false && r.s < 300, r);
  await Ctx.updateOne({ _id: ctx._id }, { $set: { lastActivityAt: new Date(Date.now() - 11 * 60000) } });
  r = await valid(ctx._id);
  ok("idle for 11 minutes: it has ended", r.s >= 400 || (r.j && r.j.valid === false), r);
  r = await enter();
  ok("the agent can start again", r.s < 300, r);
  r = await adm("PUT", "/api/agent-settings", { contextIdleMinutes: "" });
  ok("clearing the idle limit works", r.s === 200 && r.j.contextIdleMinutes === null, r);

  // ---- notification templates
  r = await adm("PUT", "/api/agent-settings", { notificationTemplates: { "quote.expiring": { title: "Heads up: {title}", body: "Hi {recipient}, {body}" }, "quote.expiring|fr": { title: "Attention : {title}", body: "" }, "bad key!": { title: "x" } } });
  ok("a bad type name is refused", r.s === 400, r);
  r = await adm("PUT", "/api/agent-settings", { notificationTemplates: { "quote.expiring": { title: "Heads up: {title}", body: "Hi {recipient}, {body}" }, "quote.expiring|fr": { title: "Attention : {title}", body: "" } } });
  ok("templates save", r.s === 200, r);
  const en = await mk("english", { role: "sales_agent" });
  await notify({ shop, recipient: en, type: "quote.expiring", title: "Quote Q-1 expires soon", body: "in 3 days", dedupeKey: "a1" });
  let n = await Notification.findOne({ dedupeKey: "a1" });
  ok("the merchant's wording is used, with the placeholders filled", n.title === "Heads up: Quote Q-1 expires soon" && n.body === "Hi english, in 3 days", n);
  await notify({ shop, recipient: agent, type: "quote.expiring", title: "Quote Q-2 expires soon", body: "tomorrow", dedupeKey: "a2" });
  n = await Notification.findOne({ dedupeKey: "a2" });
  ok("a French-speaking agent gets the French title, and the usual body when none is given", n.title === "Attention : Quote Q-2 expires soon" && n.body === "tomorrow", n);
  await notify({ shop, recipient: en, type: "digest.daily", title: "Your daily summary", body: "x", dedupeKey: "a3" });
  n = await Notification.findOne({ dedupeKey: "a3" });
  ok("a type without a template is left as it was", n.title === "Your daily summary", n);

  // ---- integration mappings
  r = await adm("PUT", "/api/agent-settings", { integrationMappings: [{ kind: "colour", from: "a", to: "b" }] });
  ok("a mapping of an unknown kind is refused", r.s === 400, r);
  r = await adm("PUT", "/api/agent-settings", { integrationMappings: [{ kind: "legalEntity", from: "LE_IN", to: "ERP-IN-01" }, { kind: "channel", from: "b2b_web", to: "WEB" }, { kind: "territory", from: "North", to: "N1" }] });
  ok("mappings save", r.s === 200 && r.j.integrationMappings.length === 3, r);
  await emitEvent(shop, "order.created", { order_id: "1", legal_entity_id: "LE_IN", channel_id: "b2b_web", territory: "North" });
  let ev = await Outbox.findOne({ "payload.order_id": "1" });
  ok("an event carries the names the other system uses", ev.payload.external && ev.payload.external.legal_entity === "ERP-IN-01" && ev.payload.external.channel === "WEB" && ev.payload.external.territory === "N1", ev.payload);
  await emitEvent(shop, "order.created", { order_id: "2", legal_entity_id: "LE_UNKNOWN" });
  ev = await Outbox.findOne({ "payload.order_id": "2" });
  ok("an entity without a mapping adds nothing", !ev.payload.external, ev.payload);
  await emitEvent(shop, "context.entered", { agent_id: "x" });
  ev = await Outbox.findOne({ "payload.agent_id": "x" });
  ok("events without those fields are untouched", !ev.payload.external, ev.payload);


  // ---- looking is not working: a passive status check must not keep a session alive
  await adm("PUT", "/api/agent-settings", { contextAbsoluteMinutes: 60, contextIdleMinutes: 10 });
  await enter();
  let live = await Ctx.findOne({ customer: c1._id, revokedAt: null }).sort({ issuedAt: -1 });
  const longAgo = new Date(Date.now() - 4 * 60000);
  await Ctx.updateOne({ _id: live._id }, { $set: { lastActivityAt: longAgo } });
  r = await int("GET", `/api/internal/agent/contexts/current?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("agent"))}`);
  live = await Ctx.findById(live._id);
  ok("asking 'is my session still on?' works", r.s < 300, r);
  ok("...but does not count as activity", Math.abs(new Date(live.lastActivityAt).getTime() - longAgo.getTime()) < 1000, live.lastActivityAt);
  r = await valid(live._id);
  live = await Ctx.findById(live._id);
  ok("a real action does count as activity", new Date(live.lastActivityAt).getTime() > longAgo.getTime() + 60000, live.lastActivityAt);
  await Ctx.updateOne({ _id: live._id }, { $set: { lastActivityAt: new Date(Date.now() - 11 * 60000) } });
  r = await int("GET", `/api/internal/agent/contexts/current?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("agent"))}`);
  ok("checking again after the idle limit finds it ended, however often it was looked at", r.s >= 400 || (r.j && (r.j.valid === false || r.j.active === false)), r);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  process.exit(fail ? 1 : 0);
})();
