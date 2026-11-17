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
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_shoplist");
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
  const LS = "/api/internal/shopping-lists";
  const q = (actor, cust) => `?shop=${shop}&actorShopifyCustomerId=${encodeURIComponent(gid(actor))}` + (cust ? `&customerShopifyCustomerId=${encodeURIComponent(gid(cust))}` : "");
  const body = (actor, cust, extra = {}) => ({ shop, actorShopifyCustomerId: gid(actor), customerShopifyCustomerId: cust ? gid(cust) : undefined, ...extra });
  const items = [{ variantId: "111", quantity: 5, title: "Bracelet", sku: "B-1" }, { variantId: "222", quantity: 2 }];

  await call("GET", "/api/roles", null, AH);
  await call("POST", "/api/roles", { name: "Viewer", permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }] }, AH);

  const rep = await mkc("rep", { role: "sales_agent" });
  const viewer = await mkc("viewer", { role: "viewer" });
  const outsider = await mkc("outsider", { role: "sales_agent" });
  const custA = await mkc("custA");
  const custB = await mkc("custB");
  for (const a of [rep, viewer]) await Grant.create({ shop, agent: a._id, scopeType: "customer", scopeId: String(custA._id) });

  // ---- a customer's own lists
  let r = await call("POST", LS, body("custA", null, { name: "Weekly restock", items }));
  ok("customer saves their own list", r.s === 201 && r.j.name === "Weekly restock" && r.j.itemCount === 2 && r.j.createdByAgent === false, r);
  const own = r.j.id;
  r = await call("GET", LS + q("custA"));
  ok("and sees it", r.s === 200 && r.j.lists.length === 1 && r.j.lists[0].items[0].sku === "B-1", r);
  r = await call("GET", LS + q("custB"));
  ok("another customer sees none of it", r.j.lists.length === 0, r);
  r = await call("GET", LS + q("custB", "custA"));
  ok("another customer can't ask for it either (404)", r.s === 404, r);

  // ---- an agent for a customer
  r = await call("POST", LS, body("rep", "custA", { name: "Trade show picks", items }));
  ok("agent with access saves a list for the customer", r.s === 201 && r.j.createdByAgent === true, r);
  const byAgent = r.j.id;
  r = await call("GET", LS + q("custA"));
  ok("the customer sees the agent's list too", r.j.lists.length === 2, r);
  r = await call("GET", LS + q("rep", "custA"));
  ok("the agent sees the customer's lists", r.j.lists.length === 2, r);
  ok("agent's action is audited", !!(await Audit.findOne({ shop, action: "shopping_list.created", objectId: byAgent })));
  r = await call("POST", LS, body("outsider", "custA", { name: "Nope", items }));
  ok("an agent without access can't (404, no hint)", r.s === 404, r);
  r = await call("POST", LS, body("viewer", "custA", { name: "Nope", items }));
  ok("an agent whose role can't change carts is refused (403)", r.s === 403 && r.j.code === "PERMISSION_DENIED", r);
  r = await call("GET", LS + q("viewer", "custA"));
  ok("but may read the lists", r.s === 200 && r.j.lists.length === 2, r);
  r = await call("GET", LS + q("rep", "custB"));
  ok("an agent can't read a customer outside their access (404)", r.s === 404, r);
  r = await call("POST", LS, body("custB", "custA", { name: "Sneaky", items }));
  ok("an ordinary customer can't write to someone else's lists (404)", r.s === 404, r);
  r = await call("POST", LS, { shop, actorShopifyCustomerId: gid("ghost"), name: "X", items });
  ok("unknown user (404)", r.s === 404, r);

  // ---- validation
  r = await call("POST", LS, body("custA", null, { name: "  ", items }));
  ok("a name is required", r.s === 400 && r.j.code === "NAME_REQUIRED", r);
  r = await call("POST", LS, body("custA", null, { name: "x".repeat(81), items }));
  ok("name up to 80 characters", r.s === 400 && r.j.code === "NAME_TOO_LONG", r);
  r = await call("POST", LS, body("custA", null, { name: "weekly RESTOCK", items }));
  ok("names are unique per customer, ignoring case", r.s === 409 && r.j.code === "NAME_TAKEN", r);
  r = await call("POST", LS, body("custA", null, { name: "Empty", items: [] }));
  ok("a list needs items", r.s === 400 && r.j.code === "EMPTY", r);
  r = await call("POST", LS, body("custA", null, { name: "Bad qty", items: [{ variantId: "1", quantity: 0 }] }));
  ok("quantity must be 1 or more", r.s === 400 && r.j.code === "INVALID_ITEM", r);
  r = await call("POST", LS, body("custA", null, { name: "Bad id", items: [{ variantId: "abc", quantity: 1 }] }));
  ok("variant id must be numeric", r.s === 400 && r.j.code === "INVALID_ITEM", r);
  r = await call("POST", LS, body("custA", null, { name: "Big", items: Array.from({ length: 201 }, (_, i) => ({ variantId: String(i + 1), quantity: 1 })) }));
  ok("up to 200 items", r.s === 400 && r.j.code === "TOO_MANY", r);
  r = await call("POST", LS, body("custA", null, { name: "Dups", items: [{ variantId: "9", quantity: 2 }, { variantId: "9", quantity: 3 }] }));
  ok("the same item twice is added together", r.s === 201 && r.j.items.length === 1 && r.j.items[0].quantity === 5, r);

  // ---- deleting
  r = await call("POST", `${LS}/${own}/delete`, body("custB", null));
  ok("someone else can't delete it (404)", r.s === 404, r);
  r = await call("POST", `${LS}/${byAgent}/delete`, body("viewer", "custA"));
  ok("a role that can't change carts can't delete (403)", r.s === 403, r);
  r = await call("POST", `${LS}/${byAgent}/delete`, body("rep", "custA"));
  ok("agent deletes with access", r.s === 200, r);
  ok("deletion by the agent is audited", !!(await Audit.findOne({ shop, action: "shopping_list.deleted", objectId: byAgent })));
  r = await call("POST", `${LS}/${own}/delete`, body("custA", null));
  ok("customer deletes their own", r.s === 200, r);
  r = await call("POST", `${LS}/${own}/delete`, body("custA", null));
  ok("deleting twice (404)", r.s === 404, r);
  r = await call("POST", `${LS}/notanid/delete`, body("custA", null));
  ok("a bad id (404)", r.s === 404, r);

  // ---- limit on how many
  for (let i = 0; i < 50; i++) await call("POST", LS, body("custB", null, { name: "L" + i, items }));
  r = await call("POST", LS, body("custB", null, { name: "L51", items }));
  ok("at most 50 lists per customer", r.s === 400 && r.j.code === "TOO_MANY_LISTS", r);
  r = await call("POST", LS, { shop, actorShopifyCustomerId: gid("custA"), name: "no key" , items }, { "Content-Type": "application/json" });
  ok("internal key is required (401)", r.s === 401, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
