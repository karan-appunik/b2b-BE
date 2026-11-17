const mongoose = require("mongoose");

const AgentCart = require("../models/agentCart.model");
const AuditEvent = require("../models/auditEvent.model");
const { validateContext } = require("../services/agentContext.service");
const { findAgentByShopifyId, authorizeAgent } = require("../services/agentAccess.service");
const { invalidateForCart } = require("../services/override.service");
const { validateCart } = require("../services/cartValidation.service");
const { summarize } = require("../services/customerSummary.service");

// The endpoints of the specification's catalogue (§7.2) that have no
// counterpart in the internal API. Every call is tied to a live customer
// context; the customer always comes from it.

const MAX_ITEMS = 200;

function deny(res, status, code, message) {
  return res.status(status).json({ code, message });
}

async function liveContext(req, res, source, permission) {
  const { shop, agentShopifyCustomerId, contextId } = source;

  if (!agentShopifyCustomerId || !mongoose.isValidObjectId(contextId)) {
    deny(res, 401, "CONTEXT_REQUIRED", "Customer context is required");
    return null;
  }

  const result = await validateContext({ shop, contextId, agentShopifyCustomerId });
  if (!result.valid) {
    deny(res, 401, result.reason || "CONTEXT_REQUIRED", "Customer context is required");
    return null;
  }

  if (permission && !(await authorizeAgent(shop, result.agent, permission)).allowed) {
    deny(res, 403, "PERMISSION_DENIED", "You do not have permission to do this");
    return null;
  }

  return result;
}

const cartPayload = (cart) => ({
  id: cart ? String(cart._id) : null,
  items: cart ? cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) : [],
  currency: cart ? cart.currency || null : null,
  version: cart ? cart.version : 0,
});

// POST /v1/carts — create the customer's cart, or resume the one they have.
async function createOrResumeCart(req, res, next) {
  try {
    const context = await liveContext(req, res, req.body, "cart.create");
    if (!context) return;

    const filter = { shop: req.body.shop, agent: context.agent._id, customer: context.customer._id };
    const existing = await AgentCart.findOne(filter);
    if (existing) return res.status(200).json(cartPayload(existing));

    const cart = await AgentCart.create({ ...filter, items: [], currency: req.body.currency || null });
    res.status(201).json(cartPayload(cart));
  } catch (err) {
    next(err);
  }
}

// POST /v1/carts/{id}/items — add a variant and a quantity to the cart.
async function addCartItem(req, res, next) {
  try {
    const context = await liveContext(req, res, req.body, "cart.write");
    if (!context) return;

    const variantId = String(req.body.variantId ?? "").trim();
    const quantity = Number(req.body.quantity);
    if (!/^\d{1,20}$/.test(variantId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      return deny(res, 400, "INVALID_ITEM", "variantId and a whole quantity from 1 to 9999 are required");
    }

    const filter = { shop: req.body.shop, agent: context.agent._id, customer: context.customer._id };
    const cart = await AgentCart.findOne(filter);
    if (!cart || (mongoose.isValidObjectId(req.params.id) && String(cart._id) !== req.params.id)) {
      return deny(res, 404, "CART_NOT_FOUND", "Cart not found");
    }

    if (req.body.expectedVersion != null && Number(req.body.expectedVersion) !== cart.version) {
      return res.status(409).json({ code: "VERSION_CONFLICT", message: "This cart was changed elsewhere. Refresh and try again.", ...cartPayload(cart) });
    }

    const line = cart.items.find((i) => i.variantId === variantId);
    if (line) line.quantity = Math.min(line.quantity + quantity, 9999);
    else if (cart.items.length >= MAX_ITEMS) return deny(res, 400, "TOO_MANY_ITEMS", `A cart holds up to ${MAX_ITEMS} lines`);
    else cart.items.push({ variantId, quantity });

    cart.version += 1;
    await cart.save();
    await invalidateForCart(req.body.shop, cart);

    res.status(200).json(cartPayload(cart));
  } catch (err) {
    next(err);
  }
}

// POST /v1/carts/{id}/validate
async function validateCartEndpoint(req, res, next) {
  try {
    const context = await liveContext(req, res, req.body, "cart.create");
    if (!context) return;

    res.status(200).json(await validateCart({ shop: req.body.shop, agent: context.agent, customer: context.customer }));
  } catch (err) {
    next(err);
  }
}

// GET /agent/customer-summary — the customer in the live context (spec §4.3).
async function customerSummary(req, res, next) {
  try {
    const context = await liveContext(req, res, req.query, "customer.search");
    if (!context) return;

    res.status(200).json(await summarize({ shop: req.query.shop, agent: context.agent, customer: context.customer }));
  } catch (err) {
    next(err);
  }
}

const SAFE_FIELDS = ["occurredAt", "actorType", "action", "outcome", "reasonCode", "objectType", "objectId", "customer", "metadata"];

// GET /v1/agent/audit — activity the agent's role lets them read (spec §2.2:
// own activity, or everyone's). Hashes and internal fields are left out.
async function agentAudit(req, res, next) {
  try {
    const { shop, agentShopifyCustomerId } = req.query;
    const agent = await findAgentByShopifyId(shop, agentShopifyCustomerId);
    if (!agent) return deny(res, 403, "PERMISSION_DENIED", "Not authorized");

    const auth = await authorizeAgent(shop, agent, "audit.read");
    if (!auth.allowed) return deny(res, 403, "PERMISSION_DENIED", "Your role can't read activity");

    const own = !!(auth.constraints && auth.constraints.scope === "own");
    const filter = { shop };
    if (own) filter.actor = agent._id;

    for (const key of ["action", "outcome"]) if (req.query[key]) filter[key] = String(req.query[key]);
    if (req.query.customerId) {
      if (!mongoose.isValidObjectId(req.query.customerId)) return deny(res, 400, "INVALID_FILTER", "customerId must be a valid id");
      filter.customer = req.query.customerId;
    }

    const occurredAt = {};
    for (const [param, op] of [["from", "$gte"], ["to", "$lte"], ["before", "$lt"]]) {
      if (!req.query[param]) continue;
      const d = new Date(req.query[param]);
      if (Number.isNaN(d.getTime())) return deny(res, 400, "INVALID_FILTER", `${param} must be a valid date`);
      occurredAt[op] = d;
    }
    if (Object.keys(occurredAt).length) filter.occurredAt = occurredAt;

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const events = await AuditEvent.find(filter).sort({ occurredAt: -1 }).limit(limit).lean();

    res.status(200).json({
      scope: own ? "own" : "all",
      events: events.map((e) => Object.fromEntries(SAFE_FIELDS.filter((f) => e[f] !== undefined).map((f) => [f, e[f]]))),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { customerSummary, createOrResumeCart, addCartItem, validateCartEndpoint, agentAudit };
