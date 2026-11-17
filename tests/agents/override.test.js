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
const Role = R("src/models/role.model");
const User = R("src/models/user.model");
const Audit = R("src/models/auditEvent.model");
const Outbox = R("src/models/outboxEvent.model");
const Override = R("src/models/overrideRequest.model");
const totp = R("src/services/totp.service");
const { ensureSystemRoles } = R("src/services/role.service");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(extra))); };

(async () => {
  await mongoose.connect("mongodb://localhost:27017/sparklayer_test_override");
  await mongoose.connection.dropDatabase();
  const srv = app.listen(0);
  const base = "http://localhost:" + srv.address().port;
  const shop = "t.myshopify.com";
  const IH = { "x-internal-api-key": "k", "Content-Type": "application/json" };
  const user = await User.create({ name: "Merchant", email: "m@x.com", password: "x", shop });
  const AH = { Authorization: "Bearer " + jwt.sign({ id: user._id }, "s"), "Content-Type": "application/json" };
  let call = async (m, p, body, headers = IH) => {
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json() };
  };

  // A role, grant or setting changed mid-test makes a context STALE (spec §5.2):
  // refresh it the way the storefront would, then try again.
  {
    const _raw = call;
    call = async (m, p, body, headers) => {
      let r = await _raw(m, p, body, headers);
      if (r.s === 401 && r.j && r.j.code === "CONTEXT_STALE") {
        const qs = new URL("http://x" + p).searchParams;
        const ctxId = (body && body.contextId) || qs.get("contextId");
        const agentId = (body && body.agentShopifyCustomerId) || qs.get("agentShopifyCustomerId");
        if (ctxId && agentId) {
          await _raw("POST", "/api/internal/agent/contexts/" + ctxId + "/refresh", { shop, agentShopifyCustomerId: agentId }, IH);
          r = await _raw(m, p, body, headers);
        }
      }
      return r;
    };
  }
  const gid = (n) => "gid://shopify/Customer/" + n;
  const mkc = (name, extra) => Customer.create({ name, email: name + "@x.com", shop, shopifyCustomerId: gid(name), ...extra });
  const q = (n, extra = "") => `?shop=${shop}&agentShopifyCustomerId=${encodeURIComponent(gid(n))}${extra}`;

  await call("GET", "/api/roles", null, AH); // seeds built-ins
  await call("POST", "/api/roles", { name: "Rep", permissions: [
    { key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "cart.create" }, { key: "cart.write" },
    { key: "price.override", constraints: { maxDeltaPercent: 10 } }, { key: "discount.override", constraints: { maxPercent: 5 } },
    { key: "quantity_rule.override", constraints: {} }, { key: "shipping.override" },
  ] }, AH);
  await call("POST", "/api/roles", { name: "Lead", permissions: [
    { key: "customer.search" }, { key: "customer.context.enter", constraints: { scope: "assigned" } }, { key: "cart.create" }, { key: "cart.write" },
    { key: "price.override", constraints: { maxDeltaPercent: 10 } }, { key: "approval.decide", constraints: { maxDeltaPercent: 50 } },
  ] }, AH);

  const rep = await mkc("rep", { role: "rep" });
  const lead = await mkc("lead", { role: "lead" });
  const plain = await mkc("plain", { role: "sales_agent" });
  const mgr = await mkc("mgr", { role: "sales_manager" });
  const admin = await mkc("admin", { role: "sales_admin" });
  const custA = await mkc("custA");
  for (const a of [rep, lead, plain, mgr]) await Grant.create({ shop, agent: a._id, scopeType: "customer", scopeId: String(custA._id) });

  const enter = async (n) => (await call("POST", "/api/internal/agent/contexts", { shop, agentShopifyCustomerId: gid(n), customerId: String(custA._id) })).j.contextId;
  const ctx = {};
  for (const n of ["rep", "lead", "plain", "mgr", "admin"]) ctx[n] = await enter(n);
  const saveCart = (n, items) => call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid(n), contextId: ctx[n], items });
  const CART = [{ variantId: "111", quantity: 10 }, { variantId: "222", quantity: 5 }];
  for (const n of ["rep", "lead", "plain", "mgr", "admin"]) await saveCart(n, CART);

  const ask = (n, over = {}) => call("POST", "/api/internal/agent/overrides", {
    shop, agentShopifyCustomerId: gid(n), contextId: ctx[n], type: "UNIT_PRICE", lineVariantId: "111",
    baseline: { amount: 45000, currency: "INR" }, proposed: { amount: 42500, currency: "INR" },
    reasonCode: "VOLUME_COMMITMENT", reasonText: "100 unit commitment", ...over,
  });
  const price = (pct) => ({ proposed: { amount: Math.round(45000 * (1 - pct / 100)), currency: "INR" } });

  // ================= requesting =================
  let r = await ask("plain");
  ok("agent without price.override -> DENIED (PERMISSION_DENIED), recorded", r.s === 201 && r.j.status === "DENIED" && r.j.denyReason === "PERMISSION_DENIED", r);

  r = await ask("rep");
  ok("doc example: 45000 -> 42500 INR is 5.56% below, within the rep's 10% -> AUTO_APPROVED", r.j.status === "AUTO_APPROVED" && r.j.deltaPercent === 5.56, r);
  const auto = r.j;

  r = await ask("rep", { lineVariantId: "222", ...price(15) });
  ok("15% is over the rep's 10% -> PENDING_APPROVAL (default route)", r.j.status === "PENDING_APPROVAL" && r.j.route.policyName === "Default", r);
  const pending15 = r.j;

  r = await ask("rep", { reasonText: "  " });
  ok("a written reason is required", r.s === 400 && r.j.code === "REASON_REQUIRED", r);
  r = await ask("rep", { reasonCode: "BECAUSE" });
  ok("reason must be one of the known codes", r.s === 400 && r.j.code === "INVALID_REASON", r);
  r = await ask("rep", { type: "MAGIC" });
  ok("unknown type refused", r.s === 400 && r.j.code === "INVALID_TYPE", r);
  r = await ask("rep", { proposed: { amount: 42.5, currency: "INR" } });
  ok("amounts must be whole minor units", r.s === 400 && r.j.code === "INVALID_AMOUNT", r);
  r = await ask("rep", { lineVariantId: "999" });
  ok("item must be in the customer's cart", r.s === 400 && r.j.code === "LINE_NOT_IN_CART", r);
  r = await ask("rep", { proposed: { amount: 42500, currency: "USD" } });
  ok("currency mismatch is a hard DENY", r.j.status === "DENIED" && r.j.denyReason === "CURRENCY_MISMATCH", r);
  r = await ask("rep", { baseline: { amount: 0, currency: "INR" } });
  ok("a zero baseline is refused", r.j.status === "DENIED" && r.j.denyReason === "INVALID_BASELINE", r);

  r = await call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid("rep"), type: "UNIT_PRICE" });
  ok("no customer context -> 401", r.s === 401, r);
  r = await call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid("lead"), contextId: ctx.rep, type: "UNIT_PRICE" });
  ok("someone else's context -> 401", r.s === 401, r);

  // hard floor
  r = await call("PUT", "/api/agent-settings", { hardFloorPercent: 60 }, AH);
  ok("hard floor setting saved", r.s === 200 && r.j.hardFloorPercent === 60, r);
  r = await ask("admin", { lineVariantId: "222", ...price(50) });
  ok("below the 60% floor is DENIED even for an administrator", r.j.status === "DENIED" && r.j.denyReason === "BELOW_FLOOR", r);
  r = await ask("admin", { lineVariantId: "222", ...price(30) });
  ok("above the floor, an administrator (no limit) is auto-approved", r.j.status === "AUTO_APPROVED", r);
  await call("PUT", "/api/agent-settings", { hardFloorPercent: null }, AH);

  // ================= approving =================
  r = await call("GET", "/api/internal/agent/approvals" + q("mgr"));
  ok("a manager sees the pending request", r.s === 200 && r.j.approvals.some((a) => a.id === pending15.id) && r.j.approvals[0].agentName === "rep" && r.j.approvals[0].customerName === "custA", r);
  r = await call("GET", "/api/internal/agent/approvals" + q("rep"));
  ok("the requester's list is empty (cannot approve their own)", r.j.approvals.length === 0, r);
  r = await call("GET", "/api/internal/agent/approvals" + q("plain"));
  ok("an agent without approval.decide sees nothing", r.j.approvals.length === 0, r);

  const decideAgent = (n, id, decision, comment) => call("POST", `/api/internal/agent/approvals/${id}/decision`, { shop, agentShopifyCustomerId: gid(n), decision, comment });
  r = await decideAgent("rep", pending15.id, "approve", "ok");
  ok("requester can't approve their own exception", r.s === 403 && r.j.code === "NOT_AN_APPROVER", r);
  r = await decideAgent("plain", pending15.id, "approve");
  ok("agent without the permission can't decide", r.s === 403, r);
  r = await decideAgent("mgr", pending15.id, "reject", "");
  ok("rejecting needs a comment", r.s === 400 && r.j.code === "COMMENT_REQUIRED", r);
  r = await decideAgent("mgr", pending15.id, "approve", "Fine for this volume");
  ok("manager (limit 30%) approves a 15% exception", r.s === 200 && r.j.status === "APPROVED" && r.j.decisions[0].decision === "approve", r);
  r = await decideAgent("mgr", pending15.id, "approve");
  ok("deciding twice -> 409", r.s === 409 && r.j.code === "NOT_PENDING", r);

  r = await ask("rep", { lineVariantId: "222", ...price(40) });
  const pending40 = r.j;
  ok("40% -> pending", pending40.status === "PENDING_APPROVAL", r);
  r = await call("GET", "/api/internal/agent/approvals" + q("mgr"));
  ok("a 40% exception is above the manager's 30% limit: not in their list", !r.j.approvals.some((a) => a.id === pending40.id), r);
  r = await decideAgent("mgr", pending40.id, "approve", "x");
  ok("...and they can't decide it (ABOVE_APPROVAL_LIMIT)", r.s === 403 && r.j.code === "ABOVE_APPROVAL_LIMIT", r);
  r = await decideAgent("admin", pending40.id, "reject", "Too deep a discount");
  ok("an administrator (no limit) can reject it", r.s === 200 && r.j.status === "REJECTED", r);

  // self approval: lead may approve up to 50% but not their own
  r = await ask("lead", { ...price(20) });
  const leadReq = r.j;
  ok("lead's own 20% request is pending", leadReq.status === "PENDING_APPROVAL", r);
  r = await decideAgent("lead", leadReq.id, "approve", "self");
  ok("separation of duties: lead can't approve their own exception", r.s === 403 && r.j.code === "SELF_APPROVAL_NOT_ALLOWED", r);
  r = await decideAgent("mgr", leadReq.id, "approve", "ok");
  ok("someone else can", r.s === 200, r);

  // ================= policies =================
  r = await call("POST", "/api/approval-policies", { name: "Big", overrideType: "UNIT_PRICE", maxDeltaPercent: 25, priority: 1, approverRoles: ["sales_admin"], slaHours: 4, commentRequiredAbovePercent: 15 }, AH);
  ok("policy created", r.s === 201 && r.j.version === 1, r);
  const bigPolicy = r.j;
  r = await call("POST", "/api/approval-policies", { name: "Bad", overrideType: "NOPE" }, AH);
  ok("bad type refused", r.s === 400, r);
  r = await call("POST", "/api/approval-policies", { name: "Bad", approverRoles: ["ghost"] }, AH);
  ok("approver role must exist", r.s === 400, r);
  r = await call("POST", "/api/approval-policies", { name: "Bad", selfApprovalAllowed: true }, AH);
  ok("self-approval needs a size limit", r.s === 400, r);
  r = await call("POST", "/api/approval-policies", { name: "Bad", maxDeltaPercent: 500 }, AH);
  ok("percent out of range refused", r.s === 400, r);

  r = await ask("rep", { lineVariantId: "222", ...price(20) });
  const routed = r.j;
  ok("a matching policy routes it: admins only, 4h SLA", routed.status === "PENDING_APPROVAL" && routed.route.policyName === "Big" && routed.route.slaHours === 4, r);
  r = await call("GET", "/api/internal/agent/approvals" + q("mgr"));
  ok("the manager is not an approver under that policy", !r.j.approvals.some((a) => a.id === routed.id), r);
  r = await decideAgent("mgr", routed.id, "approve", "x");
  ok("...and can't decide it", r.s === 403 && r.j.code === "NOT_AN_APPROVER", r);
  r = await decideAgent("admin", routed.id, "approve", "");
  ok("above 15% needs a comment to approve", r.s === 400 && r.j.code === "COMMENT_REQUIRED", r);
  r = await decideAgent("admin", routed.id, "approve", "Strategic account");
  ok("admin approves with a comment", r.s === 200 && r.j.status === "APPROVED", r);

  r = await ask("rep", { ...price(40) });
  ok("larger than every policy covers -> DENIED (NO_APPROVAL_ROUTE)", r.j.status === "DENIED" && r.j.denyReason === "NO_APPROVAL_ROUTE", r);

  r = await call("POST", "/api/approval-policies", { name: "Never", overrideType: "UNIT_PRICE", effect: "deny", maxDeltaPercent: 100, priority: 0 }, AH);
  const denyPolicy = r.j;
  r = await ask("rep", { lineVariantId: "222", ...price(15) });
  ok("a deny policy (lower priority number) refuses first", r.j.status === "DENIED" && r.j.denyReason === "POLICY_DENY", r);
  r = await call("PUT", `/api/approval-policies/${denyPolicy._id}`, { active: false }, AH);
  ok("policy edit bumps its version", r.s === 200 && r.j.version === 2 && r.j.active === false, r);
  r = await ask("rep", { lineVariantId: "222", ...price(15) });
  ok("switching the deny policy off restores routing", r.j.status === "PENDING_APPROVAL" && r.j.route.policyName === "Big", r);
  const toCancel = r.j;
  r = await call("GET", "/api/approval-policies", null, AH);
  ok("policies listed in priority order", r.s === 200 && r.j.policies[0].name === "Never" && r.j.policies[1].name === "Big", r.j.policies.map((p) => p.name));
  ok("policy changes are audited", (await Audit.countDocuments({ action: { $in: ["approval_policy.created", "approval_policy.updated"] } })) >= 3);

  // self-approval allowed by policy within a size
  await call("PUT", `/api/approval-policies/${bigPolicy._id}`, { selfApprovalAllowed: true, selfApprovalMaxPercent: 22, approverRoles: [] }, AH);
  r = await ask("lead", { ...price(21) });
  const selfOk = r.j;
  r = await decideAgent("lead", selfOk.id, "approve", "within my limit");
  ok("policy that allows self-approval up to 22%: lead may approve their own 21%", r.s === 200, r);
  r = await ask("lead", { ...price(24) });
  r = await decideAgent("lead", r.j.id, "approve", "too big for self");
  ok("...but not 24%", r.s === 403 && r.j.code === "SELF_APPROVAL_NOT_ALLOWED", r);

  // ================= cancel =================
  r = await call("POST", `/api/internal/agent/overrides/${toCancel.id}/cancel`, { shop, agentShopifyCustomerId: gid("lead") });
  ok("someone else can't cancel it", r.s === 404, r);
  r = await call("POST", `/api/internal/agent/overrides/${toCancel.id}/cancel`, { shop, agentShopifyCustomerId: gid("rep") });
  ok("the requester can cancel", r.s === 200 && r.j.status === "CANCELLED", r);
  r = await call("POST", `/api/internal/agent/overrides/${toCancel.id}/cancel`, { shop, agentShopifyCustomerId: gid("rep") });
  ok("cancelling twice -> 409", r.s === 409, r);

  // ================= cart changes invalidate =================
  await call("PUT", "/api/internal/agent/carts/current", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctx.rep, items: CART });
  r = await call("GET", `/api/internal/agent/overrides/usable${q("rep", "&contextId=" + ctx.rep)}`);
  const usableIds = r.j.overrides.map((o) => o.id);
  ok("usable list holds the auto-approved and approved exceptions", usableIds.includes(auto.id) && usableIds.includes(pending15.id), r.j);

  await saveCart("rep", [{ variantId: "111", quantity: 10 }, { variantId: "222", quantity: 99 }]);
  r = await call("GET", `/api/internal/agent/overrides/usable${q("rep", "&contextId=" + ctx.rep)}`);
  ok("changing item 222 invalidates its approval but not item 111's", !r.j.overrides.some((o) => o.id === pending15.id) && r.j.overrides.some((o) => o.id === auto.id), r.j);
  const inv = await Override.findById(pending15.id);
  ok("the stale one is INVALIDATED (CART_CHANGED) and audited", inv.status === "INVALIDATED" && inv.invalidatedReason === "CART_CHANGED" && !!(await Audit.findOne({ action: "override.invalidated", objectId: pending15.id })), inv.status);

  await saveCart("rep", [{ variantId: "111", quantity: 11 }, { variantId: "222", quantity: 99 }]);
  r = await call("GET", `/api/internal/agent/overrides/usable${q("rep", "&contextId=" + ctx.rep)}`);
  ok("changing item 111's quantity invalidates item 111's exception", !r.j.overrides.some((o) => o.id === auto.id), r.j);

  // an order-level exception goes stale on any cart change
  await saveCart("rep", CART);
  r = await call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctx.rep, type: "ORDER_DISCOUNT", baseline: { amount: 100000, currency: "INR" }, proposed: { amount: 97000, currency: "INR" }, reasonCode: "LOYALTY", reasonText: "Repeat buyer" });
  ok("an order discount of 3% (rep's limit 5%) is auto-approved", r.j.status === "AUTO_APPROVED" && r.j.deltaPercent === 3, r);
  const orderLevel = r.j;
  await saveCart("rep", [{ variantId: "111", quantity: 10 }]);
  ok("any change to the cart invalidates a whole-order exception", (await Override.findById(orderLevel.id)).status === "INVALIDATED");

  // ================= applying =================
  await saveCart("rep", CART);
  r = await ask("rep", { lineVariantId: "111", ...price(5) });
  const toApply = r.j;
  r = await call("POST", "/api/internal/agent/overrides/applied", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctx.rep, ids: [toApply.id], orderId: "gid://shopify/Order/9" });
  ok("checkout marks it applied to the order", r.s === 200 && r.j.applied.length === 1, r);
  const applied = await Override.findById(toApply.id);
  ok("status APPLIED with the order id; audited", applied.status === "APPLIED" && applied.appliedOrderId === "gid://shopify/Order/9" && !!(await Audit.findOne({ action: "override.applied", objectId: toApply.id })), applied.status);
  r = await call("POST", "/api/internal/agent/overrides/applied", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctx.rep, ids: [toApply.id], orderId: "gid://shopify/Order/10" });
  ok("an exception can't be applied to a second order", r.j.applied.length === 0, r);

  // ================= expiry =================
  r = await ask("rep", { lineVariantId: "222", ...price(15) });
  const old = r.j;
  await Override.updateOne({ _id: old.id }, { expiresAt: new Date(Date.now() - 1000) });
  r = await call("GET", "/api/approvals?status=all", null, AH);
  ok("overdue requests become EXPIRED when listed", r.s === 200 && r.j.approvals.find((a) => String(a._id) === old.id).status === "EXPIRED", r.j.approvals && r.j.approvals.map((a) => a.status));
  r = await decideAgent("mgr", old.id, "approve", "late");
  ok("an expired request can't be approved", r.s === 409, r);

  // ================= merchant queue =================
  r = await ask("rep", { lineVariantId: "222", ...price(15) });
  const forMerchant = r.j;
  r = await call("GET", "/api/approvals", null, AH);
  ok("merchant queue defaults to pending, with names", r.s === 200 && r.j.approvals.length >= 1 && r.j.approvals.every((a) => a.status === "PENDING_APPROVAL") && r.j.approvals[0].customerName, r);
  r = await call("GET", "/api/approvals?status=NOPE", null, AH);
  ok("bad status filter -> 400", r.s === 400, r);
  r = await call("POST", `/api/approvals/${forMerchant.id}/decision`, { decision: "reject", comment: "" }, AH);
  ok("merchant must also comment to reject", r.s === 400, r);
  r = await call("POST", `/api/approvals/${forMerchant.id}/decision`, { decision: "approve", comment: "Merchant OK" }, AH);
  ok("merchant approves (no personal limit)", r.s === 200 && r.j.status === "APPROVED" && r.j.decisions[0].kind === "merchant_user", r);
  r = await call("GET", "/api/approvals", null, IH);
  ok("merchant endpoints need a merchant login", r.s === 401, r);

  // ================= step-up for approvers =================
  const stepReq = (await ask("rep", { lineVariantId: "222", ...price(18) })).j;
  await call("PUT", "/api/roles/sales_manager", { requireMfa: true }, AH);
  r = await decideAgent("mgr", stepReq.id, "approve", "ok");
  ok("approving is high-risk: a role needing MFA must step up first", r.s === 403 && r.j.code === "STEP_UP_REQUIRED", r);
  r = await call("GET", "/api/internal/agent/approvals" + q("mgr"));
  ok("...and the queue is empty until then", !r.j.approvals.some((a) => a.id === stepReq.id), r);
  ok("...but it says a step-up check is what's needed", r.j.needsStepUp === true, r);
  const en = await call("POST", "/api/internal/agent/mfa/enroll", { shop, agentShopifyCustomerId: gid("mgr") });
  await call("POST", "/api/internal/agent/mfa/verify", { shop, agentShopifyCustomerId: gid("mgr"), code: totp.codeForStep(en.j.secret, totp.stepAt(Date.now())), purpose: "step_up" });
  r = await call("GET", "/api/internal/agent/approvals" + q("mgr"));
  ok("after the check the queue shows it, and no step-up is asked for", r.j.approvals.some((a) => a.id === stepReq.id) && r.j.needsStepUp === false, r);
  r = await decideAgent("mgr", stepReq.id, "approve", "ok");
  ok("after a step-up check the manager can approve", r.s === 200, r);

  // ================= the other exception types =================
  r = await call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctx.rep, type: "SHIPPING_PRICE", baseline: { amount: 800, currency: "INR" }, proposed: { amount: 0, currency: "INR" }, reasonCode: "SERVICE_RECOVERY", reasonText: "Late last time" });
  ok("free shipping (rep has shipping.override, no limit) -> auto-approved, 100% off", r.j.status === "AUTO_APPROVED" && r.j.deltaPercent === 100, r);
  r = await call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctx.rep, type: "QUANTITY_RULE", lineVariantId: "111", baseline: { amount: 24, currency: "QTY" }, proposed: { amount: 12, currency: "QTY" }, reasonCode: "CONTRACT_TERMS", reasonText: "Half-case trial" });
  ok("quantity rule relaxed 24 -> 12 is 50% and allowed for the rep", r.j.status === "AUTO_APPROVED" && r.j.deltaPercent === 50, r);
  r = await call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid("rep"), contextId: ctx.rep, type: "CUSTOM_LINE", custom: { title: "Install fee", quantity: 1, taxCode: "STD" }, baseline: { amount: 0, currency: "INR" }, proposed: { amount: 5000, currency: "INR" }, reasonCode: "OTHER", reasonText: "Install fee" });
  ok("custom line without the permission -> DENIED", r.j.status === "DENIED" && r.j.denyReason === "PERMISSION_DENIED", r);
  r = await call("POST", "/api/internal/agent/overrides", { shop, agentShopifyCustomerId: gid("admin"), contextId: ctx.admin, type: "CUSTOM_LINE", custom: { title: "Install fee", quantity: 1, taxCode: "STD" }, baseline: { amount: 0, currency: "INR" }, proposed: { amount: 5000, currency: "INR" }, reasonCode: "OTHER", reasonText: "Install fee" });
  ok("an administrator may add a custom line (no baseline, no percent)", r.j.status === "AUTO_APPROVED" && r.j.deltaPercent === null, r);

  // ================= evidence =================
  const evidence = await Audit.findOne({ action: "override.requested", objectId: auto.id });
  ok("audit holds baseline, proposal, delta and reason for the request", evidence && evidence.metadata.baseline.amount === 45000 && evidence.metadata.proposed.amount === 42500 && evidence.metadata.deltaPercent === 5.56 && evidence.metadata.reasonCode === "VOLUME_COMMITMENT", evidence);
  ok("the decision is audited with who and what", !!(await Audit.findOne({ action: "override.decided", objectId: pending15.id, "metadata.comment": "Fine for this volume" })));
  const types = (await Outbox.find({ shop }).lean()).map((e) => e.type);
  ok("override.requested and override.decided events are queued", types.includes("sales_agent.override.requested") && types.includes("sales_agent.override.decided"));
  const aOverride = await Override.findById(pending15.id).lean();
  ok("request keeps the role version it was judged under", typeof aOverride.policyVersion === "number");

  // ================= role upgrade (existing built-in roles gain approval.decide) =================
  const shop2 = "old.myshopify.com";
  await Role.create({ shop: shop2, key: "sales_manager", name: "Sales manager", isSystem: true, version: 3, permissions: [{ key: "price.override", effect: "allow", constraints: { maxDeltaPercent: 5 } }] });
  await Role.create({ shop: shop2, key: "sales_admin", name: "Sales administrator", isSystem: true, version: 2, permissions: [{ key: "approval.decide", effect: "deny" }] });
  await ensureSystemRoles(shop2);
  const up = await Role.findOne({ shop: shop2, key: "sales_manager" }).lean();
  ok("an older built-in role gains approval.decide", up.permissions.some((p) => p.key === "approval.decide" && p.constraints.maxDeltaPercent === 30) && up.version === 4 && up.seededVersion === 6 && up.permissions.some((p) => p.key === "audit.read") && up.permissions.some((p) => p.key === "payment_link.send"), up);
  ok("its other settings are left alone", up.permissions.find((p) => p.key === "price.override").constraints.maxDeltaPercent === 5);
  const kept = await Role.findOne({ shop: shop2, key: "sales_admin" }).lean();
  ok("an administrator's own choice (deny) is not overwritten", kept.permissions.filter((p) => p.key === "approval.decide").length === 1 && kept.permissions.find((p) => p.key === "approval.decide").effect === "deny" && kept.version === 3, kept);
  await ensureSystemRoles(shop2);
  ok("running the upgrade again changes nothing", (await Role.findOne({ shop: shop2, key: "sales_manager" })).version === 4);

  // ================= settings =================
  r = await call("PUT", "/api/agent-settings", { hardFloorPercent: 150 }, AH);
  ok("settings: floor out of range refused", r.s === 400, r);
  r = await call("PUT", "/api/agent-settings", { requestTtlHours: 0 }, AH);
  ok("settings: ttl out of range refused", r.s === 400, r);
  r = await call("PUT", "/api/agent-settings", { requestTtlHours: 48 }, AH);
  ok("settings saved and audited", r.s === 200 && r.j.requestTtlHours === 48 && !!(await Audit.findOne({ action: "settings.updated" })), r);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch (x) {} process.exit(1); });
