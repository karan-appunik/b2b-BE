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
const Ctx = R("src/models/contextSession.model");
const Notification = R("src/models/notification.model");
const Quote = R("src/models/quote.model");
const QuoteVersion = R("src/models/quoteVersion.model");
const AgentCart = R("src/models/agentCart.model");
const ShoppingList = R("src/models/shoppingList.model");
const Audit = R("src/models/auditEvent.model");
const Order = R("src/models/order.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
const old = (days) => new Date(Date.now() - days * 86400e3);
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_privacy");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const user = await User.create({ name: "M", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const adm = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: AH, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => null) }; };
  await adm("GET", "/api/roles");
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });
  const agent = await mk("agent", { role: "sales_agent" });
  const a = await mk("alice", { phone: "+15550102000", taxId: "TX1", company: "Alice Co", internalNotes: "pays late", addresses: [{ firstName: "A", lastName: "B", address1: "1 St", city: "X", zip: "1", country: "US" }] });
  const b = await mk("bob");

  const seed = async () => {
    await Promise.all([Ctx.deleteMany({}), Notification.deleteMany({}), Quote.deleteMany({}), QuoteVersion.deleteMany({}), AgentCart.deleteMany({}), ShoppingList.deleteMany({})]);
    for (const c of [a, b]) {
      await Ctx.collection.insertOne({ shop, agent: agent._id, customer: c._id, issuedAt: old(500), expiresAt: old(499), revokedAt: old(499) });
      await Ctx.collection.insertOne({ shop, agent: agent._id, customer: c._id, issuedAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
      await Notification.collection.insertOne({ shop, recipient: c._id, type: "x", title: "old", dedupeKey: "o" + Math.random(), createdAt: old(400), updatedAt: old(400) });
      await Notification.collection.insertOne({ shop, recipient: c._id, type: "x", title: "new", dedupeKey: "n" + Math.random(), createdAt: new Date(), updatedAt: new Date() });
      const q = await Quote.collection.insertOne({ shop, customer: c._id, number: "Q-" + c.name, status: "EXPIRED", createdAt: old(900), updatedAt: old(800) });
      await QuoteVersion.collection.insertOne({ quote: q.insertedId, version: 1 });
      await Quote.collection.insertOne({ shop, customer: c._id, number: "Q2-" + c.name, status: "SENT", createdAt: old(900), updatedAt: old(800) });
      await AgentCart.collection.insertOne({ shop, agent: agent._id, customer: c._id, items: [], createdAt: old(300), updatedAt: old(300) });
    }
  };

  // ---- schedule
  let r = await adm("PUT", "/api/agent-settings", { retention: { contextsDays: 10 } });
  ok("a schedule under 30 days is refused", r.s === 400, r);
  r = await adm("GET", "/api/privacy/retention");
  ok("default schedule is shown, nothing runs by itself", r.s === 200 && r.j.policy.autoPurge === false && r.j.policy.contextsDays === 365 && r.j.policy.closedQuotesDays === 730, r.j);

  await seed();
  r = await adm("GET", "/api/privacy/retention");
  ok("preview counts what is old enough, deletes nothing", r.j.preview.contexts === 2 && r.j.preview.notifications === 2 && r.j.preview.closedQuotes === 2 && r.j.preview.inactiveCarts === 2 && (await Notification.countDocuments()) === 4, r.j.preview);

  // ---- legal hold
  r = await adm("POST", "/api/privacy/holds", { scope: "customer", customerId: String(a._id) });
  ok("a hold needs a reason", r.s === 400, r);
  r = await adm("POST", "/api/privacy/holds", { scope: "customer", customerId: String(a._id), reason: "Dispute with Alice Co" });
  ok("a hold on a customer is placed", r.s === 201, r);
  const holdA = r.j;
  r = await adm("POST", "/api/privacy/retention/run", {});
  ok("the schedule skips the held customer, clears the other", r.s === 200 && r.j.contexts === 1 && r.j.notifications === 1 && r.j.closedQuotes === 1 && r.j.inactiveCarts === 1 && r.j.heldCustomers === 1, r.j);
  ok("held customer's old records are all still there", (await Notification.countDocuments({ recipient: a._id })) === 2 && (await Quote.countDocuments({ customer: a._id })) === 2 && (await QuoteVersion.countDocuments()) === 1, null);
  ok("the other customer's old records are gone, the new and open ones stay", (await Notification.countDocuments({ recipient: b._id })) === 1 && (await Quote.countDocuments({ customer: b._id })) === 1 && (await Quote.findOne({ customer: b._id })).status === "SENT" && (await Ctx.countDocuments({ customer: b._id })) === 1, null);
  ok("the run is audited with counts only", !!(await Audit.findOne({ shop, action: "retention.run", "metadata.contexts": 1 })));

  r = await adm("POST", "/api/privacy/holds", { scope: "shop", reason: "Investigation" });
  const holdShop = r.j;
  await seed();
  r = await adm("POST", "/api/privacy/retention/run", {});
  ok("a shop-wide hold stops everything", r.j.skippedBecause === "SHOP_HOLD" && (await Notification.countDocuments()) === 4, r.j);
  r = await adm("POST", `/api/privacy/holds/${holdShop._id}/release`);
  ok("a hold can be released", r.s === 200 && !!r.j.releasedAt, r);
  r = await adm("GET", "/api/privacy/holds");
  ok("released holds stay on record", r.j.holds.length === 2 && r.j.holds.filter((h) => h.releasedAt).length === 1, r.j);

  // ---- data-subject requests
  r = await adm("POST", "/api/privacy/requests", { customerId: String(a._id), type: "access" });
  ok("an access request returns what we hold (even under a hold)", r.s === 201 && r.j.data.profile.phone === "+15550102000" && r.j.data.profile.taxId === "TX1" && Array.isArray(r.j.data.quotes) && !r.j.data.profile.mfa && r.j.data.profile.addresses.length === 1, r.j);
  r = await adm("POST", "/api/privacy/requests", { customerId: String(a._id), type: "erasure" });
  ok("erasure is refused while a hold stands", r.j.request.status === "refused" && r.j.request.refusedReason === "LEGAL_HOLD", r.j);
  ok("...and nothing was removed", (await Customer.findById(a._id)).phone === "+15550102000");
  r = await adm("POST", "/api/privacy/requests", { customerId: String(agent._id), type: "erasure" });
  ok("an agent account can not be erased this way", r.j.request.refusedReason === "AGENT_ACCOUNT", r.j);

  await Order.collection.insertOne({ shop, shopifyOrderId: "o1", name: "#1", shopifyCustomerId: gid("alice"), customerName: "Alice", totalPrice: 10, currency: "USD" });
  await adm("POST", `/api/privacy/holds/${holdA._id}/release`);
  await seed();
  await ShoppingList.collection.insertOne({ shop, customer: a._id, name: "Weekly", items: [] });
  r = await adm("POST", "/api/privacy/requests", { customerId: String(a._id), type: "erasure" });
  ok("after the hold is released, erasure completes", r.s === 201 && r.j.request.status === "completed" && /Shopify/.test(r.j.shopifyNote), r.j);
  const erased = await Customer.findById(a._id);
  ok("profile data is removed", erased.name === "Erased customer" && /erased\.invalid$/.test(erased.email) && !erased.phone && !erased.taxId && !erased.company && !erased.internalNotes && erased.addresses.length === 0 && !!erased.erasedAt, erased);
  ok("they can not be ordered for any more", erased.accountStatus === "suspended");
  ok("their notifications, carts and lists are deleted", (await Notification.countDocuments({ recipient: a._id })) === 0 && (await AgentCart.countDocuments({ customer: a._id })) === 0 && (await ShoppingList.countDocuments({ customer: a._id })) === 0, null);
  ok("quotes and the audit trail are kept", (await Quote.countDocuments({ customer: a._id })) === 2 && (await Audit.countDocuments({ shop, action: "data_subject_request.completed" })) === 2, null);
  ok("their order is untouched", (await Order.countDocuments({ shopifyCustomerId: gid("alice") })) === 1);
  r = await adm("POST", "/api/privacy/requests", { customerId: String(a._id), type: "erasure" });
  ok("asking again says it is already done", r.j.request.refusedReason === "ALREADY_ERASED", r.j);
  r = await adm("GET", "/api/privacy/requests");
  ok("requests are listed", r.j.requests.length >= 5, r.j.requests.length);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  process.exit(fail ? 1 : 0);
})();
