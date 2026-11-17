const mongoose = require("mongoose");
const svc = require("../services/shoppingList.service");

function guard(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof svc.ShoppingListError) return res.status(err.statusCode).json({ code: err.code, message: err.message });
      next(err);
    }
  };
}

// The storefront tells us who is signed in (actor) and, for an agent ordering
// for a customer, which customer's lists (taken from the live context there).
const ids = (src) => ({
  shop: src.shop,
  actorShopifyCustomerId: src.actorShopifyCustomerId,
  customerShopifyCustomerId: src.customerShopifyCustomerId,
});

const list = guard(async (req, res) => {
  res.status(200).json({ lists: await svc.list(ids(req.query)) });
});

const create = guard(async (req, res) => {
  const created = await svc.create({ ...ids(req.body), name: req.body.name, items: req.body.items });
  res.status(201).json(created);
});

const remove = guard(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ code: "NOT_FOUND", message: "List not found" });
  await svc.remove({ ...ids(req.body), id: req.params.id });
  res.status(200).json({ ok: true });
});

module.exports = { list, create, remove };
