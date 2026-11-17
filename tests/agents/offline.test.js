// Phase 4: offline capture. What a device saved with no signal is received
// safely, once, and only for customers the agent may act for.
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
const Audit = R("src/models/auditEvent.model");
const Cart = R("src/models/agentCart.model");
const Capture = R("src/models/offlineCapture.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_offline");
  await mongoose.connection.dropDatabase();
  await Capture.syncIndexes();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const call = async (m, p, body, headers = IH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });
  const q = (n, extra = "") => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}${extra}`;
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  await call("GET", "/api/roles", null, AH);
  await call("POST", "/api/roles", { name: "Viewer", permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }] }, AH);

  const rep = await mk("rep", { role: "sales_agent" });
  const other = await mk("other", { role: "sales_agent" });
  const viewer = await mk("viewer", { role: "viewer" });
  const mine = await mk("mine", { company: "Mine Co" });
  const notmine = await mk("notmine");
  const suspended = await mk("susp", { accountStatus: "suspended" });
  for (const a of [rep, other, viewer]) await Grant.create({ shop, agent: a._id, scopeType: "customer", scopeId: String(mine._id) });
  await Grant.create({ shop, agent: rep._id, scopeType: "customer", scopeId: String(suspended._id) });

  const send = (n, captures) => call("POST", "/api/internal/agent/offline-captures", { shop, agentShopifyCustomerId: gid(n), captures });
  const cap = (over = {}) => ({ clientId: "dev1-" + Math.random().toString(36).slice(2), customerId: String(mine._id), capturedAt: hoursAgo(2), lines: [{ sku: "B-1", quantity: 3 }, { barcode: "5901234123457", quantity: 1 }], note: "Wants delivery Friday", po: "PO-77", ...over });

  // ---- off by default
  let r = await send("rep", [cap()]);
  ok("it is off until the merchant turns it on (403)", r.s === 403 && r.j.code === "OFFLINE_DISABLED", r);
  r = await call("GET", "/api/internal/agent/module-settings?shop=" + shop);
  ok("the storefront is told it is off", r.j.offlineCaptureEnabled === false, r.j);
  r = await call("PUT", "/api/agent-settings", { offlineCaptureEnabled: true, offlineCaptureDays: 3 }, AH);
  ok("the merchant turns it on", r.s === 200 && r.j.offlineCaptureEnabled === true && r.j.offlineCaptureDays === 3, r);
  r = await call("PUT", "/api/agent-settings", { offlineCaptureDays: 99 }, AH);
  ok("the keep-days setting has limits (400)", r.s === 400, r);
  r = await call("GET", "/api/internal/agent/module-settings?shop=" + shop);
  ok("and the storefront is told it is on", r.j.offlineCaptureEnabled === true && r.j.offlineCaptureDays === 3, r.j);

  // ---- receiving
  const first = cap();
  r = await send("rep", [first]);
  ok("a capture is received", r.s === 200 && r.j.results[0].status === "accepted" && r.j.results[0].clientId === first.clientId, r);
  const savedId = r.j.results[0].id;
  r = await send("rep", [first]);
  ok("sending it again does not double it", r.j.results[0].status === "duplicate" && (await Capture.countDocuments({ clientId: first.clientId })) === 1, r.j);
  const [a, b] = await Promise.all([send("rep", [cap({ clientId: "same-time" })]), send("rep", [cap({ clientId: "same-time" })])]);
  ok("two sends at once still make only one", (await Capture.countDocuments({ clientId: "same-time" })) === 1 && [a, b].every((x) => x.s === 200), [a.j, b.j]);

  r = await send("rep", [cap({ customerId: String(notmine._id) }), cap({ customerId: "nope" }), cap({ capturedAt: "garbage" }), cap({ capturedAt: hoursAgo(-5) }), cap({ capturedAt: hoursAgo(24 * 5) }), cap({ lines: [] }), cap({ lines: [{ sku: "x", quantity: 0 }] }), cap({ lines: [{ quantity: 2 }] }), cap({ clientId: "" })]);
  const codes = r.j.results.map((x) => x.code);
  ok("a customer the agent has no access to is refused", codes[0] === "CUSTOMER_NOT_FOUND" || codes[0] === "ACCESS_DENIED", codes);
  ok("so is a customer id that is not real", codes[1] === "CUSTOMER_NOT_FOUND", codes);
  ok("a bad date, a date in the future, and one too old are refused", codes[2] === "BAD_DATE" && codes[3] === "BAD_DATE" && codes[4] === "STALE", codes);
  ok("empty, zero-quantity and item-less lines are refused", codes[5] === "NO_LINES" && codes[6] === "BAD_QUANTITY" && codes[7] === "NO_ITEM", codes);
  ok("a capture with no id is refused", codes[8] === "BAD_ID", codes);
  ok("one bad row never blocks the others", r.j.results.every((x) => x.status === "rejected"), r.j);

  r = await send("rep", [cap({ customerId: String(suspended._id) })]);
  ok("a suspended account is refused", r.j.results[0].status === "rejected", r.j);
  r = await send("viewer", [cap()]);
  ok("a role that can't build carts can't capture (rejected)", r.j.results[0].code === "PERMISSION_DENIED", r.j);
  r = await call("POST", "/api/internal/agent/offline-captures", { shop, agentShopifyCustomerId: gid("ghost"), captures: [cap()] });
  ok("an unknown person is refused (403)", r.s === 403, r);
  r = await send("rep", []);
  ok("an empty send is a bad request (400)", r.s === 400, r);
  r = await send("rep", Array.from({ length: 60 }, () => cap()));
  ok("a huge send is a bad request (400)", r.s === 400, r);

  // ---- nothing was written to a cart
  ok("a capture is not a cart: no cart was created or changed", (await Cart.countDocuments({ shop })) === 0, null);
  const stored = await Capture.findOne({ clientId: first.clientId }).lean();
  ok("it keeps what was written, the device time and the receive time", stored.lines.length === 2 && stored.po === "PO-77" && stored.receivedAt > stored.capturedAt && stored.status === "PENDING_REVIEW", stored);
  const aud = await Audit.findOne({ action: "offline_capture.received", objectId: savedId }).lean();
  ok("receiving is audited with how late it was", aud && aud.metadata.lines === 2 && aud.metadata.delayMinutes >= 119, aud);

  // ---- reviewing
  r = await call("GET", "/api/internal/agent/offline-captures" + q("rep"));
  ok("the agent sees what is waiting, by customer name", r.s === 200 && r.j.enabled && r.j.captures.some((c) => c.id === savedId && c.customerName === "Mine Co" && c.lines.length === 2), r.j);
  r = await call("GET", "/api/internal/agent/offline-captures" + q("other"));
  ok("another agent does not see it", r.j.captures.length === 0, r.j);
  r = await call("POST", `/api/internal/agent/offline-captures/${savedId}/resolve`, { shop, agentShopifyCustomerId: gid("other"), outcome: "ADDED" });
  ok("another agent can't close it (404)", r.s === 404, r);
  r = await call("POST", `/api/internal/agent/offline-captures/${savedId}/resolve`, { shop, agentShopifyCustomerId: gid("rep"), outcome: "BOGUS" });
  ok("only added or discarded are allowed (404)", r.s === 404, r);
  r = await call("POST", `/api/internal/agent/offline-captures/${savedId}/resolve`, { shop, agentShopifyCustomerId: gid("rep"), outcome: "ADDED" });
  ok("the agent marks it added", r.s === 200 && r.j.status === "ADDED", r);
  r = await call("POST", `/api/internal/agent/offline-captures/${savedId}/resolve`, { shop, agentShopifyCustomerId: gid("rep"), outcome: "DISCARDED" });
  ok("it can't be closed twice (404)", r.s === 404, r);
  r = await call("GET", "/api/internal/agent/offline-captures" + q("rep"));
  ok("a closed one is no longer listed", !r.j.captures.some((c) => c.id === savedId), r.j);
  r = await send("rep", [first]);
  ok("a resend of a closed capture is still a repeat", r.j.results[0].status === "duplicate", r.j);

  // ---- access can be lost while offline
  await Grant.deleteMany({ shop, agent: rep._id, scopeId: String(mine._id) });
  r = await send("rep", [cap()]);
  ok("access removed in the meantime: the capture is refused when it arrives", r.j.results[0].status === "rejected", r.j);
  const keep = await Capture.create({ shop, agent: rep._id, customer: mine._id, clientId: "kept", capturedAt: new Date(), lines: [{ sku: "A", quantity: 1 }] });
  r = await call("GET", "/api/internal/agent/offline-captures" + q("rep"));
  ok("and an earlier one for that customer is no longer shown to them", !r.j.captures.some((c) => c.id === String(keep._id)), r.j);

  // ---- switching it off
  await call("PUT", "/api/agent-settings", { offlineCaptureEnabled: false }, AH);
  r = await call("GET", "/api/internal/agent/offline-captures" + q("other"));
  ok("when it is turned off, nothing is offered", r.j.enabled === false && r.j.captures.length === 0, r.j);

  // ---- retention and erasure
  await Capture.updateOne({ _id: keep._id }, { $set: { receivedAt: new Date(Date.now() - 400 * 24 * 3600 * 1000) } });
  const retention = R("src/services/retention.service");
  let rr = await retention.runRetention(shop, { dryRun: true });
  ok("retention counts old captures (dry run)", rr.offlineCaptures === 1, rr);
  rr = await retention.runRetention(shop, {});
  ok("and deletes them when run", rr.offlineCaptures === 1 && (await Capture.countDocuments({ _id: keep._id })) === 0, rr);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
