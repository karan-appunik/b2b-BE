require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./src/models/user.model");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const users = await User.find({}).select("+password").lean();
  console.log(JSON.stringify(users.map(u => ({ _id: u._id, name: u.name, email: u.email, shop: u.shop })), null, 2));
  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
