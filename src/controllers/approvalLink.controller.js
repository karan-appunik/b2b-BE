const links = require("../services/approvalLink.service");
const { OverrideError } = require("../services/override.service");

// The pages behind the links in approvers' emails. The storefront tells us who
// is signed in; the link only answers for the approver it was made for.

function guard(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof links.ApprovalLinkError || err instanceof OverrideError) {
        return res.status(err.statusCode).json({ code: err.code, message: err.message });
      }
      next(err);
    }
  };
}

// POST /api/internal/agent/approval-links/open
const open = guard(async (req, res) => {
  const request = await links.open({
    shop: req.body.shop,
    token: req.body.token,
    approverShopifyCustomerId: req.body.agentShopifyCustomerId,
  });

  res.status(200).json({
    id: request._id,
    type: request.type,
    agentName: request.agentName,
    customerName: request.customerCompany || request.customerName,
    baseline: request.baseline,
    proposed: request.proposed,
    deltaPercent: request.deltaPercent,
    reasonText: request.reasonText,
    custom: request.custom && request.custom.title ? { title: request.custom.title, quantity: request.custom.quantity } : null,
    impact: request.impact,
    history: request.history,
    expiresAt: request.expiresAt,
  });
});

// POST /api/internal/agent/approval-links/decide
const decide = guard(async (req, res) => {
  const request = await links.decide({
    shop: req.body.shop,
    token: req.body.token,
    approverShopifyCustomerId: req.body.agentShopifyCustomerId,
    decision: req.body.decision,
    comment: req.body.comment,
  });

  res.status(200).json({ status: request.status });
});

module.exports = { open, decide };
