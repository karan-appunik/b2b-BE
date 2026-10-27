const express = require("express");
const cors = require("cors");
const path = require("path");

const healthRoutes = require("./src/routes/health.routes");
const authRoutes = require("./src/routes/auth.routes");
const productRoutes = require("./src/routes/product.routes");
const customerRoutes = require("./src/routes/customer.routes");
const customerGroupRoutes = require("./src/routes/customerGroup.routes");
const agentScopeRoutes = require("./src/routes/agentScope.routes");
const auditRoutes = require("./src/routes/audit.routes");
const roleRoutes = require("./src/routes/role.routes");
const outboxRoutes = require("./src/routes/outbox.routes");
const approvalRoutes = require("./src/routes/approval.routes");
const privacyRoutes = require("./src/routes/privacy.routes");
const priceListRoutes = require("./src/routes/priceList.routes");
const discountRoutes = require("./src/routes/discount.routes");
const orderRoutes = require("./src/routes/order.routes");
const dashboardRoutes = require("./src/routes/dashboard.routes");
const formRoutes = require("./src/routes/form.routes");
const internalRoutes = require("./src/routes/internal.routes");
const v1Routes = require("./src/routes/v1.routes");
const { rejectOperatorKeys, securityHeaders } = require("./src/middleware/security.middleware");
const { notFound, errorHandler } = require("./src/middleware/error.middleware");

const app = express();

app.disable("x-powered-by");
app.use(securityHeaders);
app.use(cors());
app.use(express.json());
app.use(rejectOperatorKeys);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/", (req, res) => {
  res.status(200).json({
    service: "backend-api",
    status: "ok",
    health: "/api/health",
  });
});

app.use("/api", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/customer-groups", customerGroupRoutes);
app.use("/api/agents", agentScopeRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/privacy", privacyRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/outbox", outboxRoutes);
app.use("/api", approvalRoutes);
app.use("/api/price-lists", priceListRoutes);
app.use("/api/discounts", discountRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/forms", formRoutes);
app.use("/api/internal", internalRoutes);
app.use("/api/v1", v1Routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
