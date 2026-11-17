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
const Customer = R("src/models/customer.model");
const Grant = R("src/models/agentScopeGrant.model");
const Quote = R("src/models/quote.model");
const QuoteVersion = R("src/models/quoteVersion.model");
const Audit = R("src/models/auditEvent.model");
const Outbox = R("src/models/outboxEvent.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_quote");
  await mongoose.connection.dropDatabase();
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
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: gid(name), ...extra });
  const A = (n, extra = {}) => ({ shop, agentShopifyCustomerId: gid(n), ...extra });
  const q = (n, extra = "") => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}${extra}`;
  const bq = (n, extra = "") => `?shop=${shop}&buyerShopifyCustomerId=${encodeURIComponent(gid(n))}${extra}`;

  await call("GET", "/api/roles", null, AH);
  await call("POST", "/api/roles", { name: "No Quote", permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "cart.create" }, { key: "cart.write" }, { key: "order.submit" }] }, AH);
  await call("POST", "/api/roles", { name: "Quote Only", permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "cart.create" }, { key: "cart.write" }, { key: "quote.create" }] }, AH);

  const rep = await mkc("rep", { role: "sales_agent" });
  const mgr = await mkc("mgr", { role: "sales_manager" });
  const noq = await mkc("noq", { role: "no_quote" });
  const qonly = await mkc("qonly", { role: "quote_only" });
  const custA = await mkc("custA");
  const custB = await mkc("custB");
  for (const a of [rep, mgr, noq, qonly]) await Grant.create({ shop, agent: a._id, scopeType: "customer", scopeId: String(custA._id) });
  const ctx = {};
  for (const n of ["rep", "mgr", "noq", "qonly"]) ctx[n] = (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid(n), customerId: String(custA._id) })).j.contextId;

  const items = (qty = 10, unit = 3600) => [
    { variantId: "111", title: "Sunflower Bracelet", sku: "B-1", quantity: qty, baselineUnit: 4000, unitPrice: unit },
    { variantId: "222", title: "Gold Chain", sku: "C-2", quantity: 2, baselineUnit: 10000, unitPrice: 10000 },
  ];
  const create = (n, over = {}) => call("POST", "/api/internal/agent/quotes", A(n, { contextId: ctx[n], items: items(), currency: "usd", notes: "Thanks for your business", internalNotes: "margin ok", ...over }));

  // ================= creating =================
  let r = await create("rep");
  ok("quote created: Q-0001, DRAFT, version 1", r.s === 201 && r.j.number === "Q-0001" && r.j.status === "DRAFT" && r.j.currentVersion === 1, r);
  ok("totals computed on the server: 10*3600 + 2*10000 = 56000, savings 4000", r.j.totals.subtotal === 56000 && r.j.totals.savings === 4000 && r.j.items[0].lineTotal === 36000, r.j.totals);
  ok("currency upper-cased; terms kept", r.j.currency === "USD" && r.j.terms.notes === "Thanks for your business" && r.j.terms.validDays === 14, r.j.terms);
  const q1 = r.j.id;

  r = await create("rep");
  ok("numbers run on: Q-0002", r.j.number === "Q-0002", r.j.number);
  const q2 = r.j.id;

  r = await create("rep", { items: [] });
  ok("a quote needs items", r.s === 400 && r.j.code === "NO_ITEMS", r);
  r = await create("rep", { items: [{ variantId: "1", quantity: 0, baselineUnit: 1, unitPrice: 1 }] });
  ok("quantity must be a whole number >= 1", r.s === 400 && r.j.code === "INVALID_ITEM", r);
  r = await create("rep", { items: [{ variantId: "1", quantity: 1, baselineUnit: 1.5, unitPrice: 1 }] });
  ok("prices must be whole minor units", r.s === 400 && r.j.code === "INVALID_AMOUNT", r);
  r = await create("rep", { currency: "" });
  ok("a currency is required", r.s === 400, r);
  r = await create("rep", { validDays: 0 });
  ok("validDays out of range refused", r.s === 400 && r.j.code === "INVALID_TERMS", r);
  r = await create("noq");
  ok("a role without quote.create can't quote", r.s === 403 && r.j.code === "PERMISSION_DENIED", r);
  r = await call("POST", "/api/internal/agent/quotes", A("rep", { items: items(), currency: "USD" }));
  ok("no customer context -> 401", r.s === 401, r);
  r = await call("POST", "/api/internal/agent/quotes", A("rep", { contextId: ctx.mgr, items: items(), currency: "USD" }));
  ok("someone else's context -> 401", r.s === 401, r);

  // ================= reading / visibility =================
  r = await call("GET", "/api/internal/agent/quotes" + q("rep"));
  ok("the owner lists their quotes", r.s === 200 && r.j.quotes.length === 2, r);
  r = await call("GET", `/api/internal/agent/quotes/${q1}` + q("qonly"));
  ok("another agent (no approval right) can't open it", r.s === 404, r);
  r = await call("GET", `/api/internal/agent/quotes/${q1}` + q("mgr"));
  ok("a manager who can approve may open it", r.s === 200 && r.j.number === "Q-0001", r);

  // ================= editing a draft =================
  r = await call("PUT", `/api/internal/agent/quotes/${q1}`, A("rep", { notes: "Updated note", validDays: 7, items: items(20, 3500) }));
  ok("a draft is edited in place: version stays 1, totals recomputed", r.s === 200 && r.j.currentVersion === 1 && r.j.totals.subtotal === 20 * 3500 + 20000 && r.j.terms.validDays === 7, r.j);
  r = await call("PUT", `/api/internal/agent/quotes/${q1}`, A("qonly", { notes: "x" }));
  ok("only the owner can edit", r.s === 404, r);

  // ================= sending =================
  const before = sent.length;
  r = await call("POST", `/api/internal/agent/quotes/${q1}/send`, A("rep"));
  await sleep(150);
  ok("sent: SENT, sentAt, expires in 7 days", r.s === 200 && r.j.status === "SENT" && r.j.sentAt && Math.round((new Date(r.j.expiresAt) - new Date(r.j.sentAt)) / 86400000) === 7, r.j);
  ok("version is locked once sent", r.j.locked === true);
  ok("the customer gets an email pointing to My Account", sent.length === before + 1 && sent[before].to === "custa@x.com" && /My Account/.test(sent[before].html) && /Q-0001/.test(sent[before].subject), sent[before]);
  r = await call("PUT", `/api/internal/agent/quotes/${q1}`, A("rep", { notes: "sneaky" }));
  ok("a sent quote can't be edited (immutable)", r.s === 409 && r.j.code === "NOT_EDITABLE", r);
  r = await call("POST", `/api/internal/agent/quotes/${q1}/send`, A("rep"));
  ok("can't send twice", r.s === 409 && r.j.code === "INVALID_TRANSITION", r);

  // ================= the buyer's view =================
  r = await call("GET", "/api/internal/customer/quotes" + bq("custA"));
  ok("the buyer sees the sent quote, not the draft", r.s === 200 && r.j.quotes.length === 1 && r.j.quotes[0].number === "Q-0001", r.j.quotes && r.j.quotes.map((x) => x.number));
  const bv = r.j.quotes[0];
  ok("buyer view hides internal notes, baseline prices, approval state and owner", !("baselineUnit" in bv.items[0]) && !("internalNotes" in bv.terms) && bv.approvalState === undefined && bv.customerId === undefined && bv.terms.notes === "Updated note", bv);
  ok("buyer sees prices and total", bv.items[0].unitPrice === 3500 && bv.totals.subtotal === 90000, bv.totals);
  r = await call("GET", "/api/internal/customer/quotes" + bq("custB"));
  ok("another customer sees nothing", r.j.quotes.length === 0, r);
  r = await call("GET", `/api/internal/customer/quotes/${q1}` + bq("custB"));
  ok("...and can't open it by id", r.s === 404, r);
  r = await call("POST", `/api/internal/customer/quotes/${q1}/respond`, { shop, buyerShopifyCustomerId: gid("custB"), action: "accept" });
  ok("...or answer it", r.s === 404, r);
  r = await call("GET", "/api/internal/customer/quotes" + `?shop=${shop}`);
  ok("no buyer id -> nothing", r.s === 200 && r.j.quotes.length === 0, r);

  // ================= the buyer answers =================
  r = await call("POST", `/api/internal/customer/quotes/${q1}/respond`, { shop, buyerShopifyCustomerId: gid("custA"), action: "changes" });
  ok("asking for changes needs a comment", r.s === 400 && r.j.code === "COMMENT_REQUIRED", r);
  r = await call("POST", `/api/internal/customer/quotes/${q1}/respond`, { shop, buyerShopifyCustomerId: gid("custA"), action: "dance" });
  ok("unknown action refused", r.s === 400, r);
  const mails = sent.length;
  r = await call("POST", `/api/internal/customer/quotes/${q1}/respond`, { shop, buyerShopifyCustomerId: gid("custA"), action: "changes", comment: "Can you do 3400 a piece?" });
  await sleep(150);
  ok("changes requested", r.s === 200 && r.j.status === "CHANGES_REQUESTED", r);
  ok("the agent is emailed what the buyer said", sent.length === mails + 1 && sent[mails].to === "rep@x.com" && /3400/.test(sent[mails].html), sent[mails]);
  r = await call("POST", `/api/internal/customer/quotes/${q1}/respond`, { shop, buyerShopifyCustomerId: gid("custA"), action: "accept" });
  ok("an answered quote can't be answered again", r.s === 409 && r.j.code === "NOT_OPEN", r);

  // ================= revising keeps the old version =================
  const v1Before = await QuoteVersion.findOne({ quote: q1, version: 1 }).lean();
  r = await call("POST", `/api/internal/agent/quotes/${q1}/revise`, A("rep"));
  ok("revise: version 2, back to DRAFT, items carried over", r.s === 200 && r.j.currentVersion === 2 && r.j.status === "DRAFT" && r.j.items.length === 2, r.j);
  r = await call("PUT", `/api/internal/agent/quotes/${q1}`, A("rep", { items: items(20, 3400) }));
  ok("the new draft can be edited", r.s === 200 && r.j.totals.subtotal === 20 * 3400 + 20000, r.j.totals);
  const v1After = await QuoteVersion.findOne({ quote: q1, version: 1 }).lean();
  ok("version 1 is untouched (same items, locked, same total)", JSON.stringify(v1Before.items) === JSON.stringify(v1After.items) && v1After.lockedAt && v1After.totals.subtotal === 90000, v1After.totals);
  r = await call("POST", `/api/internal/agent/quotes/${q1}/revise`, A("rep"));
  ok("a draft can't be 'revised'", r.s === 409, r);
  await call("POST", `/api/internal/agent/quotes/${q1}/send`, A("rep"));
  r = await call("GET", "/api/internal/customer/quotes" + bq("custA"));
  ok("the buyer now sees version 2 at the new price", r.j.quotes[0].currentVersion === 2 && r.j.quotes[0].totals.subtotal === 88000, r.j.quotes[0]);

  // ================= accepting =================
  r = await call("POST", `/api/internal/customer/quotes/${q1}/respond`, { shop, buyerShopifyCustomerId: gid("custA"), action: "accept" });
  ok("accepted: ACCEPTED with acceptedAt", r.s === 200 && r.j.status === "ACCEPTED" && r.j.acceptedAt, r.j);
  const acc = await Quote.findById(q1).lean();
  ok("convertBy is set (14 days)", acc.convertBy && Math.round((acc.convertBy - acc.acceptedAt) / 86400000) === 14, acc.convertBy);
  const hist = r.j.activity.map((a) => a.type).join(",");
  ok("buyer's timeline shows sent -> changes -> sent -> accepted, not internal steps", hist === "sent,changes_requested,sent,accepted", hist);
  ok("responses are audited as the buyer; events queued", !!(await Audit.findOne({ action: "quote.responded", actorType: "buyer" })) && (await Outbox.countDocuments({ type: "sales_agent.quote.responded" })) >= 2);
  ok("quote.sent events queued", (await Outbox.countDocuments({ type: "sales_agent.quote.sent" })) >= 2);

  // ================= converting to an order =================
  r = await call("POST", `/api/internal/agent/quotes/${q1}/converted`, A("qonly", { orderId: "gid://shopify/Order/1" }));
  ok("only the owner can convert", r.s === 404, r);
  const q3 = (await create("noq", { items: items() })).j;
  r = await call("POST", `/api/internal/agent/quotes/${q2}/converted`, A("rep", { orderId: "gid://shopify/Order/1" }));
  ok("a quote that isn't accepted can't be converted", r.s === 409, r);
  r = await call("POST", `/api/internal/agent/quotes/${q1}/converted`, A("rep", {}));
  ok("an order id is required", r.s === 400 && r.j.code === "ORDER_REQUIRED", r);
  r = await call("POST", `/api/internal/agent/quotes/${q1}/converted`, A("rep", { orderId: "gid://shopify/Order/77" }));
  ok("converted with the order recorded", r.s === 200 && r.j.status === "CONVERTED" && r.j.convertedOrderId === "gid://shopify/Order/77", r.j);
  r = await call("POST", `/api/internal/agent/quotes/${q1}/converted`, A("rep", { orderId: "gid://shopify/Order/78" }));
  ok("converting twice -> 409", r.s === 409, r);
  r = await call("GET", "/api/internal/customer/quotes" + bq("custA"));
  ok("the buyer sees it as converted", r.j.quotes.find((x) => x.number === "Q-0001").status === "CONVERTED");

  // ================= declining, expiring =================
  await call("POST", `/api/internal/agent/quotes/${q2}/send`, A("rep"));
  r = await call("POST", `/api/internal/customer/quotes/${q2}/respond`, { shop, buyerShopifyCustomerId: gid("custA"), action: "decline", comment: "Too expensive" });
  ok("declined", r.s === 200 && r.j.status === "DECLINED", r);
  r = await call("POST", `/api/internal/agent/quotes/${q2}/revise`, A("rep"));
  ok("a declined quote can be revised, not reopened", r.s === 200 && r.j.currentVersion === 2 && r.j.status === "DRAFT", r.j);
  await call("POST", `/api/internal/agent/quotes/${q2}/send`, A("rep"));
  await Quote.updateOne({ _id: q2 }, { expiresAt: new Date(Date.now() - 1000) });
  r = await call("POST", `/api/internal/customer/quotes/${q2}/respond`, { shop, buyerShopifyCustomerId: gid("custA"), action: "accept" });
  ok("accepting an expired quote is refused (QUOTE_EXPIRED)", r.s === 409 && r.j.code === "QUOTE_EXPIRED", r);
  ok("...and it is now EXPIRED", (await Quote.findById(q2)).status === "EXPIRED");
  ok("expiry is audited", !!(await Audit.findOne({ action: "quote.expired", objectId: q2 })));
  r = await call("POST", `/api/internal/agent/quotes/${q2}/revise`, A("rep"));
  ok("an expired quote can be revised", r.s === 200 && r.j.currentVersion === 3, r.j);

  // accepted but never converted lapses
  const q4 = (await create("rep")).j.id;
  await call("POST", `/api/internal/agent/quotes/${q4}/send`, A("rep"));
  await call("POST", `/api/internal/customer/quotes/${q4}/respond`, { shop, buyerShopifyCustomerId: gid("custA"), action: "accept" });
  await Quote.updateOne({ _id: q4 }, { convertBy: new Date(Date.now() - 1000) });
  r = await call("GET", "/api/internal/agent/quotes" + q("rep"));
  ok("an accepted quote that isn't converted in time becomes EXPIRED", r.j.quotes.find((x) => x.id === q4).status === "EXPIRED", r.j.quotes.map((x) => x.status));
  r = await call("POST", `/api/internal/agent/quotes/${q4}/converted`, A("rep", { orderId: "o" }));
  ok("...and can't be converted", r.s === 409, r);

  // two answers at once: exactly one wins
  const q5 = (await create("rep")).j.id;
  await call("POST", `/api/internal/agent/quotes/${q5}/send`, A("rep"));
  const race = await Promise.all(["accept", "decline", "accept", "decline"].map((action) => call("POST", `/api/internal/customer/quotes/${q5}/respond`, { shop, buyerShopifyCustomerId: gid("custA"), action })));
  ok("simultaneous answers: exactly one succeeds", race.filter((x) => x.s === 200).length === 1 && race.filter((x) => x.s === 409).length === 3, race.map((x) => x.s));

  // ================= withdrawing =================
  const q6 = (await create("rep")).j.id;
  r = await call("POST", `/api/internal/agent/quotes/${q6}/withdraw`, A("rep"));
  ok("a draft can be withdrawn", r.s === 200 && r.j.status === "WITHDRAWN", r);
  r = await call("POST", `/api/internal/agent/quotes/${q6}/send`, A("rep"));
  ok("a withdrawn quote can't be sent", r.s === 409, r);
  r = await call("POST", `/api/internal/agent/quotes/${q6}/revise`, A("rep"));
  ok("...or revised (it's closed)", r.s === 409, r);
  const q7 = (await create("rep")).j.id;
  await call("POST", `/api/internal/agent/quotes/${q7}/send`, A("rep"));
  r = await call("POST", `/api/internal/agent/quotes/${q7}/withdraw`, A("rep"));
  ok("a sent quote can be withdrawn", r.s === 200, r);
  r = await call("POST", `/api/internal/customer/quotes/${q7}/respond`, { shop, buyerShopifyCustomerId: gid("custA"), action: "accept" });
  ok("...and the buyer can no longer accept it", r.s === 409 && r.j.code === "NOT_OPEN", r);
  r = await call("POST", `/api/internal/agent/quotes/${q1}/submit`, A("rep"));
  ok("submitting a converted quote -> 409", r.s === 409, r);

  // ================= duplicate =================
  r = await call("POST", `/api/internal/agent/quotes/${q1}/duplicate`, A("rep"));
  ok("duplicate: a fresh DRAFT with a new number and the same lines", r.s === 200 && r.j.status === "DRAFT" && r.j.number !== "Q-0001" && r.j.items.length === 2 && r.j.currentVersion === 1, r.j);

  // ================= approval for big quotes =================
  r = await call("PUT", "/api/agent-settings", { quoteApprovalAbove: 100000 }, AH);
  ok("setting: quotes from 1000.00 need approval", r.s === 200 && r.j.quoteApprovalAbove === 100000, r);
  const small = (await create("rep", { items: [{ variantId: "1", title: "x", sku: "x", quantity: 1, baselineUnit: 5000, unitPrice: 5000 }] })).j;
  r = await call("POST", `/api/internal/agent/quotes/${small.id}/submit`, A("rep"));
  ok("a small quote doesn't need approval (APPROVAL_NOT_REQUIRED)", r.s === 409 && r.j.code === "APPROVAL_NOT_REQUIRED", r);
  const big = (await create("rep", { items: [{ variantId: "1", title: "x", sku: "x", quantity: 30, baselineUnit: 5000, unitPrice: 4500 }] })).j;
  r = await call("POST", `/api/internal/agent/quotes/${big.id}/send`, A("rep"));
  ok("a big quote can't skip approval (APPROVAL_REQUIRED)", r.s === 422 && r.j.code === "APPROVAL_REQUIRED", r);
  r = await call("POST", `/api/internal/agent/quotes/${big.id}/submit`, A("rep"));
  ok("submitted: PENDING_APPROVAL and locked", r.s === 200 && r.j.status === "PENDING_APPROVAL" && r.j.approvalState === "PENDING" && r.j.locked === true, r.j);
  r = await call("PUT", `/api/internal/agent/quotes/${big.id}`, A("rep", { notes: "x" }));
  ok("it can't be edited while waiting", r.s === 409, r);
  r = await call("GET", "/api/internal/agent/quote-approvals" + q("mgr"));
  ok("the manager sees it in their queue", r.s === 200 && r.j.quotes.some((x) => x.id === big.id), r);
  r = await call("GET", "/api/internal/agent/quote-approvals" + q("rep"));
  ok("the owner (no approval right) sees nothing", r.j.quotes.length === 0, r);
  r = await call("POST", `/api/internal/agent/quote-approvals/${big.id}/decision`, A("rep", { decision: "approve" }));
  ok("the owner can't approve their own quote", r.s === 403, r);
  r = await call("POST", `/api/internal/agent/quote-approvals/${big.id}/decision`, A("mgr", { decision: "reject", comment: "" }));
  ok("rejecting needs a comment", r.s === 400 && r.j.code === "COMMENT_REQUIRED", r);
  r = await call("POST", `/api/internal/agent/quote-approvals/${big.id}/decision`, A("mgr", { decision: "approve", comment: "OK" }));
  ok("manager approves", r.s === 200 && r.j.status === "APPROVED" && r.j.approvalState === "APPROVED", r.j);
  r = await call("POST", `/api/internal/agent/quote-approvals/${big.id}/decision`, A("mgr", { decision: "approve" }));
  ok("deciding twice -> 409", r.s === 409, r);
  r = await call("PUT", `/api/internal/agent/quotes/${big.id}`, A("rep", { notes: "tweak after approval" }));
  ok("editing an approved quote makes version 2 and needs approval again", r.s === 200 && r.j.currentVersion === 2 && r.j.status === "DRAFT" && r.j.approvalState === "NONE", r.j);
  r = await call("POST", `/api/internal/agent/quotes/${big.id}/send`, A("rep"));
  ok("...so it can't be sent without it", r.s === 422, r);
  await call("POST", `/api/internal/agent/quotes/${big.id}/submit`, A("rep"));
  r = await call("POST", `/api/quotes/${big.id}/decision`, { decision: "approve", comment: "Merchant OK" }, AH);
  ok("the merchant can approve from the panel", r.s === 200 && r.j.status === "APPROVED", r);
  r = await call("POST", `/api/internal/agent/quotes/${big.id}/send`, A("rep"));
  ok("approved quote is sent", r.s === 200 && r.j.status === "SENT", r);

  // the manager's own big quote: not their to approve
  const mgrBig = (await create("mgr", { items: [{ variantId: "1", title: "x", sku: "x", quantity: 40, baselineUnit: 5000, unitPrice: 4500 }] })).j;
  await call("POST", `/api/internal/agent/quotes/${mgrBig.id}/submit`, A("mgr"));
  r = await call("POST", `/api/internal/agent/quote-approvals/${mgrBig.id}/decision`, A("mgr", { decision: "approve", comment: "me" }));
  ok("a manager can't approve their own quote (separation of duties)", r.s === 403 && r.j.code === "SELF_APPROVAL_NOT_ALLOWED", r);
  r = await call("POST", `/api/internal/agent/quotes/${mgrBig.id}/withdraw`, A("mgr"));
  ok("a quote waiting for approval can be withdrawn", r.s === 200 && r.j.status === "WITHDRAWN", r);

  // ================= merchant panel =================
  r = await call("GET", "/api/quotes", null, AH);
  ok("merchant lists every quote with customer and owner names", r.s === 200 && r.j.quotes.length >= 8 && r.j.quotes[0].customerName && r.j.quotes[0].ownerName, r.j.quotes && r.j.quotes[0]);
  r = await call("GET", "/api/quotes?status=SENT", null, AH);
  ok("filter by status", r.s === 200 && r.j.quotes.length >= 1 && r.j.quotes.every((x) => x.status === "SENT"), r.j.quotes && r.j.quotes.map((x) => x.status));
  r = await call("GET", "/api/quotes?status=NOPE", null, AH);
  ok("bad status -> 400", r.s === 400, r);
  r = await call("GET", `/api/quotes/${q1}`, null, AH);
  ok("merchant sees the full quote with internal notes and history", r.s === 200 && r.j.terms.internalNotes !== undefined && r.j.activity.some((a) => a.type === "created") && r.j.items[0].baselineUnit === 4000, r.j);
  r = await call("GET", "/api/quotes", null, IH);
  ok("merchant endpoints need a login", r.s === 401, r);

  // ================= settings =================
  r = await call("PUT", "/api/agent-settings", { quoteApprovalAbove: -5 }, AH);
  ok("settings: negative threshold refused", r.s === 400, r);
  r = await call("PUT", "/api/agent-settings", { quoteValidDays: 0 }, AH);
  ok("settings: validity out of range refused", r.s === 400, r);
  r = await call("PUT", "/api/agent-settings", { quoteValidDays: 30, quoteConvertDays: 5, quoteApprovalAbove: null }, AH);
  ok("settings saved; null turns approval off", r.s === 200 && r.j.quoteValidDays === 30 && r.j.quoteApprovalAbove === null, r.j);
  const fresh = (await create("rep")).j;
  ok("new quotes use the new default validity", fresh.terms.validDays === 30, fresh.terms);

  // ================= audit =================
  for (const action of ["quote.created", "quote.sent", "quote.revised", "quote.submitted", "quote.decided", "quote.withdrawn", "quote.converted"]) {
    ok(`audit has ${action}`, (await Audit.countDocuments({ action })) >= 1, action);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
