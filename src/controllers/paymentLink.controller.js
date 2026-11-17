const mongoose = require("mongoose");

const { findAgentByShopifyId } = require("../services/agentAccess.service");
const links = require("../services/paymentLink.service");

// Payment links (spec §9.4). The agent sends one and never touches card data;
// the buyer opens it on their own signed-in account; Shopify reports payment
// back and the link is reconciled against what was asked for.

function guard(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof links.PaymentLinkError) {
        return res.status(err.statusCode).json({ code: err.code, message: err.message });
      }
      next(err);
    }
  };
}

async function agentFrom(source, res) {
  const agent = await findAgentByShopifyId(source.shop, source.agentShopifyCustomerId);
  if (!agent) {
    res.status(403).json({ message: "Not authorized" });
    return null;
  }
  return agent;
}

// POST /api/internal/agent/payment-links — the storefront proxy has already
// confirmed the draft order is this agent's and read its total from Shopify.
const createLink = guard(async (req, res) => {
  const agent = await agentFrom(req.body, res);
  if (!agent) return;

  const { link, emailMasked } = await links.createLink({
    shop: req.body.shop,
    agent,
    customerShopifyId: req.body.customerShopifyId,
    draftOrderId: req.body.draftOrderId,
    invoiceUrl: req.body.invoiceUrl,
    amount: req.body.amount,
    currency: req.body.currency,
    quoteId: mongoose.isValidObjectId(req.body.quoteId) ? req.body.quoteId : undefined,
    shipTo: req.body.shipTo,
  });

  // The token is never returned: only the buyer's email holds it.
  res.status(201).json({ ...links.present(link), emailMasked, token: link.token });
});

const listOwned = guard(async (req, res) => {
  const agent = await agentFrom(req.query, res);
  if (!agent) return;

  const rows = await links.listForAgent(req.query.shop, agent);
  res.status(200).json({ links: rows.map(links.present) });
});

const revokeOwned = guard(async (req, res) => {
  const agent = await agentFrom(req.body, res);
  if (!agent) return;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ code: "NOT_FOUND", message: "Payment link not found" });

  const link = await links.revokeLink({ shop: req.body.shop, linkId: req.params.id, agent });
  res.status(200).json(links.present(link));
});

// POST /api/internal/customer/payment-links/resolve — the buyer opens a link.
const resolveForBuyer = guard(async (req, res) => {
  const { invoiceUrl, link } = await links.resolveForBuyer({
    shop: req.body.shop,
    token: req.body.token,
    buyerShopifyCustomerId: req.body.buyerShopifyCustomerId,
  });

  res.status(200).json({ invoiceUrl, amount: link.amount, currency: link.currency });
});

// POST /api/internal/payment-links/paid — Shopify says the order is paid.
const markPaid = guard(async (req, res) => {
  const result = await links.markPaid({
    shop: req.body.shop,
    token: req.body.token,
    orderId: req.body.orderId,
    amount: req.body.amount,
    currency: req.body.currency,
    extras: req.body.extras,
  });

  res.status(200).json({ found: result.found, already: !!result.already });
});

// POST /api/internal/payment-links/order-changed — the order's total changed.
const orderChanged = guard(async (req, res) => {
  const count = await links.invalidateForOrder({
    shop: req.body.shop,
    draftOrderId: req.body.draftOrderId,
    reason: "ORDER_TOTAL_CHANGED",
  });

  res.status(200).json({ revoked: count });
});

// ---- merchant panel

const listForMerchant = guard(async (req, res) => {
  res.status(200).json({ links: await links.listForMerchant(req.user.shop) });
});

const revokeForMerchant = guard(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ code: "NOT_FOUND", message: "Payment link not found" });

  const link = await links.revokeLink({ shop: req.user.shop, linkId: req.params.id, user: req.user });
  res.status(200).json(links.present(link));
});

module.exports = {
  createLink,
  listOwned,
  revokeOwned,
  resolveForBuyer,
  markPaid,
  orderChanged,
  listForMerchant,
  revokeForMerchant,
};
