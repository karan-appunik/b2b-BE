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
const Ctx = R("src/models/contextSession.model");
const Audit = R("src/models/auditEvent.model");
const Order = R("src/models/order.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_s3");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const call = async (m, p, body, headers = IH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json() };
  };
  const user = await User.create({ name: "M", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: "gid://shopify/Customer/" + name, ...extra });
  const agent = await mkc("agent", { role: "sales_agent" });
  await mkc("agent2", { role: "sales_agent" });
  const a = await mkc("custA");
  const b = await mkc("custB");
  const aid = "gid://shopify/Customer/agent";

  let r = await call("POST", `/api/agents/${agent._id}/scope-grants`, { scopeType: "customer", scopeId: String(a._id) }, AH);
  ok("grant created via API", r.s === 201, r);
  const grantId = r.j._id;
  ok("grant audit row (merchant_user actor)", !!(await Audit.findOne({ action: "grant.created", actor: user._id })));

  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(b._id) });
  ok("entry to ungranted customer denied", r.s === 403, r);
  const denied = await Audit.findOne({ action: "context.denied" });
  ok("denied attempt audited w/ NO_GRANT + customer", denied && denied.outcome === "denied" && denied.reasonCode === "NO_GRANT" && String(denied.customer) === String(b._id), denied);
  await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: "gid://shopify/Customer/nobody", customerId: String(b._id) });
  ok("non-agent entry audited NOT_AN_AGENT", !!(await Audit.findOne({ action: "context.denied", reasonCode: "NOT_AN_AGENT" })));

  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(a._id) });
  const ctxId = r.j.contextId;
  const ent = await Audit.findOne({ action: "context.entered" });
  ok("entry audited with source + context", ent && ent.metadata.assignmentSource === "customer" && String(ent.contextId) === ctxId, ent);

  const order = (id, extra = {}) => ({ shopifyOrderId: "gid://shopify/Order/" + id, name: "#" + id, orderedAt: new Date().toISOString(), totalPrice: 100, currency: "USD", shopifyCustomerId: a.shopifyCustomerId, ...extra });
  const claim = (contextId, agentGid = aid) => ({ placedByAgent: { agentShopifyCustomerId: agentGid, contextId } });
  await call("POST", "/api/internal/orders/sync", { shop, orders: [order(1, claim(ctxId))] });
  let o = await Order.findOne({ shopifyOrderId: "gid://shopify/Order/1" });
  ok("valid claim -> order attributed", o.source === "sales_agent" && String(o.placedByAgent.agent) === String(agent._id) && String(o.placedByAgent.context) === ctxId, o);
  ok("order.attributed audited once", (await Audit.countDocuments({ action: "order.attributed" })) === 1);

  await call("POST", "/api/internal/orders/sync", { shop, orders: [order(1, { ...claim(ctxId), financialStatus: "paid" })] });
  ok("resync does not duplicate audit", (await Audit.countDocuments({ action: "order.attributed" })) === 1);
  await call("POST", "/api/internal/orders/sync", { shop, orders: [order(1, { financialStatus: "paid" })] });
  o = await Order.findOne({ shopifyOrderId: "gid://shopify/Order/1" });
  ok("later sync without claim keeps attribution", o.source === "sales_agent" && o.financialStatus === "paid", o);

  await call("POST", "/api/internal/orders/sync", { shop, orders: [order(2, claim(String(new mongoose.Types.ObjectId())))] });
  o = await Order.findOne({ shopifyOrderId: "gid://shopify/Order/2" });
  ok("unknown context -> not attributed, order still stored", o && !o.source && !(o.placedByAgent && o.placedByAgent.agent), o);
  await call("POST", "/api/internal/orders/sync", { shop, orders: [order(3, claim(ctxId, "gid://shopify/Customer/agent2"))] });
  o = await Order.findOne({ shopifyOrderId: "gid://shopify/Order/3" });
  ok("context of another agent -> rejected", !o.source, o);
  await call("POST", "/api/internal/orders/sync", { shop, orders: [order(4, { ...claim(ctxId), shopifyCustomerId: b.shopifyCustomerId })] });
  o = await Order.findOne({ shopifyOrderId: "gid://shopify/Order/4" });
  ok("order for different customer than context -> rejected", !o.source, o);
  ok("3 rejections audited", (await Audit.countDocuments({ action: "order.attribution_rejected" })) === 3);
  await call("POST", "/api/internal/orders/sync", { shop, orders: [order(5)] });
  o = await Order.findOne({ shopifyOrderId: "gid://shopify/Order/5" });
  ok("normal order untouched", !o.source && !(o.placedByAgent && o.placedByAgent.agent));

  await call("DELETE", `/api/internal/agent/contexts/${ctxId}?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(aid)}`);
  ok("exit audited", !!(await Audit.findOne({ action: "context.exited", reasonCode: "EXIT" })));
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(a._id) });
  const ctx2 = r.j.contextId;
  r = await call("DELETE", `/api/agents/${agent._id}/scope-grants/${grantId}`, null, AH);
  ok("grant deleted", r.s === 200, r);
  r = await call("GET", `/api/internal/agent/contexts/${ctx2}/validate?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(aid)}`);
  ok("context dies after grant removal", r.s === 401, r);
  ok("ACCESS_LOST audited", !!(await Audit.findOne({ action: "context.revoked", reasonCode: "ACCESS_LOST" })));

  const any = await Audit.findOne();
  let blocked = 0;
  const attempts = [
    () => Audit.updateOne({ _id: any._id }, { action: "x" }),
    () => Audit.deleteMany({}),
    () => Audit.findOneAndDelete({ _id: any._id }),
    () => { any.action = "hacked"; return any.save(); },
  ];
  for (const fn of attempts) {
    try { await fn(); } catch (e) { if (/append-only/.test(e.message)) blocked++; }
  }
  ok("update/delete/save-change all blocked", blocked === 4, blocked);
  const still = await Audit.findById(any._id);
  ok("audit rows intact", still && still.action !== "x" && still.action !== "hacked");

  r = await call("GET", `/api/audit?agentId=${agent._id}&limit=100`, null, AH);
  ok("audit API filters by agent", r.s === 200 && r.j.length > 0 && r.j.every((e) => String(e.actor) === String(agent._id)), r.j.length);
  r = await call("GET", "/api/audit?action=context.denied", null, AH);
  ok("audit API filters by action", r.j.length === 2 && r.j.every((e) => e.action === "context.denied"), r.j.length);
  r = await call("GET", "/api/audit?from=garbage", null, AH);
  ok("bad date -> 400", r.s === 400, r);
  r = await call("GET", "/api/audit", null, IH);
  ok("internal key alone cannot read audit", r.s === 401, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
