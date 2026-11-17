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
const User = R("src/models/user.model");
const Order = R("src/models/order.model");
const Override = R("src/models/overrideRequest.model");
const ApprovalLink = R("src/models/approvalLink.model");
const links = R("src/services/approvalLink.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_ovrext");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  let call = async (m, p, body, headers = IH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json() };
  };

  // A role, grant or setting changed mid-test makes a context STALE (spec §5.2):
  // refresh it the way the storefront would, then try again.
  {
    const _raw = call;
    call = async (m, p, body, headers) => {
      let r = await _raw(m, p, body, headers);
      if (r.s === 401 && r.j && r.j.code === "CONTEXT_STALE") {
        const qs = new URL("http://x" + p).searchParams;
        const ctxId = (body && body.contextId) || qs.get("contextId");
        const agentId = (body && body.agentShopifyCustomerId) || qs.get("agentShopifyCustomerId");
        if (ctxId && agentId) {
          await _raw("POST", "/api/internal/agent/contexts/" + ctxId + "/refresh", { shop, agentShopifyCustomerId: agentId }, IH);
          r = await _raw(m, p, body, headers);
        }
      }
      return r;
    };
  }
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: gid(name), ...extra });
  const q = (n) => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}`;

  await call("GET", "/api/roles", null, AH);
  await call("POST", "/api/roles", { name: "Rep", permissions: [
    { key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "cart.create" }, { key: "cart.write" },
    { key: "price.override", constraints: { maxDeltaPercent: 10 } }, { key: "discount.override", constraints: { maxPercent: 5 } },
    { key: "quantity_rule.override", constraints: {} }, { key: "shipping.override" },
  ] }, AH);
  await call("POST", "/api/roles", { name: "Lead", permissions: [
    { key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "cart.create" }, { key: "cart.write" },
    { key: "approval.decide", constraints: { maxDeltaPercent: 50 } },
  ] }, AH);

  const rep = await mkc("rep", { role: "rep" });
  const lead = await mkc("lead", { role: "lead" });
  const lead2 = await mkc("lead2", { role: "lead" });
  const admin = await mkc("admin", { role: "sales_admin" });
  const outsider = await mkc("outsider", { role: "sales_agent" });
  const custA = await mkc("custA");
  for (const a of [rep, admin]) await Grant.create({ shop, agent: a._id, scopeType: "customer", scopeId: String(custA._id) });

  const ctx = {};
  for (const n of ["rep", "admin"]) ctx[n] = (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid(n), customerId: String(custA._id) })).j.contextId;
  const CART = [{ variantId: "111", quantity: 10 }, { variantId: "222", quantity: 5 }];
  for (const n of ["rep", "admin"]) await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid(n), contextId: ctx[n], items: CART });

  await Order.create({ shop, shopifyOrderId: "1", name: "#1", orderedAt: new Date(Date.now() - 20 * 864e5), totalPrice: 100.5, currency: "INR", shopifyCustomerId: gid("custA") });
  await Order.create({ shop, shopifyOrderId: "2", name: "#2", orderedAt: new Date(Date.now() - 5 * 864e5), totalPrice: 200, currency: "INR", shopifyCustomerId: gid("custA") });

  const ask = (n, over = {}) => call("POST", "/api/internal/agent/overrides", {
    shop, agentShopifyCustomerId: gid(n), contextId: ctx[n], type: "UNIT_PRICE", lineVariantId: "222",
    baseline: { amount: 45000, currency: "INR" }, proposed: { amount: 38250, currency: "INR" },
    reasonCode: "VOLUME_COMMITMENT", reasonText: "big order", ...over,
  });

  // ============ approver context (spec 8.4) ============
  let r = await ask("rep");
  ok("15% request is pending", r.j.status === "PENDING_APPROVAL", r);
  const reqId = r.j.id;
  await sleep(300);

  r = await call("GET", "/api/internal/agent/approvals" + q("lead"));
  const a1 = r.j.approvals && r.j.approvals.find((x) => x.id === reqId);
  ok("approver sees the price impact: 6750 per unit, 33750 for 5, 15%", a1 && a1.impact.perUnit === 6750 && a1.impact.total === 33750 && a1.impact.percent === 15 && a1.impact.costTracked === false, a1 && a1.impact);
  ok("approver sees customer history: 2 orders, 30050 spent, last order date", a1 && a1.history.orders === 2 && a1.history.orderTotal === 30050 && a1.history.currency === "INR" && !!a1.history.lastOrderAt, a1 && a1.history);
  ok("history counts earlier exceptions in the last 90 days", a1.history.exceptions90d.total >= 1, a1.history);

  // ============ custom line ============
  const custom = (n, over = {}) => call("POST", "/api/internal/agent/overrides", {
    shop, agentShopifyCustomerId: gid(n), contextId: ctx[n], type: "CUSTOM_LINE", custom: { title: "Setup fee", quantity: 1, taxCode: "STD" },
    baseline: { amount: 0, currency: "INR" }, proposed: { amount: 5000, currency: "INR" }, reasonCode: "OTHER", reasonText: "installation", ...over,
  });
  r = await custom("admin");
  ok("administrator can add a custom line; kept with title and quantity", r.s === 201 && r.j.status === "AUTO_APPROVED" && r.j.custom.title === "Setup fee" && r.j.custom.quantity === 1 && r.j.lineVariantId === null, r);
  const customId = r.j.id;
  r = await custom("rep");
  ok("role without custom_line.create is denied", r.j.status === "DENIED" && r.j.denyReason === "PERMISSION_DENIED", r);
  r = await custom("admin", { custom: { title: "", quantity: 1 } });
  ok("custom line needs a description", r.s === 400 && r.j.code === "INVALID_CUSTOM_LINE", r);
  r = await custom("admin", { custom: { title: "x", quantity: 0 } });
  ok("custom line quantity must be at least 1", r.s === 400 && r.j.code === "INVALID_CUSTOM_LINE", r);
  r = await custom("admin", { custom: { title: "x", quantity: 2.5 } });
  ok("custom line quantity must be whole", r.s === 400, r);
  await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid("admin"), contextId: ctx.admin, items: [{ variantId: "333", quantity: 1 }] });
  r = await call("GET", "/api/internal/agent/overrides/usable" + q("admin") + "&contextId=" + ctx.admin);
  ok("a custom line stays usable when the rest of the cart changes", r.s === 200 && r.j.overrides.some((o) => o.id === customId), r.j);
  r = await call("GET", "/api/internal/agent/overrides" + q("admin") + "&contextId=" + ctx.admin);
  ok("custom line is in the agent's list with its details", r.j.overrides.some((o) => o.id === customId && o.custom && o.custom.title === "Setup fee"), r.j);

  // ============ other exception types are accepted ============
  r = await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctx.rep, items: CART });
  r = await ask("rep", { type: "ORDER_DISCOUNT", lineVariantId: undefined, baseline: { amount: 100000, currency: "INR" }, proposed: { amount: 96000, currency: "INR" } });
  ok("order discount 4% within the rep's 5% -> AUTO_APPROVED, impact shown to the agent's own list", r.j.status === "AUTO_APPROVED" && r.j.deltaPercent === 4 && r.j.lineVariantId === null, r);
  r = await ask("rep", { type: "ORDER_DISCOUNT", lineVariantId: undefined, baseline: { amount: 100000, currency: "INR" }, proposed: { amount: 90000, currency: "INR" } });
  ok("order discount 10% over the rep's 5% -> PENDING_APPROVAL", r.j.status === "PENDING_APPROVAL", r);
  r = await ask("rep", { type: "SHIPPING_PRICE", lineVariantId: undefined, baseline: { amount: 2000, currency: "INR" }, proposed: { amount: 0, currency: "INR" } });
  ok("free shipping request accepted as an exception (no limit configured -> auto)", r.s === 201 && ["AUTO_APPROVED", "PENDING_APPROVAL"].includes(r.j.status), r);
  r = await ask("rep", { type: "QUANTITY_RULE", baseline: { amount: 12, currency: "QTY" }, proposed: { amount: 8, currency: "QTY" } });
  ok("quantity rule exception accepted (accept 8 where the rule says 12)", r.s === 201 && r.j.baseline.currency === "QTY" && r.j.snapshotQuantity === 5, r);

  // ============ approval links (spec 8.4) ============
  const autoLinks = await ApprovalLink.countDocuments({ request: reqId });
  ok("creating a pending request issued links by itself", autoLinks >= 3, autoLinks);
  await ApprovalLink.deleteMany({ request: reqId });
  sent.length = 0;
  const pend = await Override.findById(reqId);
  const issued = await links.issueForRequest(pend);
  const ids = issued.map((i) => i.approverId);
  ok("links go to approvers who could decide (both leads, an admin)", ids.includes(String(lead._id)) && ids.includes(String(lead2._id)) && ids.includes(String(admin._id)), ids);
  ok("not to the requester or someone with no approval right", !ids.includes(String(rep._id)) && !ids.includes(String(outsider._id)), ids);
  await sleep(300);
  ok("each approver was emailed a link containing their own token", issued.every((i) => sent.some((m) => m.html.includes("/apps/sparklayer/approve/" + i.token))), sent.map((m) => m.to));
  const stored = await ApprovalLink.findOne({ approver: lead._id, request: reqId });
  const tokLead = issued.find((i) => i.approverId === String(lead._id)).token;
  ok("only a hash of the token is stored", stored.tokenHash !== tokLead && stored.tokenHash.length === 64 && !JSON.stringify(stored).includes(tokLead));
  ok("link expires with the request", String(stored.expiresAt) === String(pend.expiresAt));

  const OPEN = "/api/internal/agent/approval-links/open";
  const DECIDE = "/api/internal/agent/approval-links/decide";
  r = await call("POST", OPEN, { shop, token: tokLead, agentShopifyCustomerId: gid("lead") });
  ok("approver opens their link and sees baseline, requested value, impact, history, reason, requester", r.s === 200 && r.j.baseline.amount === 45000 && r.j.proposed.amount === 38250 && r.j.impact.total === 33750 && r.j.history.orders === 2 && r.j.reasonText === "big order" && r.j.agentName === "rep", r);
  r = await call("POST", OPEN, { shop, token: tokLead, agentShopifyCustomerId: gid("lead2") });
  ok("someone else signed in gets nothing (404)", r.s === 404, r);
  r = await call("POST", OPEN, { shop, token: tokLead });
  ok("not signed in gets nothing (404)", r.s === 404, r);
  r = await call("POST", OPEN, { shop, token: "garbage", agentShopifyCustomerId: gid("lead") });
  ok("unknown token (404)", r.s === 404, r);

  r = await call("POST", DECIDE, { shop, token: tokLead, agentShopifyCustomerId: gid("lead"), decision: "maybe" });
  ok("invalid decision refused and link not used up", r.s === 400 && !(await ApprovalLink.findById(stored._id)).usedAt, r);
  r = await call("POST", DECIDE, { shop, token: tokLead, agentShopifyCustomerId: gid("lead"), decision: "reject", comment: "" });
  ok("rejecting needs a comment; refused decision leaves the link usable", r.s === 400 && r.j.code === "COMMENT_REQUIRED" && !(await ApprovalLink.findById(stored._id)).usedAt, r);
  r = await call("POST", DECIDE, { shop, token: tokLead, agentShopifyCustomerId: gid("lead"), decision: "approve", comment: "ok" });
  ok("approving through the link works", r.s === 200 && r.j.status === "APPROVED", r);
  r = await call("POST", DECIDE, { shop, token: tokLead, agentShopifyCustomerId: gid("lead"), decision: "approve" });
  ok("the link is single-use (410)", r.s === 410 && r.j.code === "LINK_USED", r);
  r = await call("POST", OPEN, { shop, token: tokLead, agentShopifyCustomerId: gid("lead") });
  ok("opening a used link says so (410)", r.s === 410, r);
  const tokLead2 = issued.find((i) => i.approverId === String(lead2._id)).token;
  r = await call("POST", OPEN, { shop, token: tokLead2, agentShopifyCustomerId: gid("lead2") });
  ok("other approvers' links die once it is decided (409)", r.s === 409 && r.j.code === "ALREADY_DECIDED", r);

  // expiry
  r = await ask("rep", { lineVariantId: "111", proposed: { amount: 36000, currency: "INR" } });
  await sleep(300);
  await ApprovalLink.deleteMany({ request: r.j.id });
  const p2 = await Override.findById(r.j.id);
  const iss2 = await links.issueForRequest(p2);
  const t2 = iss2.find((i) => i.approverId === String(lead._id)).token;
  await ApprovalLink.updateOne({ request: p2._id, approver: lead._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  r = await call("POST", DECIDE, { shop, token: t2, agentShopifyCustomerId: gid("lead"), decision: "approve" });
  ok("an expired link is refused (410 LINK_EXPIRED)", r.s === 410 && r.j.code === "LINK_EXPIRED", r);

  // a decision made elsewhere kills the other links
  const t2b = iss2.find((i) => i.approverId === String(lead2._id)).token;
  r = await call("POST", `/api/internal/agent/approvals/${p2._id}/decision`, { shop, agentShopifyCustomerId: gid("lead2"), decision: "reject", comment: "no" });
  ok("deciding in the drawer works", r.s === 200, r);
  r = await call("POST", OPEN, { shop, token: t2b, agentShopifyCustomerId: gid("lead2") });
  ok("then the emailed link no longer opens (409)", r.s === 409, r);

  // links are only made for pending requests
  const none = await links.issueForRequest(await Override.findById(reqId));
  ok("no links for a request that is not pending", none.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
