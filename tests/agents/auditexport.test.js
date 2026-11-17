const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
const R = (m) => require(require("path").join(ROOT, m));
const mongoose = R("node_modules/mongoose");
const jwt = R("node_modules/jsonwebtoken");
const app = R("app");
const { recordAudit } = R("src/services/audit.service");
const Audit = R("src/models/auditEvent.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_auditexport");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const other = await User.create({ name: "Other", email: "o@x.com", password: "x", shop: "other.myshopify.com" });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s") };
  const get = async (p, headers = AH) => { const r = await fetch(base + p, { headers }); return { s: r.status, type: r.headers.get("content-type"), disp: r.headers.get("content-disposition"), text: await r.text() }; };

  const agentId = new mongoose.Types.ObjectId();
  await recordAudit({ shop, actorType: "sales_agent", actor: agentId, action: "context.entered", metadata: { note: "ok", apiToken: "SECRET-TOKEN-123", nested: { cardNumber: "4242424242424242", password: "hunter2", fine: "yes" } } });
  await recordAudit({ shop, actorType: "sales_agent", actor: agentId, action: "context.denied", outcome: "denied", reasonCode: "EXPLICIT_DENY" });
  await recordAudit({ shop, actorType: "sales_agent", actor: new mongoose.Types.ObjectId(), action: "quote.created", reasonCode: "=HYPERLINK(\"http://evil\")", metadata: { text: "hello, \"world\"\nnew line" } });
  await recordAudit({ shop: "other.myshopify.com", actorType: "system", action: "other.shop.event" });

  let r = await get("/api/audit/export");
  const rowsBefore = r.text.trim().split("\r\n").length - 1;
  ok("a CSV file comes back with a download name", r.s === 200 && /text\/csv/.test(r.type) && /attachment; filename="agent-activity-\d{4}-\d{2}-\d{2}\.csv"/.test(r.disp), [r.s, r.type, r.disp]);
  ok("it has a header and one row per event of this shop (3)", r.text.startsWith("occurredAt,actorType,actor,") && rowsBefore === 3, [rowsBefore, r.text.slice(0, 120)]);
  ok("another shop's events are never included", !r.text.includes("other.shop.event"));
  ok("secrets are removed, whatever the field is called", !r.text.includes("SECRET-TOKEN-123") && !r.text.includes("4242424242424242") && !r.text.includes("hunter2") && r.text.includes("[removed]") && r.text.includes("fine"), r.text);
  ok("a cell that starts with = is made safe for spreadsheets", r.text.includes("'=HYPERLINK") && !/,=HYPERLINK/.test(r.text));
  ok("commas, quotes and new lines are quoted properly", r.text.includes("world") && r.text.includes("new line") && r.text.split("\r\n").length === 5 && /,[0-9a-f]{24},/.test(r.text) && !r.text.includes('"""'));
  ok("hash fields are not exported", !r.text.includes("prevHash") && !/[0-9a-f]{64}/.test(r.text));

  ok("the export itself was recorded, with who and the filters", !!(await Audit.findOne({ shop, action: "audit.exported", actor: user._id, "metadata.rows": 3 })));
  r = await get("/api/audit/export");
  ok("a second export now includes the first one's record (4 rows)", r.text.trim().split("\r\n").length - 1 === 4 && r.text.includes("audit.exported"));

  r = await get(`/api/audit/export?agentId=${agentId}`);
  ok("filter by agent", r.text.trim().split("\r\n").length - 1 === 2 && !r.text.includes("quote.created"), r.text);
  r = await get("/api/audit/export?outcome=denied");
  ok("filter by outcome", r.text.trim().split("\r\n").length - 1 === 1 && r.text.includes("context.denied"));
  r = await get("/api/audit/export?action=quote.created");
  ok("filter by action", r.text.trim().split("\r\n").length - 1 === 1);
  r = await get("/api/audit/export?from=2999-01-01");
  ok("a period with nothing gives only the header", r.text.trim().split("\r\n").length === 1);
  ok("a filtered export is recorded with its filters", !!(await Audit.findOne({ shop, action: "audit.exported", "metadata.filters.action": "quote.created" })));
  r = await get("/api/audit/export?from=nonsense");
  ok("a bad date is refused (400)", r.s === 400);
  r = await get("/api/audit/export?agentId=abc");
  ok("a bad id is refused (400)", r.s === 400);
  r = await get("/api/audit/export", {});
  ok("login required (401)", r.s === 401);

  r = await get("/api/audit?limit=5");
  const list = JSON.parse(r.text);
  ok("the on-screen list hides secrets in the same way", !r.text.includes("SECRET-TOKEN-123") && !r.text.includes("hunter2"), r.text.slice(0, 200));
  ok("and the list still works with filters", Array.isArray(list) && list.length > 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
