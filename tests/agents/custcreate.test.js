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
const Outbox = R("src/models/outboxEvent.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_custcreate");
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
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: gid(name.length ? Math.abs([...name].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) : 1), ...extra });
  const A = (aid, extra = {}) => ({ shop, agentShopifyCustomerId: aid, ...extra });

  await call("GET", "/api/roles", null, AH);
  await call("POST", "/api/roles", { name: "Secure Creator", requireMfa: true, permissions: [{ key: "customer.search" }, { key: "customer.create" }, { key: "address.create" }, { key: "customer.context.enter", constraints: { scope: "all" } }] }, AH);

  const admin = await mkc("adminx", { role: "sales_admin" });
  const rep = await mkc("repx", { role: "sales_agent" });
  const secure = await mkc("securex", { role: "secure_creator" });
  const existing = await mkc("existing", { company: "Acme Trading Co.", phone: "+1 (555) 010-2000", taxId: "TX-99" });

  const input = (over = {}) => ({
    companyName: "Brightside Foods", firstName: "Ana", lastName: "Lopez", email: "ana@brightside.com", phone: "+1 555 777 8888",
    taxId: "TX-1", legalEntity: "Brightside Foods LLC", consent: true, marketingConsent: false,
    address: { address1: "1 Market St", city: "Austin", zip: "78701", provinceCode: "TX", countryCode: "us" }, ...over,
  });
  const CHECK = "/api/internal/agent/customers/check";
  const REC = "/api/internal/agent/customers/record";

  // ---- permission
  let r = await call("POST", CHECK, A(admin.shopifyCustomerId, { customer: input() }));
  ok("administrator may create", r.s === 200 && r.j.ok && r.j.tags[0] === "provisional", r);
  r = await call("POST", CHECK, A(rep.shopifyCustomerId, { customer: input() }));
  ok("sales agent role may not", r.s === 403 && r.j.code === "PERMISSION_DENIED", r);
  r = await call("POST", CHECK, A(secure.shopifyCustomerId, { customer: input() }));
  ok("MFA role needs step-up first", r.s === 403 && r.j.code === "STEP_UP_REQUIRED", r);
  r = await call("POST", CHECK, { shop, agentShopifyCustomerId: gid("ghost"), customer: input() });
  ok("not an agent -> 403", r.s === 403, r);
  ok("denials audited", (await Audit.countDocuments({ shop, action: "customer.create_denied" })) >= 2);

  // ---- validation
  r = await call("POST", CHECK, A(admin.shopifyCustomerId, { customer: input({ companyName: "", email: "bad", consent: false, address: { address1: "", city: "", zip: "", countryCode: "USA" } }) }));
  const f = r.j.fields || {};
  ok("all mandatory fields reported", r.s === 400 && r.j.code === "VALIDATION" && f.companyName && f.email && f.consent && f.address1 && f.city && f.zip && f.countryCode, r);
  r = await call("POST", CHECK, A(admin.shopifyCustomerId, { customer: input({ consent: "yes" }) }));
  ok("consent must be exactly true", r.s === 400 && r.j.fields.consent, r);

  // ---- duplicates
  r = await call("POST", CHECK, A(admin.shopifyCustomerId, { customer: input({ email: "EXISTING@x.com" }) }));
  ok("same email blocked, no override", r.s === 409 && r.j.code === "DUPLICATE_EMAIL", r);
  r = await call("POST", CHECK, A(admin.shopifyCustomerId, { customer: input({ email: "x@y.com" }), confirmNotDuplicate: true }));
  ok("confirm flag does not bypass duplicate email? (different email passes)", r.s === 200, r);
  r = await call("POST", CHECK, A(admin.shopifyCustomerId, { customer: input({ email: "dup@x.com" }), confirmNotDuplicate: true }));
  r = await call("POST", CHECK, A(admin.shopifyCustomerId, { customer: input({ email: "existing@x.com" }), confirmNotDuplicate: true }));
  ok("exact email still blocked with confirm flag", r.s === 409 && r.j.code === "DUPLICATE_EMAIL", r);

  r = await call("POST", CHECK, A(admin.shopifyCustomerId, { customer: input({ companyName: "ACME trading", email: "n1@z.com", phone: "", taxId: "" }) }));
  ok("similar company name warns (suffix/case ignored)", r.s === 409 && r.j.code === "POSSIBLE_DUPLICATE" && r.j.duplicates[0].reasons.includes("Same company name"), r);
  ok("warning shows only a masked email", /^e\*+@x\.com$/.test(r.j.duplicates[0].email) && !JSON.stringify(r.j).includes("existing@x.com"), r.j);
  r = await call("POST", CHECK, A(admin.shopifyCustomerId, { customer: input({ email: "n2@z.com", phone: "555-010-2000" }) }));
  ok("same phone digits warns", r.s === 409 && r.j.duplicates[0].reasons.includes("Same phone number"), r);
  r = await call("POST", CHECK, A(admin.shopifyCustomerId, { customer: input({ email: "n3@z.com", taxId: "tx-99" }) }));
  ok("same tax id warns", r.s === 409 && r.j.duplicates[0].reasons.includes("Same tax ID"), r);
  r = await call("POST", CHECK, A(admin.shopifyCustomerId, { customer: input({ companyName: "Acme Trading", email: "n4@z.com" }), confirmNotDuplicate: true }));
  ok("agent can confirm it is a different business", r.s === 200 && r.j.duplicatesConfirmed === true, r);

  // ---- record
  const newGid = gid(777001);
  r = await call("POST", REC, A(admin.shopifyCustomerId, { shopifyCustomerId: newGid, customer: input(), duplicatesConfirmed: false }));
  ok("record creates provisional customer", r.s === 201 && r.j.provisional === true, r);
  const c = await Customer.findOne({ shop, shopifyCustomerId: newGid });
  ok("fields stored, country upper-cased, tag applied", c.company === "Brightside Foods" && c.name === "Ana Lopez" && c.addresses[0].country === "US" && c.tags.includes("provisional") && c.consent.dataProcessing === true && c.role === "customer", c);
  ok("creator is attributed", String(c.createdByAgent) === String(admin._id));
  ok("creator is granted access to this customer only", !!(await Grant.findOne({ shop, agent: admin._id, scopeType: "customer", scopeId: String(c._id) })));
  ok("creation audited + event queued, no context opened", !!(await Audit.findOne({ shop, action: "customer.created", objectId: String(c._id) })) && (await Outbox.countDocuments({ shop, type: "sales_agent.customer.created" })) === 1 && !(await Audit.findOne({ shop, action: "context.entered" })));
  r = await call("POST", REC, A(admin.shopifyCustomerId, { shopifyCustomerId: newGid, customer: input() }));
  ok("recording twice is harmless (one grant, one event, one audit)", r.s === 201 && (await Grant.countDocuments({ shop, agent: admin._id, scopeId: String(c._id) })) === 1 && (await Outbox.countDocuments({ shop, type: "sales_agent.customer.created" })) === 1 && (await Audit.countDocuments({ shop, action: "customer.created" })) === 1);
  r = await call("POST", REC, A(rep.shopifyCustomerId, { shopifyCustomerId: gid(777002), customer: input({ email: "q@q.com" }) }));
  ok("record also checks permission", r.s === 403, r);
  r = await call("POST", REC, A(admin.shopifyCustomerId, { shopifyCustomerId: "nope", customer: input({ email: "q2@q.com" }) }));
  ok("bad shopify id rejected", r.s === 400 && r.j.code === "INVALID_CUSTOMER", r);

  // ---- first-order context is a separate step
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: admin.shopifyCustomerId, customerId: String(c._id) });
  ok("creator can enter the new customer as a separate step", r.s === 201 || r.s === 200, r);
  const ctxId = r.j.contextId;

  // ---- provisional ordering hold
  r = await call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: admin.shopifyCustomerId, contextId: ctxId, permission: "order.submit" });
  ok("ordering allowed by default for provisional", r.j.allowed === true, r);
  r = await call("PUT", "/api/agent-settings", { provisionalOrdering: "block", newCustomerTags: ["provisional", "trade-show"], requireTaxId: true }, AH);
  ok("settings saved", r.s === 200 && r.j.provisionalOrdering === "block" && r.j.newCustomerTags.length === 2 && r.j.requireTaxId === true, r);
  r = await call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: admin.shopifyCustomerId, contextId: ctxId, permission: "order.submit" });
  ok("blocked while provisional", r.j.allowed === false && r.j.reason === "ACCOUNT_PENDING_APPROVAL", r);
  r = await call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: admin.shopifyCustomerId, contextId: ctxId, permission: "quote.create" });
  ok("other actions are not held", r.j.allowed === true, r);
  r = await call("POST", CHECK, A(admin.shopifyCustomerId, { customer: input({ email: "t1@z.com", taxId: "" }) }));
  ok("tax id required when the setting says so", r.s === 400 && r.j.fields.taxId, r);
  r = await call("PUT", "/api/agent-settings", { provisionalOrdering: "maybe" }, AH);
  ok("bad ordering value rejected", r.s === 400, r);

  // ---- merchant approval
  r = await call("GET", "/api/provisional-customers", null, AH);
  ok("merchant sees provisional customers with creator", r.s === 200 && r.j.customers.length === 1 && r.j.customers[0].createdBy === "adminx", r);
  r = await call("GET", "/api/provisional-customers", null, { "Content-Type": "application/json" });
  ok("needs login", r.s === 401, r);
  r = await call("POST", `/api/provisional-customers/${c._id}/approve`, {}, AH);
  ok("merchant approves", r.s === 200, r);
  r = await call("POST", "/api/internal/agent/authorize", { shop, agentShopifyCustomerId: admin.shopifyCustomerId, contextId: ctxId, permission: "order.submit" });
  ok("ordering allowed after approval", r.j.allowed === true, r);
  r = await call("POST", `/api/provisional-customers/${c._id}/approve`, {}, AH);
  ok("approving again -> 404", r.s === 404, r);
  ok("approval audited", !!(await Audit.findOne({ shop, action: "customer.approved" })));

  // ---- address audit
  const ADDR = "/api/internal/agent/addresses/record";
  r = await call("POST", ADDR, A(admin.shopifyCustomerId, { contextId: ctxId, address: { city: "Austin", country: "US", setDefault: true } }));
  ok("address creation audited", r.s === 201 && !!(await Audit.findOne({ shop, action: "address.created", "metadata.city": "Austin" })), r);
  r = await call("POST", ADDR, A(admin.shopifyCustomerId, { contextId: "bogus", address: {} }));
  ok("bogus context rejected", r.s === 403, r);
  await call("POST", "/api/roles", { name: "No Addr", permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "all" } }] }, AH);
  const noaddr = await mkc("noaddr", { role: "no_addr" });
  const ctx2 = (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: noaddr.shopifyCustomerId, customerId: String(c._id) })).j.contextId;
  r = await call("POST", ADDR, A(noaddr.shopifyCustomerId, { contextId: ctx2, address: { city: "X" } }));
  ok("role without address.create is denied", r.s === 403 && r.j.code === "PERMISSION_DENIED", r);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
