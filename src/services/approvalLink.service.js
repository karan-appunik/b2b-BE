const crypto = require("crypto");

const ApprovalLink = require("../models/approvalLink.model");
const OverrideRequest = require("../models/overrideRequest.model");
const Customer = require("../models/customer.model");
const overrides = require("./override.service");
const { findAgentByShopifyId, isAgentRole } = require("./agentAccess.service");
const { sendApprovalLinkEmail } = require("./email.service");
const { notify } = require("./notification.service");

class ApprovalLinkError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.statusCode = status;
  }
}

const hash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

function linkUrl(shop, token) {
  return `https://${shop}/apps/sparklayer/approve/${token}`;
}

// Emails every approver who could decide this request, each with a link of
// their own. Someone who is held back only by the authenticator check is still
// sent one: they confirm the code when they open it. Returns the tokens that
// were made (the caller only needs the count; tests read them).
async function issueForRequest(request) {
  if (request.status !== "PENDING_APPROVAL") return [];

  const agents = await Customer.find({ shop: request.shop, role: { $ne: "customer" } });
  const issued = [];
  const details = (await overrides.describeRequests([request]))[0];

  for (const agent of agents) {
    if (!isAgentRole(agent.role)) continue;

    const block = await overrides.approvalBlock({ shop: request.shop, request, approver: { kind: "agent", agent } });
    if (block !== null && block !== "STEP_UP_REQUIRED") continue;

    const token = crypto.randomBytes(32).toString("base64url");
    await ApprovalLink.create({
      shop: request.shop,
      request: request._id,
      approver: agent._id,
      tokenHash: hash(token),
      expiresAt: request.expiresAt,
    });
    issued.push({ approverId: String(agent._id), token });

    // The email carries the link; this is the in-app copy.
    await notify({
      shop: request.shop,
      recipient: agent,
      type: "approval.requested",
      title: "An exception needs your approval",
      body: `${details.agentName || "An agent"} asked for ${request.type.split("_").join(" ").toLowerCase()} for ${details.customerCompany || details.customerName || "a customer"}.`,
      link: "/account",
      dedupeKey: `appr:${request._id}`,
      email: false,
    });

    sendApprovalLinkEmail({
      approver: agent,
      requester: details.agentName,
      customerName: details.customerCompany || details.customerName,
      type: request.type,
      reason: request.reasonText,
      expiresAt: request.expiresAt,
      url: linkUrl(request.shop, token),
    }).catch((err) => console.error("[email] approval link email failed", err));
  }

  return issued;
}

// Looks the link up for the signed-in approver. Anyone else, and a link that
// doesn't exist, get the same answer.
async function load({ shop, token, approverShopifyCustomerId }) {
  const link = await ApprovalLink.findOne({ shop, tokenHash: hash(token) });
  const approver = await findAgentByShopifyId(shop, approverShopifyCustomerId);

  if (!link || !approver || String(link.approver) !== String(approver._id)) {
    throw new ApprovalLinkError("NOT_FOUND", "This approval link isn't available", 404);
  }
  if (link.usedAt) throw new ApprovalLinkError("LINK_USED", "This link has already been used", 410);
  if (link.expiresAt <= new Date()) throw new ApprovalLinkError("LINK_EXPIRED", "This link has expired", 410);

  const request = await OverrideRequest.findOne({ _id: link.request, shop });
  if (!request) throw new ApprovalLinkError("NOT_FOUND", "This approval link isn't available", 404);
  if (request.status !== "PENDING_APPROVAL") {
    throw new ApprovalLinkError("ALREADY_DECIDED", "This request has already been decided", 409);
  }

  return { link, approver, request };
}

async function open({ shop, token, approverShopifyCustomerId }) {
  const { request } = await load({ shop, token, approverShopifyCustomerId });
  return (await overrides.describeRequests([request]))[0];
}

// Decides through the link and uses it up. The link is claimed first so two
// clicks can't both decide; if the decision is refused (say the authenticator
// check is still needed) it is handed back so it can be tried again.
async function decide({ shop, token, approverShopifyCustomerId, decision, comment }) {
  const { link, approver, request } = await load({ shop, token, approverShopifyCustomerId });

  const claimed = await ApprovalLink.findOneAndUpdate({ _id: link._id, usedAt: null }, { $set: { usedAt: new Date() } });
  if (!claimed) throw new ApprovalLinkError("LINK_USED", "This link has already been used", 410);

  try {
    return await overrides.decide({
      shop,
      requestId: request._id,
      approver: { kind: "agent", agent: approver },
      decision,
      comment,
    });
  } catch (err) {
    // A refused decision doesn't use the link up; a made one does.
    const stillPending = await OverrideRequest.findOne({ _id: request._id, status: "PENDING_APPROVAL" });
    if (stillPending) await ApprovalLink.updateOne({ _id: link._id }, { $set: { usedAt: null } });
    throw err;
  }
}

module.exports = { ApprovalLinkError, issueForRequest, open, decide };
