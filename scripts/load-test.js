// A load test for the sales agent endpoints (spec §13 performance gate).
//
//   node scripts/load-test.js            (25 at once, 400 requests per scenario)
//   CONCURRENCY=50 REQUESTS=1000 CUSTOMERS=20000 node scripts/load-test.js
//
// It starts the app in this process against its own throwaway database
// (LOAD_TEST_DB, default sparklayer_loadtest), fills it with customers and
// agents, runs each scenario and prints how long requests took. It drops that
// database when it finishes and refuses to run against anything else.

process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "load";
process.env.JWT_SECRET = "load";

const path = require("path");
const root = path.join(__dirname, "..");
const mongoose = require(path.join(root, "node_modules/mongoose"));
const jwt = require(path.join(root, "node_modules/jsonwebtoken"));
const app = require(path.join(root, "app"));
const User = require(path.join(root, "src/models/user.model"));
const Customer = require(path.join(root, "src/models/customer.model"));
const Grant = require(path.join(root, "src/models/agentScopeGrant.model"));

const URI = process.env.MONGODB_TEST_URI || "mongodb://localhost:27017";
const DB = process.env.LOAD_TEST_DB || "sparklayer_loadtest";
const CONCURRENCY = Number(process.env.CONCURRENCY) || 25;
const REQUESTS = Number(process.env.REQUESTS) || 400;
const CUSTOMERS = Number(process.env.CUSTOMERS) || 5000;
const AGENTS = Number(process.env.AGENTS) || 20;

if (!/load|test/i.test(DB)) {
  console.error(`Refusing to use "${DB}": a load test database name has to contain "load" or "test".`);
  process.exit(1);
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function run(name, makeRequest) {
  const times = [];
  let failed = 0;
  let next = 0;

  async function worker() {
    while (next < REQUESTS) {
      const i = next++;
      const started = process.hrtime.bigint();
      try {
        const res = await makeRequest(i);
        if (res.status >= 500) failed += 1;
      } catch {
        failed += 1;
      }
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
  }

  const began = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = (Date.now() - began) / 1000;
  times.sort((a, b) => a - b);

  const row = {
    scenario: name,
    requests: times.length,
    "per second": Math.round(times.length / seconds),
    "p50 ms": Math.round(pct(times, 50)),
    "p95 ms": Math.round(pct(times, 95)),
    "p99 ms": Math.round(pct(times, 99)),
    errors: failed,
  };
  console.log(`  done: ${name} - p95 ${row["p95 ms"]} ms, ${row.errors} errors`);
  return row;
}

(async () => {
  await mongoose.connect(`${URI}/${DB}`);
  await mongoose.connection.dropDatabase();

  const shop = "load.myshopify.com";
  const user = await User.create({ name: "Load", email: "load@x.com", password: "x", shop });
  const token = jwt.sign({ id: user._id }, "load");

  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const merchant = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const internal = { "x-internal-api-key": "load", "Content-Type": "application/json" };

  await fetch(`${base}/api/roles`, { headers: merchant }); // creates the built-in roles

  console.log(`Seeding ${CUSTOMERS} customers and ${AGENTS} agents...`);
  const territories = ["North", "South", "East", "West"];
  await Customer.insertMany(
    Array.from({ length: CUSTOMERS }, (_, i) => ({
      name: `Customer ${i}`,
      email: `c${i}@example.com`,
      company: `Company ${i % 500}`,
      shop,
      shopifyCustomerId: `gid://shopify/Customer/${1000 + i}`,
      territory: territories[i % 4],
      phone: `+1555${String(1000000 + i)}`,
    })),
    { ordered: false }
  );
  const agents = await Customer.insertMany(
    Array.from({ length: AGENTS }, (_, i) => ({
      name: `Agent ${i}`,
      email: `agent${i}@example.com`,
      shop,
      shopifyCustomerId: `gid://shopify/Customer/${i + 1}`,
      role: i % 5 === 0 ? "sales_manager" : "sales_agent",
    }))
  );
  await Grant.insertMany(agents.map((a, i) => ({ shop, agent: a._id, scopeType: "territory", scopeId: territories[i % 4], effect: "allow" })));
  const someCustomers = await Customer.find({ shop, role: "customer" }).limit(200).select("_id territory").lean();

  const agentGid = (i) => `gid://shopify/Customer/${(i % AGENTS) + 1}`;
  const rows = [];

  rows.push(await run("health check", () => fetch(`${base}/api/health`)));
  rows.push(await run("merchant: customer list", () => fetch(`${base}/api/customers`, { headers: merchant })));
  rows.push(await run("merchant: customer search", (i) => fetch(`${base}/api/customers?search=Company%20${i % 500}`, { headers: merchant })));
  rows.push(await run("merchant: agents overview", () => fetch(`${base}/api/agents/overview`, { headers: merchant })));
  rows.push(await run("merchant: agent report", () => fetch(`${base}/api/reports/sales-agents?groupBy=agent`, { headers: merchant })));
  rows.push(await run("merchant: audit log page", () => fetch(`${base}/api/audit`, { headers: merchant })));
  rows.push(
    await run("agent: customer search", (i) =>
      fetch(`${base}/api/internal/agent/customers?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(agentGid(i))}&search=Company%20${i % 500}`, { headers: internal })
    )
  );
  rows.push(
    await run("agent: enter customer (writes context + audit)", (i) => {
      const c = someCustomers[i % someCustomers.length];
      const a = i % AGENTS;
      // The agent's territory decides which customers they may enter.
      const tIndex = territories.indexOf(c.territory);
      const matching = tIndex === a % 4 ? agentGid(a) : agentGid(tIndex);
      return fetch(`${base}/api/internal/agent/contexts`, {
        method: "POST",
        headers: internal,
        body: JSON.stringify({ shop, agentShopifyCustomerId: matching, customerId: String(c._id) }),
      });
    })
  );
  rows.push(
    await run("agent: current context", (i) =>
      fetch(`${base}/api/internal/agent/contexts/current?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(agentGid(i))}`, { headers: internal })
    )
  );

  console.log(`\n${CONCURRENCY} at once, ${REQUESTS} requests per scenario, ${CUSTOMERS} customers, ${AGENTS} agents\n`);
  console.table(rows);

  const slow = rows.filter((r) => r["p95 ms"] > 500 || r.errors > 0);
  console.log(slow.length ? `Over 500 ms at p95, or with errors: ${slow.map((r) => r.scenario).join("; ")}` : "Every scenario stayed under 500 ms at p95 with no errors.");

  await mongoose.connection.dropDatabase();
  server.close();
  await mongoose.disconnect();
  process.exit(slow.length ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.connection.dropDatabase();
  } catch {
    // nothing to clean up
  }
  process.exit(1);
});
