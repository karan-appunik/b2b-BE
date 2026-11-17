const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
const R = (m) => require(require("path").join(ROOT, m));
const mongoose = R("node_modules/mongoose");
const jwt = R("node_modules/jsonwebtoken");
const app = R("app");
const User = R("src/models/user.model");
const Customer = R("src/models/customer.model");
const Order = R("src/models/order.model");
const Outbox = R("src/models/outboxEvent.model");
const { agentPseudonym } = R("src/services/pseudonym.service");
const { emitEvent } = R("src/services/outbox.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_pseudo");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const user = await User.create({ name: "M", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const get = async (p) => { const r = await fetch(base + p, { headers: AH }); return { s: r.status, j: await r.json().catch(() => null) }; };
  const agent = await Customer.create({ name: "Real Name", email: "real@x.com", shop, shopifyCustomerId: "gid://shopify/Customer/1", role: "sales_agent" });
  const buyer = await Customer.create({ name: "Buyer", email: "b@x.com", shop, shopifyCustomerId: "gid://shopify/Customer/2" });
  await Order.collection.insertOne({ shop, shopifyOrderId: "1", name: "#1", shopifyCustomerId: "gid://shopify/Customer/2", totalPrice: 100, currency: "USD", orderedAt: new Date(), source: "sales_agent", placedByAgent: { agent: agent._id } });

  const p1 = agentPseudonym(shop, agent._id);
  ok("a code looks like agt_ and 12 characters", /^agt_[0-9a-f]{12}$/.test(p1), p1);
  ok("the same agent always gets the same code", p1 === agentPseudonym(shop, String(agent._id)));
  ok("another agent gets another code", p1 !== agentPseudonym(shop, buyer._id));
  ok("another shop gets another code for the same agent", p1 !== agentPseudonym("other.myshopify.com", agent._id));
  ok("the code does not contain the id or the name", !p1.includes(String(agent._id).slice(0, 8)) && !/real/i.test(p1));

  let r = await get("/api/reports/sales-agents?groupBy=agent");
  ok("a normal report names the agent", r.s === 200 && JSON.stringify(r.j).includes("Real Name"), r.j);
  r = await get("/api/reports/sales-agents?groupBy=agent&pseudonymous=true");
  const text = JSON.stringify(r.j);
  ok("a pseudonymous report names only the code", r.s === 200 && text.includes(p1) && !text.includes("Real Name") && !text.includes(String(agent._id)), text.slice(0, 300));
  ok("the totals are the same", /100/.test(text));

  await emitEvent(shop, "order.created", { order_id: "9", sales_agent_id: String(agent._id) });
  const ev = await Outbox.findOne({ "payload.order_id": "9" });
  ok("events carry the code next to the id", ev.payload.agent_pseudonym === p1 && ev.payload.sales_agent_id === String(agent._id), ev.payload);
  await emitEvent(shop, "system.ping", { n: 1 });
  ok("events without an agent carry no code", !(await Outbox.findOne({ "payload.n": 1 })).payload.agent_pseudonym);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  process.exit(fail ? 1 : 0);
})();
