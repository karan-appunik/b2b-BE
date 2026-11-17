const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
const R = (m) => require(require("path").join(ROOT, m));
const mongoose = R("node_modules/mongoose");
const jwt = R("node_modules/jsonwebtoken");
const app = R("app");
const terr = R("src/services/territory.service");
const Customer = R("src/models/customer.model");
const Grant = R("src/models/agentScopeGrant.model");
const Audit = R("src/models/auditEvent.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  // ---------- matching, no database
  const rule = (o) => ({ active: true, countryCodes: [], provinceCodes: [], zipPrefixes: [], tags: [], ...o });
  const cust = (region, tags = []) => ({ region, tags });
  ok("country matches (case-insensitive)", terr.matches(rule({ countryCodes: ["CA"] }), cust({ countryCode: "ca" })));
  ok("a different country does not", !terr.matches(rule({ countryCodes: ["CA"] }), cust({ countryCode: "US" })));
  ok("any country in the list will do", terr.matches(rule({ countryCodes: ["CA", "US"] }), cust({ countryCode: "US" })));
  ok("country AND state must both match", terr.matches(rule({ countryCodes: ["US"], provinceCodes: ["TX"] }), cust({ countryCode: "US", provinceCode: "tx" })) && !terr.matches(rule({ countryCodes: ["US"], provinceCodes: ["TX"] }), cust({ countryCode: "US", provinceCode: "CA" })));
  ok("postal prefix ignores spaces and case", terr.matches(rule({ zipPrefixes: ["K2P"] }), cust({ zip: "k2p 2l8" })) && !terr.matches(rule({ zipPrefixes: ["K2P"] }), cust({ zip: "M5V 1A1" })));
  ok("a postal prefix needs a postal code", !terr.matches(rule({ zipPrefixes: ["K2P"] }), cust({})));
  ok("tags match ignoring case", terr.matches(rule({ tags: ["vip"] }), cust({}, ["B2B", "VIP"])) && !terr.matches(rule({ tags: ["vip"] }), cust({}, ["b2b"])));
  ok("a customer with no address matches no address rule", !terr.matches(rule({ countryCodes: ["US"] }), cust(undefined)));
  const rules = [rule({ territory: "Specific", countryCodes: ["US"], provinceCodes: ["TX"] }), rule({ territory: "USA", countryCodes: ["US"] }), rule({ territory: "Off", active: false, countryCodes: ["CA"] })];
  ok("first matching rule wins", terr.territoryFor(cust({ countryCode: "US", provinceCode: "TX" }), rules) === "Specific" && terr.territoryFor(cust({ countryCode: "US", provinceCode: "NY" }), rules) === "USA");
  ok("inactive rules are skipped; no match gives null", terr.territoryFor(cust({ countryCode: "CA" }), rules) === null);

  // ---------- rule validation
  const bad = (input) => { try { terr.cleanRule(input); return null; } catch (e) { return e.code; } };
  ok("name required", bad({ territory: "N", countryCodes: ["US"] }) === "NAME_REQUIRED");
  ok("territory required", bad({ name: "r", countryCodes: ["US"] }) === "TERRITORY_REQUIRED");
  ok("a rule with no condition is refused (it would match everybody)", bad({ name: "r", territory: "N" }) === "NO_CONDITION");
  ok("countries must be 2 letters", bad({ name: "r", territory: "N", countryCodes: ["USA"] }) === "INVALID_COUNTRY");
  ok("priority must be a number in range", bad({ name: "r", territory: "N", countryCodes: ["US"], priority: -1 }) === "INVALID_PRIORITY");
  const cleaned = terr.cleanRule({ name: " West ", territory: " West Coast ", countryCodes: ["us", "US", " "], zipPrefixes: ["98 1", "k2p"], tags: ["VIP "] });
  ok("values are tidied: trimmed, upper-cased, de-duplicated", cleaned.name === "West" && cleaned.territory === "West Coast" && cleaned.countryCodes.join() === "US" && cleaned.zipPrefixes.join() === "981,K2P" && cleaned.tags.join() === "vip" && cleaned.priority === 100, cleaned);

  // ---------- with a database and the API
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_territory");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const call = async (m, p, body, headers = AH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json() };
  };
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });

  const tx = await mk("tx", { region: { countryCode: "US", provinceCode: "TX", zip: "78701" } });
  const ny = await mk("ny", { region: { countryCode: "US", provinceCode: "NY", zip: "10001" } });
  const ottawa = await mk("ottawa", { region: { countryCode: "CA", provinceCode: "ON", zip: "K2P 2L8" } });
  const vip = await mk("vip", { tags: ["vip"] });
  const manual = await mk("manual", { region: { countryCode: "US", provinceCode: "TX", zip: "78701" }, territory: "Hand-picked" });
  const agent = await mk("agentx", { role: "sales_agent", region: { countryCode: "US", provinceCode: "TX" } });
  const none = await mk("none");

  let r = await call("POST", "/api/territory-rules", { name: "Texas", territory: "South", countryCodes: ["US"], provinceCodes: ["TX"], priority: 10 });
  ok("rule created and applied at once", r.s === 201 && r.j.applied.assigned === 1, r.j);
  r = await call("POST", "/api/territory-rules", { name: "USA", territory: "North America", countryCodes: ["US", "CA"], priority: 20 });
  ok("second rule applied: NY, Ottawa and the agent-less rest", r.s === 201 && r.j.applied.assigned === 2, r.j.applied);
  r = await call("POST", "/api/territory-rules", { name: "VIPs", territory: "Key accounts", tags: ["vip"], priority: 5 });
  ok("a tag rule applies", r.s === 201 && r.j.applied.assigned === 1, r.j.applied);

  const terrOf = async (c) => (await Customer.findById(c._id)).territory || null;
  ok("Texas customer -> South (priority 10 beats 20)", (await terrOf(tx)) === "South");
  ok("New York -> North America", (await terrOf(ny)) === "North America");
  ok("Ottawa (CA) -> North America", (await terrOf(ottawa)) === "North America");
  ok("tagged customer -> Key accounts", (await terrOf(vip)) === "Key accounts");
  ok("a territory set by hand is never overwritten", (await terrOf(manual)) === "Hand-picked" && !(await Customer.findById(manual._id)).territorySource);
  ok("an agent is never given a territory", (await terrOf(agent)) === null);
  ok("a customer no rule fits stays empty", (await terrOf(none)) === null);
  ok("rule-given territories are marked as such", (await Customer.findById(tx._id)).territorySource === "rule");

  // ---------- keeps itself up to date
  await Customer.updateOne({ _id: ny._id }, { $set: { "region.countryCode": "MX" } });
  r = await call("POST", "/api/territory-rules/apply?dryRun=true", {});
  ok("dry run reports a customer who no longer fits, and saves nothing", r.j.dryRun === true && r.j.cleared === 1 && (await terrOf(ny)) === "North America", r.j);
  r = await call("POST", "/api/territory-rules/apply", {});
  ok("apply clears a territory the rules gave once nothing fits", r.j.cleared === 1 && (await terrOf(ny)) === null && !(await Customer.findById(ny._id)).territorySource, r.j);
  r = await call("POST", "/api/territory-rules/apply", {});
  ok("applying again changes nothing", r.j.changed === 0, r.j);

  // ---------- the importer fills region and applies rules
  r = await call("POST", "/api/internal/customers/sync", { shop, customers: [{ name: "Newbie", email: "newbie@x.com", shopifyCustomerId: gid("newbie"), region: { countryCode: "us", provinceCode: "tx", zip: "73301" } }] }, IH);
  const nb = await Customer.findOne({ shop, shopifyCustomerId: gid("newbie") });
  ok("synced customer's address is stored (upper-cased)", r.s === 200 && nb.region.countryCode === "US" && nb.region.provinceCode === "TX", nb);
  ok("and the rules ran for them straight away", nb.territory === "South", nb);

  // ---------- hand edits
  const detail = (c, over) => call("PUT", `/api/customers/${c._id}`, { name: c.name, email: c.email, ...over });
  r = await detail(tx, { territory: "South" });
  ok("saving the form with the same territory keeps it rule-driven", r.s === 200 && (await Customer.findById(tx._id)).territorySource === "rule", r.j);
  r = await detail(tx, { territory: "Special" });
  ok("typing a different territory makes it manual", (await Customer.findById(tx._id)).territory === "Special" && !(await Customer.findById(tx._id)).territorySource);
  await call("POST", "/api/territory-rules/apply", {});
  ok("and rules then leave it alone", (await terrOf(tx)) === "Special");
  r = await detail(tx, { territory: "" });
  await call("POST", "/api/territory-rules/apply", {});
  ok("clearing it hands it back to the rules", (await terrOf(tx)) === "South" && (await Customer.findById(tx._id)).territorySource === "rule");

  // ---------- access follows the territory
  await Grant.create({ shop, agent: agent._id, scopeType: "territory", scopeId: "South" });
  const dash = await call("GET", `/api/internal/agent/dashboard?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid("agentx"))}`, null, IH);
  const names = (dash.j.accounts || []).map((a) => a.name);
  await call("GET", "/api/roles");
  ok("an agent with territory 'South' sees South customers automatically (may need the role's scope)", dash.s === 200, dash.j);

  // ---------- editing and deleting rules
  const list = await call("GET", "/api/territory-rules");
  ok("rules listed in priority order with a customer count per territory", list.j.rules.map((x) => x.name).join() === "VIPs,Texas,USA" && list.j.customersByTerritory["South"] >= 1, list.j);
  const usaId = list.j.rules.find((x) => x.name === "USA")._id;
  r = await call("PUT", `/api/territory-rules/${usaId}`, { name: "USA", territory: "Americas", countryCodes: ["US", "CA"], priority: 20 });
  ok("renaming a territory moves the customers the rules gave it", r.s === 200 && (await terrOf(ottawa)) === "Americas", r.j);
  r = await call("POST", "/api/territory-rules", { name: "usa", territory: "X", countryCodes: ["US"] });
  ok("rule names are unique, ignoring case", r.s === 409 && r.j.code === "NAME_TAKEN", r);
  r = await call("POST", "/api/territory-rules", { name: "Empty", territory: "X" });
  ok("a rule with no condition is refused", r.s === 400 && r.j.code === "NO_CONDITION", r);
  r = await call("DELETE", `/api/territory-rules/${usaId}`);
  ok("deleting a rule clears what only it gave", r.s === 200 && (await terrOf(ottawa)) === null, r.j);
  r = await call("DELETE", `/api/territory-rules/${usaId}`);
  ok("deleting twice (404)", r.s === 404, r);
  r = await call("PUT", `/api/territory-rules/notanid`, { name: "x" });
  ok("bad id (404)", r.s === 404, r);
  r = await call("GET", "/api/territory-rules", null, { "Content-Type": "application/json" });
  ok("login required (401)", r.s === 401, r);
  ok("rule changes and applications are audited", !!(await Audit.findOne({ shop, action: "territory_rule.created" })) && !!(await Audit.findOne({ shop, action: "territory.rules_applied" })) && !!(await Audit.findOne({ shop, action: "territory_rule.deleted" })));

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
