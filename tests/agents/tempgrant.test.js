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
const Role = R("src/models/role.model");
const PermissionGrant = R("src/models/permissionGrant.model");
const Audit = R("src/models/auditEvent.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_tempgrant");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const user = await User.create({ name: "M", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const call = async (m, p, body, headers = IH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json() };
  };
  const gid = (n) => "gid://shopify/Customer/" + n;
  const authorize = (n, permission) => call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: gid(n), permission });
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: gid(name), ...extra });
  const day = 24 * 60 * 60 * 1000;
  const iso = (ms) => new Date(Date.now() + ms).toISOString();

  const agent = await mkc("agent", { role: "sales_agent" });
  const plain = await mkc("plain");
  await call("GET", "/api/roles", null, AH);

  let r = await authorize("agent", "price.override");
  ok("baseline: agent has no price.override", r.j.allowed === false, r);

  const path = `/api/agents/${agent._id}/permission-grants`;
  r = await call("POST", path, { permission: "price.override", validTo: iso(3 * day), reason: "Trade fair", constraints: { maxDeltaPercent: 10 } }, AH);
  ok("temporary grant created, active", r.s === 201 && r.j.status === "active", r);
  const grantId = r.j._id;

  r = await authorize("agent", "price.override");
  ok("agent can now override prices, with the grant's limit", r.j.allowed === true && r.j.constraints.maxDeltaPercent === 10, r);
  r = await authorize("agent", "discount.override");
  ok("other permissions are unaffected", r.j.allowed === false, r);

  // validation
  r = await call("POST", path, { permission: "cart.write", validTo: iso(day), reason: "x" }, AH);
  ok("only high-risk permissions can be granted this way", r.s === 400, r);
  r = await call("POST", path, { permission: "shipping.override", validTo: iso(day) }, AH);
  ok("a reason is required", r.s === 400, r);
  r = await call("POST", path, { permission: "shipping.override", validTo: iso(-day), reason: "x" }, AH);
  ok("end date must be in the future", r.s === 400, r);
  r = await call("POST", path, { permission: "shipping.override", validTo: iso(40 * day), reason: "x" }, AH);
  ok("longer than 30 days refused", r.s === 400, r);
  r = await call("POST", path, { permission: "shipping.override", validTo: "nonsense", reason: "x" }, AH);
  ok("bad date refused", r.s === 400, r);
  r = await call("POST", path, { permission: "price.override", validTo: iso(day), reason: "x", constraints: { maxDeltaPercent: 500 } }, AH);
  ok("limit out of range refused", r.s === 400, r);
  r = await call("POST", path, { permission: "nope", validTo: iso(day), reason: "x" }, AH);
  ok("unknown permission refused", r.s === 400, r);
  r = await call("POST", `/api/agents/${plain._id}/permission-grants`, { permission: "price.override", validTo: iso(day), reason: "x" }, AH);
  ok("can't grant to someone who isn't a sales agent", r.s === 404, r);
  r = await call("POST", path, { permission: "shipping.override", validTo: iso(day), reason: "x" }, IH);
  ok("needs a merchant login", r.s === 401, r);

  // scheduled / expired
  r = await call("POST", path, { permission: "shipping.override", validFrom: iso(day), validTo: iso(2 * day), reason: "Next week's event" }, AH);
  ok("future-dated grant is 'scheduled'", r.s === 201 && r.j.status === "scheduled", r);
  r = await authorize("agent", "shipping.override");
  ok("scheduled grant gives nothing yet", r.j.allowed === false, r);

  await PermissionGrant.updateOne({ _id: grantId }, { $set: { validTo: new Date(Date.now() - 1000) } });
  r = await authorize("agent", "price.override");
  ok("expired grant stops working by itself", r.j.allowed === false, r);

  // revoke
  r = await call("POST", path, { permission: "custom_line.create", validTo: iso(day), reason: "One-off" }, AH);
  const g2 = r.j._id;
  r = await authorize("agent", "custom_line.create");
  ok("second grant works", r.j.allowed === true, r);
  r = await call("DELETE", `${path}/${g2}`, null, AH);
  ok("revoke ends it immediately", r.s === 200 && r.j.status === "revoked", r);
  r = await authorize("agent", "custom_line.create");
  ok("...and access is gone", r.j.allowed === false, r);
  const kept = await PermissionGrant.findById(g2);
  ok("the revoked record is kept as evidence", kept && kept.revokedAt && String(kept.revokedBy) === String(user._id), kept);
  r = await call("DELETE", `${path}/${g2}`, null, AH);
  ok("revoking twice -> 404", r.s === 404, r);

  r = await call("GET", path, null, AH);
  ok("list shows every grant with its status", r.s === 200 && r.j.length === 3 && ["revoked", "expired", "scheduled"].every((s) => r.j.some((g) => g.status === s)), r.j.map((g) => g.status));

  // audit
  ok("creation audited with who/what/why/when", !!(await Audit.findOne({ action: "permission_grant.created", "metadata.permission": "price.override", "metadata.reason": "Trade fair" })));
  ok("revocation audited", !!(await Audit.findOne({ action: "permission_grant.revoked", objectId: g2 })));

  // role-level explicit deny can't be bypassed
  await Role.updateOne({ shop, key: "sales_agent" }, { $push: { permissions: { key: "discount.override", effect: "deny" } } });
  await call("POST", path, { permission: "discount.override", validTo: iso(day), reason: "Try to bypass" }, AH);
  r = await authorize("agent", "discount.override");
  ok("a role's 'always deny' beats a temporary grant", r.j.allowed === false, r);

  // a temporary grant is honoured by real endpoints that check the permission
  await call("POST", path, { permission: "payment_link.send", validTo: iso(day), reason: "Pilot" }, AH);
  r = await authorize("agent", "payment_link.send");
  ok("payment_link.send via grant", r.j.allowed === true, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
