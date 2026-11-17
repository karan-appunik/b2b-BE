// Runs every sales agent test, one after another, each against its own temporary
// database on the local MongoDB (never the real one), and prints a summary.
//
//   node tests/run-all.js            all of them
//   node tests/run-all.js quote      only the files whose name contains "quote"
//
// Needs MongoDB on localhost:27017 (or MONGODB_TEST_URI is not used here: each
// test names its own sparklayer_test_* database).

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "agents");
const only = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js") && (!only || f.includes(only))).sort();

let passed = 0;
let failed = 0;
const bad = [];

for (const file of files) {
  const run = spawnSync(process.execPath, [path.join(dir, file)], { encoding: "utf8", timeout: 300000 });
  const out = (run.stdout || "") + (run.stderr || "");
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const p = m ? Number(m[1]) : 0;
  const f = m ? Number(m[2]) : 1;
  passed += p;
  failed += f;
  console.log(`${f ? "FAIL" : "ok  "} ${file.padEnd(34)} ${m ? `${p} passed, ${f} failed` : "did not finish"}`);
  if (f || !m) bad.push({ file, out });
}

console.log(`\n${files.length} files, ${passed} checks passed, ${failed} failed`);
for (const b of bad) {
  console.log(`\n--- ${b.file} ---\n${b.out.split("\n").filter((l) => /^FAIL|Error/.test(l)).slice(0, 12).join("\n")}`);
}
process.exit(failed ? 1 : 0);
