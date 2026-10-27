const reports = require("../services/report.service");

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

// GET /api/reports/sales-agents?from&to&groupBy=none|agent|territory|segment
const sales = guard(async (req, res) => {
  res.status(200).json(
    await reports.salesReport({
      shop: req.user.shop,
      from: req.query.from,
      to: req.query.to,
      groupBy: req.query.groupBy || "none",
      pseudonymous: req.query.pseudonymous === "true",
    })
  );
});

// GET /api/reports/operations
const operations = guard(async (req, res) => {
  res.status(200).json(await reports.operationsReport(req.user.shop));
});

module.exports = { sales, operations };
