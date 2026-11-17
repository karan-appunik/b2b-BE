// Phase 4: CRM and commission feeds. Read-only inputs for other systems; they
// never work out a commission and never treat an agent on an order as an
// entitlement (spec §10.3).
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
const QuoteVersion = R("src/models/quoteVersion.model");
const Override = R("src/models/overrideRequest.model");
const Audit = R("src/models/auditEvent.model");
const User = R("src/models/user.model");
const { agentPseudonym } = R("src/services/pseudonym.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_feeds");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s") };
  const call = async (p, headers = AH) => {
    const r = await fetch(base + p, { headers });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    return { s: r.status, j, text, type: r.headers.get("content-type") || "", disp: r.headers.get("content-disposition") || "" };
  };
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });

  const rep = await mk("Rita Rep", { role: "sales_agent", territory: "West" });
  const rep2 = await mk("Sam Seller", { role: "sales_agent" });
  const acme = await mk("acme", { company: "Acme Co", accountCode: "AC-1", territory: "West", legalEntity: "Acme LLC" });
  const beta = await mk("beta", { company: "Beta Co" });
  const merged = await mk("merged", { mergedInto: acme._id });
  const erased = await mk("erased", { erasedAt: new Date() });
  await Grant.create({ shop, agent: rep._id, scopeType: "customer", scopeId: String(acme._id) });

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const mkOv = (type, base, prop, status, qty) => Override.create({
    shop, agent: rep._id, customer: acme._id, type, status, permission: "price.override",
    baseline: { amount: base, currency: "USD" }, proposed: { amount: prop, currency: "USD" },
    reasonCode: "OTHER", reasonText: "x", snapshot: qty ? { quantity: qty } : undefined,
  });
  const unit = await mkOv("UNIT_PRICE", 4000, 3600, "APPROVED", 10);       // 400 * 10 = 4000
  const disc = await mkOv("ORDER_DISCOUNT", 50000, 47500, "AUTO_APPROVED"); // 2500
  const pending = await mkOv("ORDER_DISCOUNT", 50000, 40000, "PENDING_APPROVAL");
  const rejected = await mkOv("ORDER_DISCOUNT", 50000, 30000, "REJECTED");

  await Order.create({ shop, shopifyOrderId: "1", name: "#1001", orderedAt: new Date(now - 2 * day), totalPrice: 1234.5, currency: "USD", shopifyCustomerId: acme.shopifyCustomerId, source: "sales_agent", placedByAgent: { agent: rep._id, overrides: [unit._id, disc._id, pending._id, rejected._id], quote: new mongoose.Types.ObjectId() }, financialStatus: "PAID" });
  await Order.create({ shop, shopifyOrderId: "2", name: "=HYPERLINK(\"x\")", orderedAt: new Date(now - 3 * day), totalPrice: 50, currency: "USD", shopifyCustomerId: acme.shopifyCustomerId, source: "sales_agent", placedByAgent: { agent: rep2._id, overrides: [] } });
  await Order.create({ shop, shopifyOrderId: "3", name: "#1003", orderedAt: new Date(now - 1 * day), totalPrice: 999, currency: "USD", shopifyCustomerId: beta.shopifyCustomerId });
  await Order.create({ shop, shopifyOrderId: "4", name: "#1004", orderedAt: new Date(now - 90 * day), totalPrice: 70, currency: "USD", source: "sales_agent", placedByAgent: { agent: rep._id } });

  const mkQuote = async (number, status, subtotal, extra = {}) => {
    const q = await Quote.create({ shop, number, customer: acme._id, ownerAgent: rep._id, status, currentVersion: 2, ...extra });
    await QuoteVersion.create({ shop, quote: q._id, version: 1, currency: "USD", totals: { subtotal: 1 }, items: [{ variantId: "1", quantity: 1, baselineUnit: 1, unitPrice: 1, lineTotal: 1 }] });
    await QuoteVersion.create({ shop, quote: q._id, version: 2, currency: "USD", totals: { subtotal }, items: [{ variantId: "1", quantity: 1, baselineUnit: subtotal, unitPrice: subtotal, lineTotal: subtotal }] });
    return q;
  };
  await mkQuote("Q-0001", "SENT", 56000);
  await mkQuote("Q-0002", "ACCEPTED", 12000);
  await mkQuote("Q-0003", "DECLINED", 9900);
  await mkQuote("Q-0004", "CHANGES_REQUESTED", 100);
  await mkQuote("Q-0005", "DRAFT", 100);

  // ---- who may use them
  let r = await call("/api/integrations/commission-feed", {});
  ok("the feeds need a signed-in merchant (401)", r.s === 401, r);
  for (const p of ["/api/integrations/crm/accounts", "/api/integrations/crm/quotes"]) {
    r = await call(p, {});
    ok(p + " needs a signed-in merchant (401)", r.s === 401, r);
  }

  // ---- commission input
  r = await call("/api/integrations/commission-feed");
  ok("only orders an agent placed are listed (3 in the last 30 days: 2 agent orders)", r.s === 200 && r.j.rows.length === 2 && r.j.rows.every((x) => x.source === "assisted"), r.j);
  const row = r.j.rows.find((x) => x.orderName === "#1001");
  ok("an order shows what was paid as recorded", row && row.orderTotal === 1234.5 && row.currency === "USD" && row.financialStatus === "PAID", row);
  ok("approved price concessions are added up (unit 4000 x 10 + discount 2500 = 65.00)", row && row.approvedPriceConcessions === 65 && row.approvedExceptions === 2, row);
  ok("a waiting or rejected exception is not counted", row && row.approvedExceptions === 2, row);
  ok("net sales are not invented", row && row.netSales === null, row);
  ok("it never says anyone is entitled to commission", r.j.rows.every((x) => x.commissionEntitlement === "not_determined"), r.j.rows);
  ok("and says so in the note", /not a commission entitlement/i.test(r.j.note), r.j.note);
  ok("an order that came from a quote says so", row.fromQuote === true && r.j.rows.find((x) => x.orderName !== "#1001").fromQuote === false, r.j.rows);
  ok("the agent is a code, not a name, unless asked", row.agentCode === agentPseudonym(shop, rep._id) && row.agentName === null && !JSON.stringify(r.j).includes("Rita"), row);
  ok("the territory is there for grouping", row.territory === "West", row);
  r = await call("/api/integrations/commission-feed?names=true");
  ok("names can be asked for", r.j.rows.find((x) => x.orderName === "#1001").agentName === "Rita Rep", r.j.rows);
  r = await call("/api/integrations/commission-feed?from=" + new Date(now - 120 * day).toISOString() + "&to=" + new Date(now).toISOString());
  ok("a longer period brings in older orders", r.j.rows.length === 3, r.j.rows.length);
  r = await call("/api/integrations/commission-feed?from=" + new Date(now - 4 * day).toISOString() + "&to=" + new Date(now - 2.5 * day).toISOString());
  ok("a period narrows it", r.j.rows.length === 1 && r.j.rows[0].orderTotal === 50, r.j.rows);
  r = await call("/api/integrations/commission-feed?from=nonsense");
  ok("a bad date is a 400", r.s === 400 && r.j.code === "INVALID_PERIOD", r);
  r = await call("/api/integrations/commission-feed?from=2020-01-01&to=2023-01-01");
  ok("more than a year at once is refused (400)", r.s === 400, r);

  r = await call("/api/integrations/commission-feed?format=csv");
  const lines = r.text.trim().split("\n");
  ok("a CSV is offered as a download", r.s === 200 && /text\/csv/.test(r.type) && /commission-input-.*\.csv/.test(r.disp), r);
  ok("it has a header and a row per order", lines[0].startsWith("orderName,shopifyOrderId,orderedAt") && lines.length === 3, lines);
  ok("a cell that looks like a formula is defused", r.text.includes("'=HYPERLINK") && !/(^|,)=HYPERLINK/m.test(r.text), r.text);

  // ---- CRM quotes
  r = await call("/api/integrations/crm/quotes");
  const by = Object.fromEntries(r.j.rows.map((x) => [x.quoteNumber, x]));
  ok("every quote is a row with its latest version's amount", r.j.rows.length === 5 && by["Q-0001"].amount === 560 && by["Q-0001"].version === 2, r.j.rows);
  ok("stages follow the quote's own state", by["Q-0001"].stage === "proposal" && by["Q-0002"].stage === "won" && by["Q-0003"].stage === "lost" && by["Q-0004"].stage === "negotiation" && by["Q-0005"].stage === "prospecting", Object.values(by).map((x) => x.stage));
  ok("the note says this is not a pipeline", /not a sales pipeline/i.test(r.j.note), r.j.note);
  ok("quote owners are codes by default", by["Q-0001"].agentCode === agentPseudonym(shop, rep._id) && by["Q-0001"].agentName === null, by["Q-0001"]);
  ok("it names the customer's company", by["Q-0001"].customerCompany === "Acme Co", by["Q-0001"]);

  // ---- CRM accounts
  r = await call("/api/integrations/crm/accounts");
  const accounts = r.j.rows;
  ok("agents, merged and erased accounts are not listed", accounts.length === 2 && !accounts.some((a) => a.customerId === String(merged._id) || a.customerId === String(erased._id) || a.customerId === String(rep._id)), accounts.map((a) => a.company || a.name));
  const a1 = accounts.find((a) => a.customerId === String(acme._id));
  ok("an account carries its code, territory, entity and open quotes", a1.accountCode === "AC-1" && a1.territory === "West" && a1.legalEntity === "Acme LLC" && a1.openQuotes === 3 && a1.lastOrderAt, a1);
  ok("the assigned agent is a code", a1.assignedAgents.length === 1 && a1.assignedAgents[0].agentCode === agentPseudonym(shop, rep._id) && a1.assignedAgents[0].agentName === null, a1.assignedAgents);
  r = await call("/api/integrations/crm/accounts?names=true&format=csv");
  ok("accounts also come as CSV", r.s === 200 && /text\/csv/.test(r.type) && r.text.split("\n")[0].includes("customerId"), r.text.slice(0, 120));

  // ---- audited, and no secrets
  const aud = await Audit.find({ action: { $in: ["commission_feed.exported", "crm_feed.exported"] } }).lean();
  ok("every export is audited with its row count", aud.length >= 6 && aud.some((a) => a.action === "commission_feed.exported" && a.metadata.rows === 2), aud.map((a) => [a.action, a.metadata.rows]));
  const all = (await call("/api/integrations/commission-feed?names=true&format=csv")).text + (await call("/api/integrations/crm/quotes?names=true&format=csv")).text;
  ok("nothing secret is in the exports", !/password|token|secret|mfa/i.test(all), all.slice(0, 200));

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
