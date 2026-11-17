const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k"; process.env.JWT_SECRET = "s";
const mongoose = require(ROOT + "/node_modules/mongoose");
const app = require(ROOT + "/app");
const Customer = require(ROOT + "/src/models/customer.model");
const Grant = require(ROOT + "/src/models/agentScopeGrant.model");
const Ctx = require(ROOT + "/src/models/contextSession.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_ctx");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0); const base = "http://localhost:" + srv.address().port;
  const H = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const shop = "t.myshopify.com";
  const call = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: H, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json() }; };
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: "gid://shopify/Customer/" + name, ...extra });
  const agent = await mkc("agent", { role: "sales_agent" });
  const admin = await mkc("admin", { role: "sales_admin" });
  const a = await mkc("custA"), b = await mkc("custB", { territory: "north" }), c = await mkc("custC");
  const aid = "gid://shopify/Customer/agent", adm = "gid://shopify/Customer/admin";
  const q = (id, extra = "") => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(id)}${extra}`;

  let r = await call("GET", "/api/internal/customers/search" + q(aid, "&q=cust"));
  ok("agent with no grants sees nothing", r.s === 200 && r.j.length === 0, r);
  r = await call("GET", "/api/internal/customers/search" + q(adm, "&q=cust"));
  ok("sales_admin sees all 3", r.j.length === 3, r);
  r = await call("GET", "/api/internal/customers/search" + q("gid://shopify/Customer/custA", "&q=cust"));
  ok("non-agent gets 403", r.s === 403, r);

  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(a._id) });
  ok("enter without grant -> 403 generic", r.s === 403 && r.j.code === "CUSTOMER_ACCESS_DENIED", r);
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(new mongoose.Types.ObjectId()) });
  ok("unknown customer -> same 403", r.s === 403 && r.j.code === "CUSTOMER_ACCESS_DENIED", r);

  await Grant.create({ shop, agent: agent._id, scopeType: "customer", scopeId: String(a._id) });
  await Grant.create({ shop, agent: agent._id, scopeType: "territory", scopeId: "north" });
  r = await call("GET", "/api/internal/customers/search" + q(aid, "&q=cust"));
  ok("search shows custA + custB only", r.j.length === 2 && !r.j.some(x => x.name === "custC"), r);

  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(a._id) });
  ok("enter custA -> 201", r.s === 201 && r.j.contextId, r);
  const ctxA = r.j.contextId;
  r = await call("GET", "/api/internal/agent/contexts/current" + q(aid));
  ok("current = custA", r.j.active && r.j.customer.name === "custA", r);
  r = await call("GET", `/api/internal/agent/contexts/${ctxA}/validate` + q(aid));
  ok("validate ok", r.s === 200, r);

  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(b._id) });
  ok("switch to custB (territory) -> 201", r.s === 201, r);
  const ctxB = r.j.contextId;
  r = await call("GET", `/api/internal/agent/contexts/${ctxA}/validate` + q(aid));
  ok("old context A now revoked", r.s === 401 && r.j.code === "CONTEXT_REVOKED", r);
  ok("only 1 live context", (await Ctx.countDocuments({ agent: agent._id, revokedAt: null })) === 1);

  r = await call("GET", `/api/internal/agent/contexts/${ctxB}/validate` + q(adm));
  ok("other agent can't use my context", r.s === 401, r);

  await Grant.create({ shop, agent: agent._id, scopeType: "customer", scopeId: String(b._id), effect: "deny" });
  r = await call("GET", `/api/internal/agent/contexts/${ctxB}/validate` + q(aid));
  ok("explicit deny added -> context revoked on next request", r.s === 401 && r.j.code === "CONTEXT_REVOKED", r);
  r = await call("GET", "/api/internal/agent/contexts/current" + q(aid));
  ok("no active context now", r.j.active === false, r);

  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(a._id) });
  const ctxA2 = r.j.contextId;
  await Ctx.updateOne({ _id: ctxA2 }, { expiresAt: new Date(Date.now() - 1000) });
  r = await call("GET", `/api/internal/agent/contexts/${ctxA2}/validate` + q(aid));
  ok("expired context -> CONTEXT_EXPIRED", r.s === 401 && r.j.code === "CONTEXT_EXPIRED", r);

  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(a._id) });
  const ctxA3 = r.j.contextId;
  r = await call("DELETE", `/api/internal/agent/contexts/${ctxA3}` + q(aid));
  ok("exit -> inactive", r.s === 200 && r.j.active === false, r);
  const rec = await Ctx.findById(ctxA3);
  ok("exit recorded with reason EXIT", rec.revokedAt && rec.revokedReason === "EXIT", rec);

  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: aid, customerId: String(a._id) });
  const ctxA4 = r.j.contextId;
  await Customer.updateOne({ _id: agent._id }, { role: "customer" });
  r = await call("GET", `/api/internal/agent/contexts/${ctxA4}/validate` + q(aid));
  ok("demoted agent's context dead", r.s === 401, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase(); await mongoose.disconnect(); srv.close(); process.exit(fail ? 1 : 0);
})().catch(async e => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch {} process.exit(1); });
