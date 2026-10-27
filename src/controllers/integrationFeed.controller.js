const feeds = require("../services/integrationFeed.service");
const reports = require("../services/report.service");

function send(res, rows, format, name, note) {
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.status(200).send(feeds.toCsv(rows));
  }
  return res.status(200).json({ generatedAt: new Date().toISOString(), count: rows.length, note, rows });
}

function guard(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof reports.ReportError) return res.status(err.statusCode).json({ code: err.code, message: err.message });
      next(err);
    }
  };
}

const pseudonymous = (req) => req.query.names !== "true";
const formatOf = (req) => (req.query.format === "csv" ? "csv" : "json");

// GET /api/integrations/crm/accounts?format=json|csv&names=true
const crmAccounts = guard(async (req, res) => {
  const rows = await feeds.crmAccounts({ shop: req.user.shop, pseudonymous: pseudonymous(req) });
  await feeds.audited({ shop: req.user.shop, user: req.user, kind: "crm_accounts", rows, extra: { names: !pseudonymous(req) } });
  send(res, rows, formatOf(req), "crm-accounts", "Accounts with the agents assigned by name. Read-only.");
});

// GET /api/integrations/crm/quotes?from&to&format&names
const crmQuotes = guard(async (req, res) => {
  const rows = await feeds.crmQuotes({ shop: req.user.shop, from: req.query.from, to: req.query.to, pseudonymous: pseudonymous(req) });
  await feeds.audited({ shop: req.user.shop, user: req.user, kind: "crm_quotes", rows, extra: { from: req.query.from, to: req.query.to, names: !pseudonymous(req) } });
  send(res, rows, formatOf(req), "crm-quotes", "Stage is a plain mapping of the quote's own state; this is not a sales pipeline.");
});

// GET /api/integrations/commission-feed?from&to&format&names
const commission = guard(async (req, res) => {
  const rows = await feeds.commissionRows({ shop: req.user.shop, from: req.query.from, to: req.query.to, pseudonymous: pseudonymous(req) });
  await feeds.audited({ shop: req.user.shop, user: req.user, kind: "commission", rows, extra: { from: req.query.from, to: req.query.to, names: !pseudonymous(req) } });
  send(res, rows, formatOf(req), "commission-input", feeds.CSV_NOTE);
});

module.exports = { crmAccounts, crmQuotes, commission };
