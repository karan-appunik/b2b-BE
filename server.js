require("dotenv").config();

const app = require("./app");
const connectDB = require("./src/config/db");

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`[server] backend-api listening on port ${PORT}`);
});

connectDB().catch((err) => {
  console.error("[db] Failed to connect to MongoDB:", err.message);
});
