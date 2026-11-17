const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
const R = (m) => require(require("path").join(ROOT, m));
const mongoose = R("node_modules/mongoose");
const Role = R("src/models/role.model");
const Customer = R("src/models/customer.model");
const { ensureSystemRoles, getRole, evaluate } = R("src/services/role.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_migrate");
  await mongoose.connection.dropDatabase();

  const oldRole = (shop) => ({
    shop,
    key: "external_sales_rep",
    name: "External Sales Representative",
    isSystem: true,
    permissions: [
      { key: "customer.search", effect: "allow" },
      { key: "quote.create", effect: "allow" },
    ],
  });

  // shop A: someone still holds the old built-in role
  await Role.create(oldRole("a.myshopify.com"));
  await Customer.create({ name: "rep", email: "rep@x.com", shop: "a.myshopify.com", shopifyCustomerId: "gid://shopify/Customer/1", role: "external_sales_rep" });
  // shop B: nobody holds it
  await Role.create(oldRole("b.myshopify.com"));

  await ensureSystemRoles("a.myshopify.com");
  await ensureSystemRoles("b.myshopify.com");

  const a = await Role.findOne({ shop: "a.myshopify.com", key: "external_sales_rep" });
  ok("in-use old built-in becomes a custom role (kept)", a && a.isSystem === false, a);
  const role = await getRole("a.myshopify.com", "external_sales_rep");
  ok("its permissions still work for the person who has it", evaluate(role, "quote.create").allowed && !evaluate(role, "order.submit").allowed, role);

  const b = await Role.findOne({ shop: "b.myshopify.com", key: "external_sales_rep" });
  ok("unused old built-in is removed", b === null, b);

  const keysA = (await Role.find({ shop: "a.myshopify.com", isSystem: true })).map((r) => r.key).sort();
  ok("both shops now have exactly the 3 spec roles as built-ins", keysA.join() === "sales_admin,sales_agent,sales_manager", keysA);
  const keysB = (await Role.find({ shop: "b.myshopify.com", isSystem: true })).map((r) => r.key).sort();
  ok("shop B too", keysB.join() === "sales_admin,sales_agent,sales_manager", keysB);

  await ensureSystemRoles("a.myshopify.com");
  ok("running again changes nothing", (await Role.countDocuments({ shop: "a.myshopify.com" })) === 4);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
