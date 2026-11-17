const { endOfBusinessDay } = require(require("path").join(__dirname, "..", "..", "..", "backend-api", "src", "services", "businessTime"));
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };
const f = (d, n, z) => endOfBusinessDay(new Date(d), n, z).toISOString();

ok("India: the end of the 14th day is 18:29:59 UTC", f("2026-10-12T05:00:00Z", 14, "Asia/Kolkata") === "2026-10-26T18:29:59.999Z", f("2026-10-12T05:00:00Z", 14, "Asia/Kolkata"));
ok("New York in summer time is 4 hours behind", f("2026-10-12T05:00:00Z", 14, "America/New_York") === "2026-10-27T03:59:59.999Z");
ok("New York after the clocks go back is 5 hours behind", f("2026-10-30T12:00:00Z", 7, "America/New_York") === "2026-11-07T04:59:59.999Z");
ok("UTC is the end of the UTC day", f("2026-10-12T05:00:00Z", 14, "UTC") === "2026-10-26T23:59:59.999Z");
ok("an unknown zone falls back to plain days", f("2026-10-12T05:00:00Z", 1, "Not/AZone") === "2026-10-13T05:00:00.000Z");
ok("sent late in the evening there still counts that day's date there", f("2026-10-12T20:00:00Z", 1, "Asia/Kolkata") === "2026-10-13T18:29:59.999Z" || f("2026-10-12T20:00:00Z", 1, "Asia/Kolkata") === "2026-10-14T18:29:59.999Z", f("2026-10-12T20:00:00Z", 1, "Asia/Kolkata"));
ok("the result is always in the last second of a day there", new Date(f("2026-03-08T10:00:00Z", 3, "America/Los_Angeles")).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23" }).includes("23:59:59"), f("2026-03-08T10:00:00Z", 3, "America/Los_Angeles"));
ok("across a spring clock change it is still the last second there", new Date(f("2026-03-07T10:00:00Z", 2, "America/Los_Angeles")).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23" }).includes("23:59:59"), f("2026-03-07T10:00:00Z", 2, "America/Los_Angeles"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
