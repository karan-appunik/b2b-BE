const express = require("express");
const cors = require("cors");

const healthRoutes = require("./src/routes/health.routes");
const authRoutes = require("./src/routes/auth.routes");
const productRoutes = require("./src/routes/product.routes");
const customerRoutes = require("./src/routes/customer.routes");
const customerGroupRoutes = require("./src/routes/customerGroup.routes");
const priceListRoutes = require("./src/routes/priceList.routes");
const internalRoutes = require("./src/routes/internal.routes");
const { notFound, errorHandler } = require("./src/middleware/error.middleware");

const app = express();

app.use(cors());
app.use(express.json());

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
app.use("/api/price-lists", priceListRoutes);
app.use("/api/internal", internalRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
