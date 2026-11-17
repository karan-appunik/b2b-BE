const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
delete process.env.AGENT_MFA_DEFAULT; // the real default: MFA on for sales roles
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
process.env.SMTP_HOST = "stub";
const R = (m) => require(require("path").join(ROOT, m));
const nodemailer = R("node_modules/nodemailer");
const sent = [];
let failMail = false;
nodemailer.createTransport = () => ({
  sendMail: async (m) => { if (failMail) throw new Error("smtp down"); sent.push(m); },
});
const mongoose = R("node_modules/mongoose");
const jwt = R("node_modules/jsonwebtoken");
const app = R("app");
const Customer = R("src/models/customer.model");
const Grant = R("src/models/agentScopeGrant.model");
const Role = R("src/models/role.model");
const User = R("src/models/user.model");
const totp = R("src/services/totp.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_onboard");
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
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: gid(name), ...extra });

  // ---- MFA is on by default for the built-in sales roles
  let r = await call("GET", "/api/roles?all=true", null, AH);
  ok("all three built-in roles require MFA out of the box", r.j.roles.length === 3 && r.j.roles.every((x) => x.requireMfa === true), r.j.roles.map((x) => [x.key, x.requireMfa]));

  // ---- onboarding: giving someone a sales role
  const newbie = await mkc("newbie");
  const custA = await mkc("custA");
  r = await call("PUT", `/api/customers/${newbie._id}`, { role: "sales_agent" }, AH);
  ok("role assigned", r.s === 200 && r.j.role === "sales_agent", r);
  await sleep(150);
  ok("an access email goes to the new agent", sent.length === 1 && sent[0].to === "newbie@x.com", sent.map((m) => m.to));
  const mail = sent[0];
  ok("it names the role and links the portal on their store", /Sales agent/.test(mail.html) && mail.html.includes("https://t.myshopify.com/apps/sparklayer/agent-portal"), mail.html);
  ok("it explains that MFA setup activates access", /authenticator/i.test(mail.html) && /6-digit/.test(mail.html), mail.html);
  ok("it never contains a password", !/password/i.test(mail.html) || /never/i.test(mail.html) === false && !/your password is|temporary password/i.test(mail.html), mail.html);

  // access really is gated on MFA until it is set up
  await Grant.create({ shop, agent: newbie._id, scopeType: "customer", scopeId: String(custA._id) });
  const enter = () => call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("newbie"), customerId: String(custA._id) });
  r = await enter();
  ok("until MFA is set up, the new agent can't act for anyone", r.s === 403 && r.j.code === "MFA_REQUIRED", r);
  r = await call("POST", "/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: gid("newbie") });
  const secret = r.j.secret;
  r = await call("POST", "/api/internal/agent/mfa/verify", { shop, agentShopifyCustomerId: gid("newbie"), code: totp.codeForStep(secret, totp.stepAt(Date.now())), purpose: "session" });
  ok("setting up the authenticator succeeds", r.s === 200 && r.j.enrolled === true, r);
  r = await enter();
  ok("and then access is active", r.s === 201, r);

  // ---- no email when nothing about access changed
  const before = sent.length;
  await call("PUT", `/api/customers/${newbie._id}`, { role: "sales_manager" }, AH);
  await call("PUT", `/api/customers/${newbie._id}`, { name: "newbie", company: "Acme" }, AH);
  await sleep(150);
  ok("moving between sales roles / editing details sends no new access email", sent.length === before, sent.length - before);

  // ---- failures and missing SMTP never break the role change
  failMail = true;
  const rep2 = await mkc("rep2");
  r = await call("PUT", `/api/customers/${rep2._id}`, { role: "sales_admin" }, AH);
  await sleep(150);
  ok("a mail failure does not fail the role change", r.s === 200 && r.j.role === "sales_admin", r);
  failMail = false;
  delete process.env.SMTP_HOST;
  const rep3 = await mkc("rep3");
  r = await call("PUT", `/api/customers/${rep3._id}`, { role: "sales_agent" }, AH);
  ok("without SMTP the role change still works (email just skipped)", r.s === 200, r);
  process.env.SMTP_HOST = "stub";

  // ---- demoting to customer sends nothing
  const n = sent.length;
  await call("PUT", `/api/customers/${rep2._id}`, { role: "customer" }, AH);
  await sleep(100);
  ok("demoting back to customer sends no access email", sent.length === n);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
