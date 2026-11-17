const mongoose = require("mongoose");

const AgentCart = require("../models/agentCart.model");
const { validateContext } = require("../services/agentContext.service");
const { authorizeAgent } = require("../services/agentAccess.service");
const { invalidateForCart } = require("../services/override.service");

const MAX_ITEMS = 200;

function contextRequired(res, reason = "CONTEXT_REQUIRED") {
  return res.status(401).json({ code: reason, message: "Customer context is required" });
}

function cartPayload(cart) {
  return {
    items: cart ? cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) : [],
    currency: cart ? cart.currency || null : null,
    version: cart ? cart.version : 0,
  };
}

// Every call is tied to a live context: the cart belongs to the customer
// that context represents, so an agent can only ever read or write the cart
// of an account they are currently authorized for.
async function resolveContext(req, res, source, permissionKey) {
  const { shop, agentShopifyCustomerId, contextId } = source;

  if (!agentShopifyCustomerId || !mongoose.isValidObjectId(contextId)) {
    contextRequired(res);
    return null;
  }

  const result = await validateContext({ shop, contextId, agentShopifyCustomerId });
  if (!result.valid) {
    contextRequired(res, result.reason);
    return null;
  }

  if (!(await authorizeAgent(shop, result.agent, permissionKey)).allowed) {
    res.status(403).json({ code: "PERMISSION_DENIED", message: "You do not have permission to do this" });
    return null;
  }

  return result;
}

// GET /api/internal/agent/carts/current
async function getCurrentCart(req, res, next) {
  try {
    const context = await resolveContext(req, res, req.query, "cart.create");
    if (!context) return;

    const cart = await AgentCart.findOne({
      shop: req.query.shop,
      agent: context.agent._id,
      customer: context.customer._id,
    });

    res.status(200).json(cartPayload(cart));
  } catch (err) {
    next(err);
  }
}

// PUT /api/internal/agent/carts/current — replaces the saved cart with the
// lines sent. `expectedVersion` (when given) must match, otherwise another
// device saved in between and the caller must refresh instead of overwriting.
async function saveCurrentCart(req, res, next) {
  try {
    const context = await resolveContext(req, res, req.body, "cart.write");
    if (!context) return;

    const { shop, items, currency, expectedVersion } = req.body;

    if (!Array.isArray(items) || items.length > MAX_ITEMS) {
      return res.status(400).json({ message: `items must be an array of at most ${MAX_ITEMS} lines` });
    }

    const lines = new Map();
    for (const item of items) {
      const variantId = String(item && item.variantId ? item.variantId : "").trim();
      const quantity = Number(item && item.quantity);
      if (!variantId || !Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({ message: "each item needs a variantId and a whole quantity of at least 1" });
      }
      lines.set(variantId, (lines.get(variantId) || 0) + quantity);
    }
    const cleanItems = [...lines].map(([variantId, quantity]) => ({ variantId, quantity }));

    const filter = { shop, agent: context.agent._id, customer: context.customer._id };
    const existing = await AgentCart.findOne(filter);

    if (existing && expectedVersion != null && Number(expectedVersion) !== existing.version) {
      return res.status(409).json({
        code: "VERSION_CONFLICT",
        conflict: true,
        message: "This cart was changed elsewhere. Refresh and try again.",
        ...cartPayload(existing),
      });
    }

    const cart = await AgentCart.findOneAndUpdate(
      filter,
      {
        $set: { items: cleanItems, currency: currency || null },
        $inc: { version: 1 },
        $setOnInsert: { shop, agent: context.agent._id, customer: context.customer._id },
      },
      { new: true, upsert: true }
    );

    // Exceptions that were about the old cart no longer apply (spec §8.4).
    await invalidateForCart(shop, cart);

    res.status(200).json(cartPayload(cart));
  } catch (err) {
    next(err);
  }
}

module.exports = { getCurrentCart, saveCurrentCart };
