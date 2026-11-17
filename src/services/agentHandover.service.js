const Quote = require("../models/quote.model");
const OverrideRequest = require("../models/overrideRequest.model");
const AgentCart = require("../models/agentCart.model");
const Customer = require("../models/customer.model");
const { isAgentRole } = require("./agentAccess.service");
const { notify } = require("./notification.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");

// When an agent is disabled (spec §2.4: "ownership of open work must be
// reassigned"; §12: "route owned work to manager or queue"): their waiting
// exceptions are withdrawn, their open quotes and saved carts go to the person
// chosen (or stay with a note), and the managers are told what is left.

const OPEN_QUOTE_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "ACCEPTED", "CHANGES_REQUESTED"];
const LIVE_OVERRIDES = ["PENDING_APPROVAL", "APPROVED", "AUTO_APPROVED"];

async function handOverWork({ shop, agent, toAgentId, actor }) {
  const target = toAgentId ? await Customer.findOne({ _id: toAgentId, shop }) : null;
  if (toAgentId && (!target || !isAgentRole(target.role) || String(target._id) === String(agent._id))) {
    const err = new Error("Choose another active agent to take over");
    err.statusCode = 400;
    err.code = "INVALID_HANDOVER";
    throw err;
  }

  const now = new Date();

  // Exceptions that were waiting on a decision can't go anywhere without their
  // owner: they are withdrawn. Approved ones simply expire unused.
  const withdrawn = await OverrideRequest.updateMany(
    { shop, agent: agent._id, status: { $in: LIVE_OVERRIDES } },
    { $set: { status: "CANCELLED" } }
  );

  // Quotes keep their history; ownership moves, and the move is on the timeline.
  const openQuotes = await Quote.find({ shop, ownerAgent: agent._id, status: { $in: OPEN_QUOTE_STATUSES } });
  let quotesMoved = 0;
  if (target) {
    for (const quote of openQuotes) {
      quote.ownerAgent = target._id;
      quote.activity.push({ at: now, type: "reassigned", byKind: "merchant_user", byName: actor ? actor.name : "Administrator", comment: `From ${agent.name} to ${target.name}` });
      await quote.save();
      quotesMoved += 1;
    }
  }

  // A saved cart moves only if the new agent has none for that customer.
  const carts = await AgentCart.find({ shop, agent: agent._id });
  let cartsMoved = 0;
  if (target) {
    for (const cart of carts) {
      const clash = await AgentCart.findOne({ shop, agent: target._id, customer: cart.customer });
      if (clash) continue;
      cart.agent = target._id;
      await cart.save();
      cartsMoved += 1;
    }
  }

  // Delegations they gave or received end with them (Phase 4).
  const delegationsEnded = await require("./delegation.service").endForAgent({
    shop,
    agentId: agent._id,
    reason: "The agent was disabled",
    actor: actor ? { actorType: "merchant_user", actor: actor._id } : undefined,
  });

  const summary = {
    delegationsEnded,
    exceptionsWithdrawn: withdrawn.modifiedCount,
    openQuotes: openQuotes.length,
    quotesMoved,
    savedCarts: carts.length,
    cartsMoved,
    handedTo: target ? target.name : null,
  };

  await recordAudit({
    shop,
    actorType: actor ? "merchant_user" : "system",
    actor: actor ? actor._id : undefined,
    action: AUDIT_ACTIONS.AGENT_WORK_REASSIGNED,
    objectType: "customer",
    objectId: String(agent._id),
    metadata: summary,
  });

  // The people who can act on what is left are told. With a named successor
  // that is mainly them; otherwise it is everyone who can approve.
  const staying = summary.openQuotes - summary.quotesMoved;
  const lines = [];
  if (summary.exceptionsWithdrawn) lines.push(`${summary.exceptionsWithdrawn} exception(s) were withdrawn.`);
  if (staying > 0) lines.push(`${staying} open quote(s) still have no new owner.`);
  if (summary.savedCarts - summary.cartsMoved > 0) lines.push(`${summary.savedCarts - summary.cartsMoved} saved cart(s) were left.`);

  if (target) {
    await notify({
      shop,
      recipient: target,
      type: "agent.handover",
      title: `You took over ${agent.name}'s work`,
      body: `${summary.quotesMoved} quote(s) and ${summary.cartsMoved} saved cart(s) moved to you.`,
      link: "/account",
      dedupeKey: `handover:${agent._id}:${now.getTime()}`,
    });
  }

  if (lines.length) {
    const managers = (await Customer.find({ shop, role: { $ne: "customer" }, _id: { $ne: agent._id } })).filter((a) => isAgentRole(a.role) && ["sales_manager", "sales_admin"].includes(a.role));
    for (const manager of managers) {
      await notify({
        shop,
        recipient: manager,
        type: "agent.disabled",
        title: `${agent.name} was disabled`,
        body: lines.join(" "),
        link: "/account",
        dedupeKey: `disabled:${agent._id}:${now.getTime()}`,
      });
    }
  }

  return summary;
}

module.exports = { handOverWork };
