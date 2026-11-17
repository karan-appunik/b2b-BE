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
const PaymentLink = R("src/models/paymentLink.model");
const Audit = R("src/models/auditEvent.model");
const Outbox = R("src/models/outboxEvent.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_paylink");
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

  await call("GET", "/api/roles", null, AH);
  await call("POST", "/api/roles", { name: "No Link", permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "cart.create" }, { key: "order.submit" }] }, AH);

  const rep = await mkc("rep", { role: "sales_agent" });
  const other = await mkc("other", { role: "sales_agent" });
  const nol = await mkc("nol", { role: "no_link" });
  const custA = await mkc("custA");
  const custB = await mkc("custB");
  for (const a of [rep, nol]) await Grant.create({ shop, agent: a._id, scopeType: "customer", scopeId: String(custA._id) });
  await Grant.create({ shop, agent: other._id, scopeType: "customer", scopeId: String(custB._id) });

  const body = (n, over = {}) => A(n, {
    customerShopifyId: gid("custA"), draftOrderId: "gid://shopify/DraftOrder/1",
    invoiceUrl: "https://t.myshopify.com/invoices/abc", amount: 56000, currency: "usd", ...over,
  });
  const P = "/api/internal/agent/payment-links";

  // ---- create
  let r = await call("POST", P, body("rep"));
  ok("link created, ACTIVE, amount/currency kept", r.s === 201 && r.j.status === "ACTIVE" && r.j.amount === 56000 && r.j.currency === "USD", r);
  ok("masked email returned, hosted URL not exposed", /^c\*+@x\.com$/.test(r.j.emailMasked) && !JSON.stringify(r.j).includes("invoices/abc"), r.j);
  const l1 = r.j.id, tok1 = r.j.token;
  await sleep(100);
  ok("buyer email sent with the link", sent.length === 1 && sent[0].to === "custa@x.com" && sent[0].html.includes("/apps/sparklayer/pay/" + tok1), sent.map((m) => m.to));
  const stored = await PaymentLink.findById(l1).select("+invoiceUrl");
  ok("expiry about 72h out", Math.abs(stored.expiresAt - (Date.now() + 72 * 3600e3)) < 60e3);
  ok("audit written for creation", !!(await Audit.findOne({ shop, action: "payment_link.created", objectId: l1 })));

  // ---- permission / scope / validation
  r = await call("POST", P, body("nol"));
  ok("role without payment_link.send is denied", r.s === 403 && r.j.code === "PERMISSION_DENIED", r);
  r = await call("POST", P, body("other"));
  ok("agent without access to the customer is denied", r.s === 403, r);
  r = await call("POST", P, body("rep", { amount: 0 }));
  ok("zero amount rejected", r.s === 400 && r.j.code === "INVALID_AMOUNT", r);
  r = await call("POST", P, body("rep", { amount: 10.5 }));
  ok("non-integer amount rejected", r.s === 400, r);
  r = await call("POST", P, body("rep", { invoiceUrl: "http://evil.com/x" }));
  ok("non-https checkout url rejected", r.s === 400 && r.j.code === "INVALID_URL", r);
  r = await call("POST", P, body("rep", { customerShopifyId: gid("nobody") }));
  ok("unknown customer 404", r.s === 404, r);
  r = await call("POST", P, body("rep"), { "Content-Type": "application/json" });
  ok("no internal key -> 401", r.s === 401, r);

  // ---- buyer opening
  const RES = "/api/internal/customer/payment-links/resolve";
  r = await call("POST", RES, { shop, token: tok1, buyerShopifyCustomerId: gid("custA") });
  ok("owner buyer gets the hosted checkout url", r.s === 200 && r.j.invoiceUrl === "https://t.myshopify.com/invoices/abc" && r.j.amount === 56000, r);
  r = await call("POST", RES, { shop, token: tok1, buyerShopifyCustomerId: gid("custB") });
  ok("another customer sees nothing (404)", r.s === 404, r);
  r = await call("POST", RES, { shop, token: tok1 });
  ok("anonymous sees nothing (404)", r.s === 404, r);
  r = await call("POST", RES, { shop, token: "nope", buyerShopifyCustomerId: gid("custA") });
  ok("unknown token 404", r.s === 404, r);
  const opened = await PaymentLink.findById(l1);
  ok("open is recorded", opened.openCount === 1 && !!opened.openedAt);

  // ---- replacement
  r = await call("POST", P, body("rep"));
  const l2 = r.j.id, tok2 = r.j.token;
  ok("second link for same order created", r.s === 201 && l2 !== l1);
  r = await call("POST", RES, { shop, token: tok1, buyerShopifyCustomerId: gid("custA") });
  ok("older link no longer works (410)", r.s === 410, r);
  ok("older link marked REPLACED", (await PaymentLink.findById(l1)).status === "REPLACED");

  // ---- order total changed
  r = await call("POST", "/api/internal/payment-links/order-changed", { shop, draftOrderId: "gid://shopify/DraftOrder/1" });
  ok("total change revokes live link", r.s === 200 && r.j.revoked === 1, r);
  r = await call("POST", RES, { shop, token: tok2, buyerShopifyCustomerId: gid("custA") });
  ok("revoked link gives 410", r.s === 410, r);

  // ---- expiry
  r = await call("POST", P, body("rep", { draftOrderId: "gid://shopify/DraftOrder/2" }));
  const l3 = r.j.id, tok3 = r.j.token;
  await PaymentLink.updateOne({ _id: l3 }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  r = await call("POST", RES, { shop, token: tok3, buyerShopifyCustomerId: gid("custA") });
  ok("expired link gives 410 and flips to EXPIRED", r.s === 410 && (await PaymentLink.findById(l3)).status === "EXPIRED", r);

  // ---- agent list / revoke
  r = await call("POST", P, body("rep", { draftOrderId: "gid://shopify/DraftOrder/3" }));
  const l4 = r.j.id, tok4 = r.j.token;
  r = await call("GET", `${P}?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("rep"))}`);
  ok("agent lists own links without secrets", r.s === 200 && r.j.links.length === 4 && !JSON.stringify(r.j).includes(tok4) && !JSON.stringify(r.j).includes("invoices"), r.j);
  r = await call("GET", `${P}?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("other"))}`);
  ok("other agent sees none of them", r.j.links.length === 0, r.j);
  r = await call("POST", `${P}/${l4}/revoke`, A("other"));
  ok("other agent can't revoke it (404)", r.s === 404, r);
  r = await call("POST", `${P}/${l4}/revoke`, A("rep"));
  ok("owner revokes", r.s === 200 && r.j.status === "REVOKED", r);
  r = await call("POST", `${P}/${l4}/revoke`, A("rep"));
  ok("revoking twice -> 409", r.s === 409, r);

  // ---- payment reported: matching amount
  r = await call("POST", P, body("rep", { draftOrderId: "gid://shopify/DraftOrder/5" }));
  const l5 = r.j.id, tok5 = r.j.token;
  const PAID = "/api/internal/payment-links/paid";
  r = await call("POST", PAID, { shop, token: tok5, orderId: "9001", amount: 56000, currency: "USD" });
  ok("paid reported", r.s === 200 && r.j.found && !r.j.already, r);
  let pl = await PaymentLink.findById(l5);
  ok("link PAID with order id, no mismatch", pl.status === "PAID" && pl.paidOrderId === "9001" && !pl.reconcileFlag, pl);
  r = await call("POST", PAID, { shop, token: tok5, orderId: "9001", amount: 56000, currency: "USD" });
  ok("reporting twice is idempotent", r.j.already === true);
  ok("only one payment.completed event", (await Outbox.countDocuments({ shop, type: "sales_agent.payment.completed" })) === 1);
  r = await call("POST", RES, { shop, token: tok5, buyerShopifyCustomerId: gid("custA") });
  ok("paid link can't be reopened (409)", r.s === 409, r);

  // ---- payment reported: wrong amount
  r = await call("POST", P, body("rep", { draftOrderId: "gid://shopify/DraftOrder/6" }));
  const l6 = r.j.id, tok6 = r.j.token;
  await call("POST", PAID, { shop, token: tok6, orderId: "9002", amount: 40000, currency: "USD" });
  pl = await PaymentLink.findById(l6);
  ok("amount mismatch is flagged", pl.reconcileFlag === "AMOUNT_MISMATCH" && pl.status === "PAID", pl);
  ok("mismatch audited as failure", !!(await Audit.findOne({ shop, action: "payment_link.mismatch", outcome: "failure" })));
  r = await call("POST", PAID, { shop, token: "unknown", orderId: "1", amount: 1, currency: "USD" });
  ok("unknown token on paid -> found:false", r.s === 200 && r.j.found === false, r);

  // ---- merchant panel
  r = await call("GET", "/api/payment-links", null, AH);
  ok("merchant lists links with names, no secrets", r.s === 200 && r.j.links.length === 6 && r.j.links[0].agentName && !JSON.stringify(r.j).includes(tok5) && !JSON.stringify(r.j).includes("invoices"), r.j.links && r.j.links[0]);
  r = await call("GET", "/api/payment-links", null, { "Content-Type": "application/json" });
  ok("merchant list needs login", r.s === 401, r);
  r = await call("POST", P, body("rep", { draftOrderId: "gid://shopify/DraftOrder/7" }));
  const l7 = r.j.id;
  r = await call("POST", `/api/payment-links/${l7}/revoke`, {}, AH);
  ok("merchant can revoke", r.s === 200 && r.j.status === "REVOKED", r);

  // ---- settings
  r = await call("PUT", "/api/agent-settings", { paymentLinkValidHours: 24 }, AH);
  ok("validity hours configurable", r.s === 200 && r.j.paymentLinkValidHours === 24, r);
  r = await call("POST", P, body("rep", { draftOrderId: "gid://shopify/DraftOrder/8" }));
  const l8 = await PaymentLink.findById(r.j.id);
  ok("new link uses 24h", Math.abs(l8.expiresAt - (Date.now() + 24 * 3600e3)) < 60e3);


  // ---- shipping and tax added by the hosted checkout
  const owner = await Customer.findOne({ shop, name: "rep" });
  const buyerDoc = await Customer.findOne({ shop, name: "custA" });
  let n = 0;
  const mkLink = async () => {
    n += 1;
    return PaymentLink.create({ shop, token: "extra-" + n, customer: buyerDoc._id, agent: owner._id, draftOrderId: "d-extra-" + n, invoiceUrl: "https://x/" + n, amount: 160000, currency: "USD", expiresAt: new Date(Date.now() + 3600e3) });
  };
  const paid = async (amount, extras) => {
    const l = await mkLink();
    await call("POST", PAID, { shop, token: l.token, orderId: "o" + n, amount, currency: "USD", extras });
    return PaymentLink.findById(l._id);
  };
  pl = await paid(160800, { shipping: 800, tax: 0 });
  ok("the checkout added $8 shipping: not a mismatch", pl.status === "PAID" && !pl.reconcileFlag, pl);
  pl = await paid(163200, { shipping: 0, tax: 3200 });
  ok("the checkout added tax: not a mismatch", !pl.reconcileFlag, pl);
  pl = await paid(164000, { shipping: 800, tax: 3200 });
  ok("shipping and tax together: not a mismatch", !pl.reconcileFlag, pl);
  pl = await paid(160800, undefined);
  ok("an extra the checkout did not report is still a mismatch", pl.reconcileFlag === "AMOUNT_MISMATCH", pl);
  pl = await paid(150800, { shipping: 800, tax: 0 });
  ok("less than the link asked for is a mismatch even with shipping", pl.reconcileFlag === "AMOUNT_MISMATCH", pl);
  pl = await paid(170000, { shipping: 800, tax: 0 });
  ok("a different total that shipping does not explain is a mismatch", pl.reconcileFlag === "AMOUNT_MISMATCH", pl);
  pl = await paid(160000, { shipping: 800, tax: 0 });
  ok("paying exactly what was asked is fine whatever the extras say", !pl.reconcileFlag, pl);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
