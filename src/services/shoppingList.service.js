const ShoppingList = require("../models/shoppingList.model");
const Customer = require("../models/customer.model");
const { findAgentByShopifyId, authorizeAgent, checkCustomerAccess, isAgentRole } = require("./agentAccess.service");
const { AUDIT_ACTIONS, recordAudit } = require("./audit.service");

const MAX_LISTS = 50;
const MAX_ITEMS = 200;

class ShoppingListError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.statusCode = status;
  }
}

const clean = (v) => String(v ?? "").trim();

// Who is acting and for whom. A customer works on their own lists. An agent
// works on a customer's lists only with access to that customer and the
// right to change their cart (spec §2.2 cart.write); anything else looks like
// "not found".
async function resolveTarget({ shop, actorShopifyCustomerId, customerShopifyCustomerId, forWrite }) {
  const actor = await Customer.findOne({ shop, shopifyCustomerId: clean(actorShopifyCustomerId) });
  if (!actor) throw new ShoppingListError("NOT_FOUND", "Not found", 404);

  const targetId = clean(customerShopifyCustomerId) || actor.shopifyCustomerId;
  if (targetId === actor.shopifyCustomerId) return { actor, customer: actor, agent: null };

  const agent = await findAgentByShopifyId(shop, actor.shopifyCustomerId);
  const customer = await Customer.findOne({ shop, shopifyCustomerId: targetId });
  if (!agent || !isAgentRole(agent.role) || !customer) throw new ShoppingListError("NOT_FOUND", "Not found", 404);

  const access = await checkCustomerAccess(shop, agent, customer);
  if (!access.allowed) throw new ShoppingListError("NOT_FOUND", "Not found", 404);

  if (forWrite) {
    const auth = await authorizeAgent(shop, agent, "cart.write");
    if (!auth.allowed) throw new ShoppingListError("PERMISSION_DENIED", "Your role can't change this customer's lists", 403);
  }

  return { actor, customer, agent };
}

function present(list) {
  const l = list.toObject ? list.toObject() : list;
  return {
    id: l._id,
    name: l.name,
    items: l.items,
    itemCount: l.items.length,
    createdByAgent: !!l.createdByAgent,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

function cleanItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new ShoppingListError("EMPTY", "The list has no items");
  if (items.length > MAX_ITEMS) throw new ShoppingListError("TOO_MANY", `A list can hold up to ${MAX_ITEMS} items`);

  const merged = new Map();
  for (const item of items) {
    const variantId = clean(item.variantId);
    const quantity = Number(item.quantity);
    if (!/^\d{1,20}$/.test(variantId)) throw new ShoppingListError("INVALID_ITEM", "An item has no valid product");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      throw new ShoppingListError("INVALID_ITEM", "Quantities must be whole numbers from 1 to 9999");
    }

    const earlier = merged.get(variantId);
    if (earlier) earlier.quantity = Math.min(earlier.quantity + quantity, 9999);
    else merged.set(variantId, { variantId, quantity, title: clean(item.title).slice(0, 200), sku: clean(item.sku).slice(0, 64) });
  }
  return [...merged.values()];
}

async function list(params) {
  const { customer } = await resolveTarget({ ...params, forWrite: false });
  const lists = await ShoppingList.find({ shop: params.shop, customer: customer._id }).sort({ updatedAt: -1 });
  return lists.map(present);
}

async function create({ shop, actorShopifyCustomerId, customerShopifyCustomerId, name, items }) {
  const { actor, customer, agent } = await resolveTarget({ shop, actorShopifyCustomerId, customerShopifyCustomerId, forWrite: true });

  const title = clean(name);
  if (!title) throw new ShoppingListError("NAME_REQUIRED", "Give the list a name");
  if (title.length > 80) throw new ShoppingListError("NAME_TOO_LONG", "The name can be up to 80 characters");

  const cleaned = cleanItems(items);
  if ((await ShoppingList.countDocuments({ shop, customer: customer._id })) >= MAX_LISTS) {
    throw new ShoppingListError("TOO_MANY_LISTS", `A customer can have up to ${MAX_LISTS} lists`);
  }
  if (await ShoppingList.findOne({ shop, customer: customer._id, name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })) {
    throw new ShoppingListError("NAME_TAKEN", "A list with this name already exists", 409);
  }

  const created = await ShoppingList.create({
    shop,
    customer: customer._id,
    name: title,
    items: cleaned,
    createdBy: actor._id,
    createdByAgent: !!agent,
  });

  if (agent) {
    await recordAudit({
      shop,
      actorType: "sales_agent",
      actor: agent._id,
      actorShopifyCustomerId: agent.shopifyCustomerId,
      customer: customer._id,
      action: AUDIT_ACTIONS.SHOPPING_LIST_CREATED,
      objectType: "shopping_list",
      objectId: String(created._id),
      metadata: { name: title, items: cleaned.length },
    });
  }

  return present(created);
}

async function remove({ shop, actorShopifyCustomerId, customerShopifyCustomerId, id }) {
  const { customer, agent } = await resolveTarget({ shop, actorShopifyCustomerId, customerShopifyCustomerId, forWrite: true });

  const deleted = await ShoppingList.findOneAndDelete({ _id: id, shop, customer: customer._id });
  if (!deleted) throw new ShoppingListError("NOT_FOUND", "List not found", 404);

  if (agent) {
    await recordAudit({
      shop,
      actorType: "sales_agent",
      actor: agent._id,
      actorShopifyCustomerId: agent.shopifyCustomerId,
      customer: customer._id,
      action: AUDIT_ACTIONS.SHOPPING_LIST_DELETED,
      objectType: "shopping_list",
      objectId: String(deleted._id),
      metadata: { name: deleted.name },
    });
  }
}

module.exports = { ShoppingListError, list, create, remove };
