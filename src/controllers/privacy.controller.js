const LegalHold = require("../models/legalHold.model");
const DataSubjectRequest = require("../models/dataSubjectRequest.model");
const retention = require("../services/retention.service");

// Retention, legal holds and data-subject requests (spec §11.2), for the
// merchant's own staff.

function fail(res, next, err) {
  if (err && err.statusCode) return res.status(err.statusCode).json({ message: err.message });
  return next(err);
}

async function retentionPreview(req, res, next) {
  try {
    const policy = await retention.getPolicy(req.user.shop);
    const preview = await retention.runRetention(req.user.shop, { dryRun: true });
    res.status(200).json({ policy, preview });
  } catch (err) {
    next(err);
  }
}

async function retentionRun(req, res, next) {
  try {
    const result = await retention.runRetention(req.user.shop, { dryRun: req.body && req.body.dryRun === true, user: req.user });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function listHolds(req, res, next) {
  try {
    const holds = await LegalHold.find({ shop: req.user.shop }).populate("customer", "name email").sort({ createdAt: -1 }).lean();
    res.status(200).json({ holds });
  } catch (err) {
    next(err);
  }
}

async function placeHold(req, res, next) {
  try {
    const hold = await retention.placeHold({ shop: req.user.shop, scope: req.body.scope, customerId: req.body.customerId, reason: req.body.reason, user: req.user });
    res.status(201).json(hold);
  } catch (err) {
    fail(res, next, err);
  }
}

async function releaseHold(req, res, next) {
  try {
    const hold = await retention.releaseHold({ shop: req.user.shop, holdId: req.params.id, user: req.user });
    res.status(200).json(hold);
  } catch (err) {
    fail(res, next, err);
  }
}

async function listRequests(req, res, next) {
  try {
    const requests = await DataSubjectRequest.find({ shop: req.user.shop }).populate("customer", "name email").sort({ createdAt: -1 }).limit(200).lean();
    res.status(200).json({ requests });
  } catch (err) {
    next(err);
  }
}

async function createRequest(req, res, next) {
  try {
    const result = await retention.handleRequest({ shop: req.user.shop, customerId: req.body.customerId, type: req.body.type, user: req.user });
    res.status(201).json(result);
  } catch (err) {
    fail(res, next, err);
  }
}

module.exports = { retentionPreview, retentionRun, listHolds, placeHold, releaseHold, listRequests, createRequest };
