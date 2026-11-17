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
const app = R("app");
const Customer = R("src/models/customer.model");
const Grant = R("src/models/agentScopeGrant.model");
const AgentCart = R("src/models/agentCart.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_p1");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const call = async (m, p, body) => {
    const r = await fetch(base + p, { method: m, headers: IH, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json() };
  };
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: "gid://shopify/Customer/" + name, ...extra });
  const agent = await mkc("agent", { role: "sales_agent" });
  const a = await mkc("custA");
  const b = await mkc("custB");
  const aid = "gid://shopify/Customer/agent";
  await Grant.create({ shop, agent: agent._id, scopeType: "customer", scopeId: String(a._id) });
  await Grant.create({ shop, agent: agent._id, scopeType: "customer", scopeId: String(b._id) });

  let r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(a._id) });
  const ctxA = r.j.contextId;

  // ---- persistent cart
  r = await call("GET", `/api/internal/agent/carts/current?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(aid)}&contextId=${ctxA}`);
  ok("new cart starts empty", r.s === 200 && r.j.items.length === 0 && r.j.version === 0, r);

  r = await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: aid, contextId: ctxA, currency: "usd", items: [{ variantId: "111", quantity: 2 }, { variantId: "222", quantity: 1 }, { variantId: "111", quantity: 3 }] });
  ok("save merges duplicate lines (111 -> 5)", r.s === 200 && r.j.items.find((i) => i.variantId === "111").quantity === 5 && r.j.items.length === 2 && r.j.version === 1, r);

  r = await call("GET", `/api/internal/agent/carts/current?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(aid)}&contextId=${ctxA}`);
  ok("cart restored after save", r.j.items.length === 2 && r.j.currency === "USD", r);

  r = await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: aid, contextId: ctxA, items: [{ variantId: "333", quantity: 1 }], expectedVersion: 99 });
  ok("stale version -> 409 conflict with latest cart", r.s === 409 && r.j.code === "VERSION_CONFLICT" && r.j.items.length === 2, r);

  r = await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: aid, contextId: ctxA, items: [{ variantId: "333", quantity: 0 }] });
  ok("bad quantity -> 400", r.s === 400, r);

  // switch to B: B's cart is separate and A's survives
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(b._id) });
  const ctxB = r.j.contextId;
  r = await call("GET", `/api/internal/agent/carts/current?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(aid)}&contextId=${ctxB}`);
  ok("customer B has own empty cart", r.j.items.length === 0, r);
  await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: aid, contextId: ctxB, items: [{ variantId: "999", quantity: 7 }] });

  r = await call("GET", `/api/internal/agent/carts/current?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(aid)}&contextId=${ctxA}`);
  ok("old context can't read A's cart once revoked (switched)", r.s === 401 && r.j.code === "CONTEXT_REVOKED", r);

  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(a._id) });
  const ctxA2 = r.j.contextId;
  r = await call("GET", `/api/internal/agent/carts/current?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(aid)}&contextId=${ctxA2}`);
  ok("re-entering A restores A's saved cart (not B's)", r.j.items.length === 2 && !r.j.items.some((i) => i.variantId === "999"), r);
  ok("exactly one cart row per customer", (await AgentCart.countDocuments({ agent: agent._id })) === 2);

  // other agent / no context cannot touch the cart
  r = await call("GET", `/api/internal/agent/carts/current?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent("gid://shopify/Customer/custA")}&contextId=${ctxA2}`);
  ok("non-agent can't read cart", r.s === 401, r);
  r = await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: aid, contextId: "nope", items: [] });
  ok("garbage context id -> 401", r.s === 401, r);

  // ---- notifications
  const order = { shopifyOrderId: "gid://shopify/Order/1", name: "#1001", orderedAt: new Date().toISOString(), totalPrice: 125, currency: "USD", shopifyCustomerId: a.shopifyCustomerId, placedByAgent: { agentShopifyCustomerId: aid, contextId: ctxA2 } };
  await call("POST", "/api/internal/orders/sync", { shop, orders: [order] });
  await sleep(200);
  ok("2 emails sent (customer + agent)", sent.length === 2, sent.map((m) => m.to));
  ok("customer email names the agent + order", sent[0] && sent[0].to === "custa@x.com" && /agent/.test(sent[0].html) && /#1001/.test(sent[0].subject), sent[0]);
  ok("agent email addressed to agent", sent[1] && sent[1].to === "agent@x.com", sent[1]);
  await call("POST", "/api/internal/orders/sync", { shop, orders: [{ ...order, financialStatus: "paid" }] });
  await sleep(200);
  ok("resync does not re-send emails", sent.length === 2, sent.length);
  await call("POST", "/api/internal/orders/sync", { shop, orders: [{ ...order, shopifyOrderId: "gid://shopify/Order/2", name: "#1002", placedByAgent: { agentShopifyCustomerId: aid, contextId: String(new mongoose.Types.ObjectId()) } }] });
  await sleep(200);
  ok("rejected claim sends no email", sent.length === 2, sent.length);

  // mail failure must not break sync
  nodemailer.createTransport = () => ({ sendMail: async () => { throw new Error("smtp down"); } });
  r = await call("POST", "/api/internal/orders/sync", { shop, orders: [{ ...order, shopifyOrderId: "gid://shopify/Order/3", name: "#1003" }] });
  await sleep(200);
  ok("mail failure does not fail the order sync", r.s === 200, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
