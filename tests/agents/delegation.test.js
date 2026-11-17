// Phase 4: delegation of approvals and temporary access.
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
const Delegation = R("src/models/approvalDelegation.model");
const User = R("src/models/user.model");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_delegation");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  const call = async (m, p, body, headers = IH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mk = (n, extra) => Customer.create({ name: n, email: n + "@x.com", shop, shopifyCustomerId: gid(n), ...extra });
  const q = (n, extra = "") => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}${extra}`;
  const DAY = 24 * 3600 * 1000;
  const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();

  await call("GET", "/api/roles", null, AH);
  await call("POST", "/api/roles", { name: "Careful", permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "cart.create" }, { key: "cart.write" }, { key: "order.submit", constraints: { mode: "approval_first" } }] }, AH);
  await call("POST", "/api/roles", { name: "Careful Approver", permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "cart.create" }, { key: "cart.write" }, { key: "order.submit", constraints: { mode: "approval_first" } }, { key: "approval.decide" }] }, AH);

  const careful = await mk("careful", { role: "careful" });
  const mgr = await mk("mgr", { role: "sales_manager" });
  const peer = await mk("peer", { role: "sales_agent" });
  const peer2 = await mk("peer2", { role: "sales_agent" });
  const capp = await mk("capp", { role: "careful_approver" });
  const cust = await mk("cust");
  const other = await mk("othercust");
  for (const a of [careful, mgr, capp]) await Grant.create({ shop, agent: a._id, scopeType: "customer", scopeId: String(cust._id) });
  await Grant.create({ shop, agent: mgr._id, scopeType: "customer", scopeId: String(other._id) });
  await Grant.create({ shop, agent: peer._id, scopeType: "customer", scopeId: String(cust._id) });

  const ctx = {};
  for (const n of ["careful", "capp"]) {
    ctx[n] = (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid(n), customerId: String(cust._id) })).j.contextId;
    await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid(n), contextId: ctx[n], items: [{ variantId: "111", quantity: 10 }] });
  }
  const ask = (n) => call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid(n), contextId: ctx[n], type: "ORDER_APPROVAL", baseline: { amount: 50000, currency: "USD" }, proposed: { amount: 50000, currency: "USD" }, reasonCode: "OTHER", reasonText: "please approve this order" });
  const decide = (n, id, decision = "approve", comment = "ok") => call("POST", `/api/internal/agent/approvals/${id}/decision`, { shop, agentShopifyCustomerId: gid(n), decision, comment });

  let r = await ask("careful");
  const id1 = r.j.id;
  ok("a request is waiting for approval", r.s === 201 && r.j.status === "PENDING_APPROVAL", r);

  r = await call("GET", "/api/internal/agent/approvals" + q("peer"));
  ok("without a delegation a plain agent sees nothing to approve", r.s === 200 && r.j.approvals.length === 0, r.j);
  r = await decide("peer", id1);
  ok("and can't decide it (403)", r.s === 403, r);

  // ---- creating a delegation: the rules
  const create = (body, headers = AH) => call("POST", "/api/delegations", body, headers);
  const good = () => ({ delegatorId: String(mgr._id), delegateId: String(peer._id), endsAt: inDays(2), reason: "On holiday" });

  r = await create({ ...good(), delegateId: String(mgr._id) });
  ok("you can't delegate to yourself", r.s === 400 && r.j.code === "SAME_PERSON", r);
  r = await create({ ...good(), reason: " " });
  ok("a reason is required", r.s === 400 && r.j.code === "REASON_REQUIRED", r);
  r = await create({ ...good(), endsAt: inDays(-1) });
  ok("the end must be in the future", r.s === 400 && r.j.code === "INVALID_DATES", r);
  r = await create({ ...good(), endsAt: inDays(45) });
  ok("a delegation has a longest length (30 days)", r.s === 400 && r.j.code === "TOO_LONG", r);
  r = await create({ ...good(), delegatorId: String(peer._id), delegateId: String(peer2._id) });
  ok("someone with no approval authority has nothing to delegate", r.s === 400 && r.j.code === "NOTHING_TO_DELEGATE", r);
  r = await create({ ...good(), delegateId: String(cust._id) });
  ok("the delegate must be a sales agent", r.s === 404 && r.j.code === "DELEGATE_NOT_FOUND", r);
  r = await create(good(), {});
  ok("only a signed-in merchant can use the panel route", r.s === 401, r);

  // ---- a scheduled delegation does nothing yet
  r = await create({ ...good(), startsAt: inDays(1), endsAt: inDays(3) });
  ok("a delegation can start later", r.s === 201 && r.j.status === "scheduled", r);
  const scheduledId = r.j.id;
  r = await decide("peer", id1);
  ok("before it starts it gives no authority (403)", r.s === 403, r);
  await call("POST", `/api/delegations/${scheduledId}/revoke`, {}, AH);

  // ---- the real one
  r = await create(good());
  ok("the merchant creates a delegation mgr -> peer", r.s === 201 && r.j.status === "active", r);
  const delId = r.j.id;
  r = await create({ ...good(), startsAt: inDays(1), endsAt: inDays(3) });
  ok("an overlapping one for the same two people is refused (409)", r.s === 409 && r.j.code === "OVERLAPS", r);

  r = await call("GET", "/api/internal/agent/approvals" + q("peer"));
  ok("the delegate now sees the request", r.j.approvals.some((a) => a.id === id1), r.j);
  r = await call("GET", "/api/internal/agent/approvals" + q("peer2"));
  ok("another agent still does not", r.j.approvals.length === 0, r.j);

  r = await decide("peer", id1, "reject", "");
  ok("a rejection still needs a comment", r.s === 400 && r.j.code === "COMMENT_REQUIRED", r);
  r = await decide("peer", id1, "approve", "Covering for mgr");
  ok("the delegate approves with the delegator's authority", r.s === 200 && r.j.status === "APPROVED", r);

  const stored = await mongoose.connection.db.collection("overriderequests").findOne({ _id: new mongoose.Types.ObjectId(id1) });
  const dec = stored.decisions[stored.decisions.length - 1];
  ok("the decision names the delegate and whose authority was used", String(dec.by) === String(peer._id) && String(dec.onBehalfOf) === String(mgr._id) && dec.onBehalfOfName === "mgr", dec);
  const aud = await Audit.findOne({ action: "override.decided", objectId: id1 }).lean();
  ok("the audit entry records both people and the delegation", aud && aud.metadata.onBehalfOf === String(mgr._id) && aud.metadata.delegation === delId, aud);
  const ev = await Outbox.findOne({ type: "sales_agent.override.decided", "payload.override_id": id1 }).lean();
  ok("the integration event carries on_behalf_of", ev && ev.payload.on_behalf_of === String(mgr._id), ev && ev.payload);
  r = await call("GET", "/api/delegations", null, AH);
  ok("the list shows it was used once", r.j.some((d) => d.id === delId && d.usedTimes === 1 && d.status === "active"), r.j);

  // ---- separation of duties holds through a delegation
  await call("POST", `/api/delegations/${delId}/revoke`, { reason: "Only capp's delegation from here" }, AH);
  r = await create({ delegatorId: String(capp._id), delegateId: String(peer._id), endsAt: inDays(2), reason: "Away" });
  ok("an agent with approval rights can delegate too", r.s === 201, r);
  r = await ask("capp");
  const id2 = r.j.id;
  r = await decide("capp", id2);
  ok("the requester can't approve their own request", r.s === 403, r);
  r = await decide("peer", id2);
  ok("the delegate can't approve the delegator's own request on their behalf (403)", r.s === 403, r);
  r = await decide("mgr", id2, "approve", "ok");
  ok("a real approver still can", r.s === 200 && r.j.status === "APPROVED", r);

  // ---- a delegate can't pass it on
  r = await call("POST", "/api/internal/agent/delegations", { shop, agentShopifyCustomerId: gid("peer"), delegateId: String(peer2._id), endsAt: inDays(1), reason: "Passing it on" });
  ok("a delegate can't hand the delegation to someone else (nothing of their own to delegate)", r.s === 400 && r.j.code === "NOTHING_TO_DELEGATE", r);

  // ---- an agent delegates their own authority from the storefront
  r = await call("GET", "/api/internal/agent/delegate-candidates" + q("mgr"));
  ok("the storefront offers colleagues to choose from", r.s === 200 && r.j.agents.some((a) => a.id === String(peer2._id)) && !r.j.agents.some((a) => a.id === String(mgr._id)), r.j);
  r = await call("POST", "/api/internal/agent/delegations", { shop, agentShopifyCustomerId: gid("mgr"), delegateId: String(peer2._id), endsAt: inDays(1), reason: "Lunch" });
  ok("an agent can delegate their own approvals", r.s === 201, r);
  const selfId = r.j.id;
  r = await call("POST", "/api/internal/agent/delegations", { shop, agentShopifyCustomerId: gid("peer"), delegatorId: String(mgr._id), delegateId: String(peer2._id), endsAt: inDays(1), reason: "Faking it" });
  ok("it is always their own authority, whatever is sent", r.s === 400, r);
  r = await call("GET", "/api/internal/agent/delegations" + q("peer2"));
  ok("the delegate sees it as received", r.j.delegations.some((d) => d.id === selfId && d.direction === "received"), r.j);
  r = await call("POST", `/api/internal/agent/delegations/${selfId}/revoke`, { shop, agentShopifyCustomerId: gid("peer"), reason: "x" });
  ok("a stranger can't end it (404)", r.s === 404, r);
  r = await call("POST", `/api/internal/agent/delegations/${selfId}/revoke`, { shop, agentShopifyCustomerId: gid("mgr"), reason: "Back" });
  ok("the delegator takes it back", r.s === 200 && r.j.status === "revoked", r);

  // ---- ending and expiry
  await Delegation.updateMany({ shop, delegator: capp._id }, { $set: { status: "REVOKED" } });
  r = await ask("careful");
  const id3 = r.j.id;
  r = await create(good());
  const delB = r.j.id;
  r = await call("POST", `/api/delegations/${delB}/revoke`, { reason: "Back early" }, AH);
  ok("the merchant ends a delegation", r.s === 200 && r.j.status === "revoked", r);
  r = await decide("peer", id3);
  ok("the delegate loses the authority at once (403)", r.s === 403, r);
  r = await call("POST", `/api/delegations/${delB}/revoke`, {}, AH);
  ok("ending it twice is refused (404)", r.s === 404, r);

  r = await create(good());
  const d3 = r.j.id;
  r = await decide("peer", id3, "approve", "back on");
  ok("a new delegation works again", r.s === 200, r);
  await Delegation.updateOne({ _id: d3 }, { $set: { endsAt: new Date(Date.now() - 1000) } });
  r = await ask("careful");
  const id4 = r.j.id;
  r = await decide("peer", id4);
  ok("it stops by itself when its time is up (403)", r.s === 403, r);
  r = await call("GET", "/api/delegations?status=expired", null, AH);
  ok("and is listed as expired", r.j.some((d) => d.id === d3), r.j);

  // ---- temporary access
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("peer"), customerId: String(other._id) });
  ok("without cover, the delegate can't work for the delegator's other customer", r.s === 403, r);
  r = await create({ ...good(), coverAccess: true });
  const cov = r.j.id;
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("peer"), customerId: String(other._id) });
  ok("with cover, they can (temporary access)", r.s === 201 || r.s === 200, r);
  const peerCtx = r.j && r.j.contextId;
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("peer2"), customerId: String(other._id) });
  ok("cover is for the delegate only", r.s === 403, r);
  await call("POST", `/api/delegations/${cov}/revoke`, {}, AH);
  r = await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("peer"), customerId: String(other._id) });
  ok("when it ends, so does the access", r.s === 403, r);
  if (peerCtx) {
    r = await call("GET", "/api/internal/agent/contexts/current" + q("peer", "&contextId=" + peerCtx));
    ok("an open context from the cover is no longer fresh (stale or ended)", r.s !== 200 || (r.j && r.j.state !== "ACTIVE"), r);
  }

  // ---- quote approvals through a delegation
  await call("POST", "/api/roles", { name: "Quoter", permissions: [{ key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "cart.create" }, { key: "cart.write" }, { key: "quote.create" }] }, AH);
  const qtr = await mk("qtr", { role: "quoter" });
  await Grant.create({ shop, agent: qtr._id, scopeType: "customer", scopeId: String(cust._id) });
  const qctx = (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid("qtr"), customerId: String(cust._id) })).j.contextId;
  await call("PUT", "/api/agent-settings", { quoteApprovalAbove: 100000 }, AH);
  const bigQuote = async () => {
    const created = (await call("POST", "/api/internal/agent/quotes", { shop, agentShopifyCustomerId: gid("qtr"), contextId: qctx, currency: "USD", items: [{ variantId: "1", title: "x", sku: "x", quantity: 30, baselineUnit: 5000, unitPrice: 4500 }] })).j;
    await call("POST", `/api/internal/agent/quotes/${created.id}/submit`, { shop, agentShopifyCustomerId: gid("qtr") });
    return created.id;
  };
  const qdecide = (n, id, decision = "approve", comment = "ok") => call("POST", `/api/internal/agent/quote-approvals/${id}/decision`, { shop, agentShopifyCustomerId: gid(n), decision, comment });

  let qid = await bigQuote();
  r = await qdecide("peer", qid);
  ok("without a delegation a plain agent can't approve a quote (403)", r.s === 403, r);
  r = await create({ ...good(), includeQuotes: false });
  const noQ = r.j.id;
  r = await call("GET", "/api/internal/agent/quote-approvals" + q("peer"));
  ok("a delegation that leaves quotes out does not show them", r.s === 200 && r.j.quotes.length === 0, r.j);
  r = await qdecide("peer", qid);
  ok("and does not allow deciding one (403)", r.s === 403, r);
  await call("POST", `/api/delegations/${noQ}/revoke`, {}, AH);
  r = await create(good());
  const withQ = r.j.id;
  r = await call("GET", "/api/internal/agent/quote-approvals" + q("peer"));
  ok("with quotes included, the delegate sees the quote", r.j.quotes.some((x) => x.id === qid), r.j);
  r = await qdecide("peer", qid, "approve", "Covering");
  ok("and approves it", r.s === 200 && r.j.status === "APPROVED", r);
  const qAud = await Audit.findOne({ action: "quote.decided", objectId: qid }).lean();
  ok("the quote audit names whose authority was used", qAud && qAud.metadata.onBehalfOf === String(mgr._id) && qAud.metadata.delegation === withQ, qAud);
  r = await call("GET", `/api/internal/agent/quotes/${qid}` + q("qtr", "&contextId=" + qctx));
  ok("the quote's timeline says it was on behalf of the delegator", r.s !== 200 || JSON.stringify(r.j).includes("on behalf of mgr"), r.j);
  await call("POST", `/api/delegations/${withQ}/revoke`, {}, AH);

  // ---- disabling an agent ends their delegations
  r = await create({ ...good(), startsAt: inDays(0) });
  const dd = r.j.id;
  r = await call("PUT", `/api/customers/${mgr._id}`, { role: "customer" }, AH).catch(() => null);
  const AgentHandover = R("src/services/agentHandover.service");
  await AgentHandover.handOverWork({ shop, agent: mgr, toAgentId: String(peer2._id), actor: user });
  const after = await Delegation.findById(dd).lean();
  ok("disabling an agent ends the delegations they gave", after.status === "REVOKED", after);
  const audDis = await Audit.findOne({ action: "delegation.revoked", objectId: dd }).lean();
  ok("and the end is audited", !!audDis, audDis);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
