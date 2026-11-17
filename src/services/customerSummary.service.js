const Customer = require("../models/customer.model");
const CustomerGroup = require("../models/customerGroup.model");
const Order = require("../models/order.model");
const Quote = require("../models/quote.model");
const AgentCart = require("../models/agentCart.model");
const { ensureBaseGroup } = require("./customerGroup.service");
const { authorizeAgent } = require("./agentAccess.service");

// What an agent sees about the customer they are ordering for (spec §4.3
// "Summary": contacts, terms, available credit, open orders, open quotes, last
// order). Only what this service holds; addresses come from Shopify in the
// storefront. Notes are not included.

const OPEN_QUOTE = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "ACCEPTED", "CHANGES_REQUESTED"];

async function summarize({ shop, agent, customer }) {
  const base = await ensureBaseGroup(shop);
  const group = customer.customerGroup ? await CustomerGroup.findOne({ _id: customer.customerGroup, shop }) : null;
  const effective = group || base;
  const methods = effective.paymentMethods || base.paymentMethods || {};

  const orders = await Order.find({ shop, shopifyCustomerId: customer.shopifyCustomerId }).sort({ orderedAt: -1 }).limit(200).lean();
  const open = orders.filter((o) => String(o.fulfillmentStatus || "").toLowerCase() !== "fulfilled");
  const last = orders[0];

  const [openQuotes, cart] = await Promise.all([
    Quote.countDocuments({ shop, customer: customer._id, status: { $in: OPEN_QUOTE } }),
    AgentCart.findOne({ shop, agent: agent._id, customer: customer._id }).select("items"),
  ]);

  const limit = customer.creditLimit;
  // Internal notes only for a role that may read them.
  const mayReadNotes = (await authorizeAgent(shop, agent, "customer.notes.read")).allowed;
  return {
    internalNotes: mayReadNotes ? customer.internalNotes || null : undefined,
    customer: {
      name: customer.name,
      company: customer.company || null,
      email: customer.email,
      phone: customer.phone || null,
      territory: customer.territory || null,
      group: effective.name,
      accountStatus: customer.accountStatus || "active",
      provisional: !!customer.provisional,
    },
    terms: {
      payByInvoice: !!methods.invoice,
      payOnAccount: !!methods.onAccount,
      card: methods.cardAtCheckout !== false,
      requestForQuote: !!methods.requestForQuote,
    },
    credit: limit
      ? { limit, balance: customer.creditBalance || 0, available: Math.max(limit - (customer.creditBalance || 0), 0) }
      : null,
    orders: {
      total: orders.length,
      open: open.length,
      last: last ? { name: last.name, orderedAt: last.orderedAt, total: last.totalPrice, currency: last.currency } : null,
    },
    openQuotes,
    savedCartLines: cart ? cart.items.length : 0,
  };
}

// Two accounts that look like the same business, by company or name (case,
// punctuation and "Inc/LLC/Ltd" ignored): shown so an agent can't pick the
// wrong one by mistake (spec §4.3 "pre-entry check").
const SUFFIXES = new Set(["inc", "llc", "ltd", "limited", "co", "corp", "corporation", "company", "pvt", "plc", "gmbh"]);
const key = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(" ")
    .filter((w) => w && !SUFFIXES.has(w))
    .join(" ");

function markSimilar(accounts) {
  const counts = new Map();
  for (const a of accounts) {
    const k = key(a.company || a.name);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  return accounts.map((a) => ({ ...a, similar: (counts.get(key(a.company || a.name)) || 0) > 1 }));
}

module.exports = { summarize, markSimilar, key };
