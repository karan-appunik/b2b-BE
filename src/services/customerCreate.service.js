const Customer = require("../models/customer.model");
const AgentScopeGrant = require("../models/agentScopeGrant.model");
const { authorizeAgent } = require("./agentAccess.service");
const { getSettings } = require("./override.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");
const { EVENT_TYPES, emitEvent } = require("./outbox.service");
const { maskEmail } = require("./paymentLink.service");

// Creating a customer at a trade event (spec §3.4). A privileged agent makes a
// provisional account: duplicates are checked, the business fields and consent
// are required, a safe default group is applied through a tag, and ordering can
// be held until the merchant approves it. Creating the account and entering it
// for a first order are separate operations — nothing here opens a context.

class CustomerCreateError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.statusCode = status;
    this.extra = extra;
  }
}

const COMPANY_SUFFIXES = new Set(["inc", "llc", "ltd", "limited", "co", "corp", "corporation", "company", "pvt", "plc", "gmbh"]);

// "Acme Trading Co." and "ACME trading" are the same business.
function normalizeCompany(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(" ")
    .filter((w) => w && !COMPANY_SUFFIXES.has(w))
    .join(" ");
}

const digits = (value) => String(value || "").replace(/\D/g, "");
const clean = (value) => String(value ?? "").trim();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(input, settings) {
  const fields = {};
  const company = clean(input.companyName);
  const first = clean(input.firstName);
  const last = clean(input.lastName);
  const email = clean(input.email).toLowerCase();
  const a = input.address || {};

  if (!company) fields.companyName = "Company name is required";
  if (!first) fields.firstName = "First name is required";
  if (!last) fields.lastName = "Last name is required";
  if (!EMAIL_RE.test(email)) fields.email = "A valid email is required";
  if (!clean(a.address1)) fields.address1 = "Address is required";
  if (!clean(a.city)) fields.city = "City is required";
  if (!clean(a.zip)) fields.zip = "Postal code is required";
  if (!/^[A-Za-z]{2}$/.test(clean(a.countryCode))) fields.countryCode = "A 2-letter country code is required";
  if (settings.requireTaxId && !clean(input.taxId)) fields.taxId = "Tax ID is required";
  if (input.consent !== true) fields.consent = "The customer must agree to be contacted and to their details being stored";

  if (Object.keys(fields).length) {
    throw new CustomerCreateError("VALIDATION", "Please fix the highlighted fields", 400, { fields });
  }

  return {
    companyName: company,
    firstName: first,
    lastName: last,
    email,
    phone: clean(input.phone),
    taxId: clean(input.taxId),
    legalEntity: clean(input.legalEntity),
    marketingConsent: input.marketingConsent === true,
    address: {
      address1: clean(a.address1),
      address2: clean(a.address2),
      city: clean(a.city),
      zip: clean(a.zip),
      provinceCode: clean(a.provinceCode),
      countryCode: clean(a.countryCode).toUpperCase(),
    },
  };
}

async function requireCreatePermission(shop, agent) {
  const auth = await authorizeAgent(shop, agent, "customer.create");
  if (auth.allowed) return auth;

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
    action: AUDIT_ACTIONS.CUSTOMER_CREATE_DENIED,
    outcome: "denied",
    reasonCode: auth.stepUpRequired ? "STEP_UP_REQUIRED" : "PERMISSION_DENIED",
  });

  if (auth.stepUpRequired) {
    throw new CustomerCreateError("STEP_UP_REQUIRED", "Confirm your authenticator code to create a customer", 403);
  }
  throw new CustomerCreateError("PERMISSION_DENIED", "Your role can't create customers", 403);
}

// Customers that look like the one being made. An identical email is never
// allowed; a matching company, phone or tax id is a warning the agent must
// confirm. Only a little is shown: the agent may not have access to them.
async function findDuplicates(shop, v) {
  const sameEmail = await Customer.findOne({ shop, email: v.email });
  if (sameEmail) return { exactEmail: true, similar: [] };

  const companyKey = normalizeCompany(v.companyName);
  const phone = digits(v.phone);
  const or = [];
  if (v.taxId) or.push({ taxId: new RegExp(`^${v.taxId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
  if (phone.length >= 7) or.push({ phoneKey: phone.slice(-9) });
  if (companyKey) {
    const first = companyKey.split(" ")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    or.push({ company: new RegExp(first, "i") }, { shopifyCompanyName: new RegExp(first, "i") });
  }

  const candidates = or.length ? await Customer.find({ shop, $or: or }).limit(200) : [];
  const similar = [];

  for (const c of candidates) {
    const reasons = [];
    const names = [c.company, c.shopifyCompanyName].map(normalizeCompany).filter(Boolean);
    if (companyKey && names.includes(companyKey)) reasons.push("Same company name");
    if (phone.length >= 7 && c.phoneKey === phone.slice(-9)) reasons.push("Same phone number");
    if (v.taxId && c.taxId && c.taxId.toLowerCase() === v.taxId.toLowerCase()) reasons.push("Same tax ID");

    if (reasons.length) {
      similar.push({ name: c.company || c.shopifyCompanyName || c.name, email: maskEmail(c.email), reasons });
    }
  }

  return { exactEmail: false, similar };
}

// Step 1: everything is checked before anything is created in Shopify.
async function check({ shop, agent, input, confirmNotDuplicate }) {
  await requireCreatePermission(shop, agent);
  const settings = await getSettings(shop);
  const values = validate(input || {}, settings);

  const dup = await findDuplicates(shop, values);
  const base = { shop, actorType: "sales_agent", actor: agent._id, actorShopifyCustomerId: agent.shopifyCustomerId };

  if (dup.exactEmail) {
    await recordAudit({ ...base, action: AUDIT_ACTIONS.CUSTOMER_CREATE_DENIED, outcome: "denied", reasonCode: "DUPLICATE_EMAIL" });
    throw new CustomerCreateError("DUPLICATE_EMAIL", "A customer with this email already exists. Search for them instead.", 409);
  }

  if (dup.similar.length && confirmNotDuplicate !== true) {
    await recordAudit({ ...base, action: AUDIT_ACTIONS.CUSTOMER_CREATE_DENIED, outcome: "denied", reasonCode: "POSSIBLE_DUPLICATE", metadata: { matches: dup.similar.length } });
    throw new CustomerCreateError("POSSIBLE_DUPLICATE", "Similar customers already exist. Check them, or confirm this is a different business.", 409, { duplicates: dup.similar });
  }

  return { values, tags: settings.newCustomerTags, duplicatesConfirmed: dup.similar.length > 0 };
}

// Step 2: the account now exists in Shopify; keep our own copy. Safe to repeat
// for the same Shopify customer.
async function record({ shop, agent, shopifyCustomerId, input, duplicatesConfirmed }) {
  await requireCreatePermission(shop, agent);
  const settings = await getSettings(shop);
  const values = validate(input || {}, settings);

  if (!/^gid:\/\/shopify\/Customer\/\d+$/.test(String(shopifyCustomerId || ""))) {
    throw new CustomerCreateError("INVALID_CUSTOMER", "A Shopify customer id is required");
  }

  const now = new Date();
  const existing = await Customer.findOne({ shop, shopifyCustomerId });
  const already = !!(existing && existing.createdByAgent);

  const customer = await Customer.findOneAndUpdate(
    { shop, shopifyCustomerId },
    {
      $set: {
        name: `${values.firstName} ${values.lastName}`,
        email: values.email,
        company: values.companyName,
        phone: values.phone,
        phoneKey: digits(values.phone).length >= 7 ? digits(values.phone).slice(-9) : undefined,
        taxId: values.taxId,
        legalEntity: values.legalEntity,
        tags: settings.newCustomerTags,
        provisional: true,
        createdByAgent: agent._id,
        region: { countryCode: values.address.countryCode, provinceCode: values.address.provinceCode.toUpperCase(), zip: values.address.zip },
        consent: { dataProcessing: true, marketing: values.marketingConsent, at: now },
        addresses: [
          {
            firstName: values.firstName,
            lastName: values.lastName,
            company: values.companyName,
            address1: values.address.address1,
            address2: values.address.address2,
            city: values.address.city,
            zip: values.address.zip,
            country: values.address.countryCode,
            province: values.address.provinceCode,
            phone: values.phone,
            isDefault: true,
          },
        ],
      },
      $setOnInsert: { role: "customer" },
    },
    { upsert: true, new: true }
  );

  if (!already) {
    // The agent who made the account can open it; nobody else gains access.
    const hasAccess = await AgentScopeGrant.findOne({ shop, agent: agent._id, scopeType: "customer", scopeId: String(customer._id), effect: "allow" });
    if (!hasAccess) {
      await AgentScopeGrant.create({ shop, agent: agent._id, scopeType: "customer", scopeId: String(customer._id), effect: "allow" });
    }

    await recordAudit({
      shop,
      actorType: "sales_agent",
      actor: agent._id,
      actorShopifyCustomerId: agent.shopifyCustomerId,
      customer: customer._id,
      action: AUDIT_ACTIONS.CUSTOMER_CREATED,
      objectType: "customer",
      objectId: String(customer._id),
      metadata: { provisional: true, duplicatesConfirmed: !!duplicatesConfirmed, tags: settings.newCustomerTags },
    });
    await emitEvent(shop, EVENT_TYPES.CUSTOMER_CREATED, {
      customer_id: String(customer._id),
      shopify_customer_id: shopifyCustomerId,
      created_by: String(agent._id),
      provisional: true,
    });
  }

  return customer;
}

async function listProvisional(shop) {
  const rows = await Customer.find({ shop, provisional: true }).sort({ createdAt: -1 }).limit(200);
  const agents = await Customer.find({ _id: { $in: rows.map((r) => r.createdByAgent).filter(Boolean) } }).select("name");
  const byId = new Map(agents.map((a) => [String(a._id), a.name]));

  return rows.map((c) => ({
    id: c._id,
    name: c.name,
    company: c.company || null,
    email: c.email,
    phone: c.phone || null,
    taxId: c.taxId || null,
    createdAt: c.createdAt,
    createdBy: byId.get(String(c.createdByAgent)) || null,
  }));
}

async function approveProvisional({ shop, customerId, user }) {
  const customer = await Customer.findOneAndUpdate(
    { _id: customerId, shop, provisional: true },
    { $set: { provisional: false, approvedAt: new Date(), approvedBy: user._id } },
    { new: true }
  );
  if (!customer) throw new CustomerCreateError("NOT_FOUND", "No provisional customer found", 404);

  await recordAudit({
    shop,
    actorType: "merchant_user",
    actor: user._id,
    customer: customer._id,
    action: AUDIT_ACTIONS.CUSTOMER_APPROVED,
    objectType: "customer",
    objectId: String(customer._id),
  });

  return customer;
}

// An address added to a customer on their behalf is recorded: who, for whom,
// and where (spec §10.3 "address changes"). The street itself stays in Shopify.
async function recordAddress({ shop, agent, customer, address }) {
  const auth = await authorizeAgent(shop, agent, "address.create");
  if (!auth.allowed) throw new CustomerCreateError("PERMISSION_DENIED", "Your role can't add addresses", 403);

  await recordAudit({
    shop,
    actorType: "sales_agent",
    actor: agent._id,
    actorShopifyCustomerId: agent.shopifyCustomerId,
    customer: customer._id,
    action: AUDIT_ACTIONS.ADDRESS_CREATED,
    objectType: "customer",
    objectId: String(customer._id),
    metadata: { city: clean(address && address.city), country: clean(address && address.country), setDefault: !!(address && address.setDefault) },
  });
}

module.exports = { recordAddress, CustomerCreateError, normalizeCompany, check, record, listProvisional, approveProvisional };
