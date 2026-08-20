const User = require("../models/user.model");
const { hashPassword, comparePassword, generateToken } = require("../services/auth.service");

async function register(req, res, next) {
  try {
    const { name, email, password, shop } = req.body;

    if (!name || !email || !password || !shop) {
      return res.status(400).json({ message: "name, email, password and shop are required" });
    }

    const password_hash = await hashPassword(password);
    const user = await User.create({ name, email, password: password_hash, shop });

    res.status(201).json({
      token: generateToken(user),
      user: { _id: user._id, name: user.name, email: user.email, role: user.role, shop: user.shop },
    });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "email and password are required" });
    }

    const user = await User.findOne({ email }).select("+password");

    if (!user || !(await comparePassword(password, user.password))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    res.status(200).json({
      token: generateToken(user),
      user: { _id: user._id, name: user.name, email: user.email, role: user.role, shop: user.shop },
    });
  } catch (err) {
    next(err);
  }
}

async function getMe(req, res) {
  res.status(200).json({ user: req.user });
}

module.exports = { register, login, getMe };
