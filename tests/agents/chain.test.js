const ROOT = require("path").join(__dirname, "..", "..");
process.chdir(ROOT);
process.env.AGENT_MFA_DEFAULT = "false";
process.env.INTERNAL_API_KEY = "k";
process.env.JWT_SECRET = "s";
const R = (m) => require(require("path").join(ROOT, m));
const mongoose = R("node_modules/mongoose");
const jwt = R("node_modules/jsonwebtoken");
const app = R("app");
const Audit = R("src/models/auditEvent.model");
const User = R("src/models/user.model");
const { recordAudit, verifyChain } = R("src/services/audit.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_chain");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const user = await User.create({ name: "M", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s") };
  const verify = async () => (await fetch(base + "/api/audit/verify", { headers: AH }).then((r) => r.json()));

  let v = await verify();
  ok("empty trail is intact", v.intact && v.checked === 0, v);

  // concurrent writes must still form one straight chain
  const cust = new mongoose.Types.ObjectId();
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      recordAudit({ shop, actorType: "system", action: "test.event", customer: cust, objectId: String(i), metadata: { n: i, when: new Date(), nested: { b: 2, a: 1 } } })
    )
  );
  await recordAudit({ shop: "other.myshopify.com", actorType: "system", action: "test.other" });

  const rows = await Audit.find({ shop }).sort({ _id: 1 }).lean();
  ok("12 rows written", rows.length === 12, rows.length);
  ok("first row links to GENESIS", rows[0].prevHash === "GENESIS", rows[0].prevHash);
  ok("each row links to the one before (no fork)", rows.every((r, i) => i === 0 || r.prevHash === rows[i - 1].hash));
  ok("a different shop has its own chain", (await Audit.findOne({ shop: "other.myshopify.com" })).prevHash === "GENESIS");

  v = await verify();
  ok("chain verifies after concurrent writes", v.intact && v.checked === 12 && v.firstBreak === null, v);

  // tamper: edit a row behind the model's back (native driver skips the append-only hooks)
  const target = rows[5];
  await Audit.collection.updateOne({ _id: target._id }, { $set: { action: "tampered" } });
  v = await verify();
  ok("altered row is detected, and located", !v.intact && String(v.firstBreak.id) === String(target._id) && /altered/.test(v.firstBreak.problem), v);
  await Audit.collection.updateOne({ _id: target._id }, { $set: { action: "test.event" } });
  v = await verify();
  ok("restoring the row makes the chain verify again", v.intact && v.checked === 12, v);

  // tamper: delete a row in the middle
  const victim = rows[8];
  await Audit.collection.deleteOne({ _id: victim._id });
  v = await verify();
  ok("deleted row is detected at the next row", !v.intact && String(v.firstBreak.id) === String(rows[9]._id) && /broken/.test(v.firstBreak.problem), v);
  await Audit.collection.insertOne(victim);
  v = await verify();
  ok("putting it back restores the chain", v.intact && v.checked === 12, v);

  // old rows without hashes are counted, not failed
  await Audit.collection.insertOne({ shop, occurredAt: new Date("2020-01-01"), actorType: "system", action: "legacy", outcome: "success" });
  v = await verify();
  ok("pre-chain rows are reported separately", v.intact && v.unchained === 1, v);

  // the model still refuses normal updates
  let blocked = false;
  try { await Audit.updateOne({ _id: rows[0]._id }, { action: "x" }); } catch (e) { blocked = /append-only/.test(e.message); }
  ok("normal updates still refused", blocked);

  // endpoint needs a merchant login
  const anon = await fetch(base + "/api/audit/verify");
  ok("verify needs a login", anon.status === 401, anon.status);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
