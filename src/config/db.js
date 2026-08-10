const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGODB_URI;

  mongoose.connection.on("connected", () => {
    console.log("[db] MongoDB connected");
  });

  mongoose.connection.on("error", (err) => {
    console.error("[db] MongoDB connection error:", err.message);
  });

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  return mongoose.connection;
}

module.exports = connectDB;
