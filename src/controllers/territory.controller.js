const mongoose = require("mongoose");
const svc = require("../services/territory.service");

function guard(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof svc.TerritoryError) return res.status(err.statusCode).json({ code: err.code, message: err.message });
      next(err);
    }
  };
}

const validId = (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) return true;
  res.status(404).json({ code: "NOT_FOUND", message: "Rule not found" });
  return false;
};

const list = guard(async (req, res) => {
  res.status(200).json(await svc.listRules(req.user.shop));
});

const create = guard(async (req, res) => {
  const rule = await svc.saveRule({ shop: req.user.shop, input: req.body, user: req.user });
  // New rules take effect at once.
  const applied = await svc.applyRules(req.user.shop, { actor: req.user });
  res.status(201).json({ rule, applied });
});

const update = guard(async (req, res) => {
  if (!validId(req, res)) return;
  const rule = await svc.saveRule({ shop: req.user.shop, id: req.params.id, input: req.body, user: req.user });
  const applied = await svc.applyRules(req.user.shop, { actor: req.user });
  res.status(200).json({ rule, applied });
});

const remove = guard(async (req, res) => {
  if (!validId(req, res)) return;
  await svc.deleteRule({ shop: req.user.shop, id: req.params.id, user: req.user });
  const applied = await svc.applyRules(req.user.shop, { actor: req.user });
  res.status(200).json({ ok: true, applied });
});

// POST /api/territory-rules/apply?dryRun=true
const apply = guard(async (req, res) => {
  res.status(200).json(await svc.applyRules(req.user.shop, { dryRun: req.query.dryRun === "true", actor: req.user }));
});

module.exports = { list, create, update, remove, apply };
