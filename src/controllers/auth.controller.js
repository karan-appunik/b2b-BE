const crypto = require("crypto");
const User = require("../models/user.model");
const {
  hashPassword,
  comparePassword,
  generateToken,
  generateResetToken,
  hashResetToken,
} = require("../services/auth.service");
const { sendPasswordResetEmail } = require("../services/email.service");

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

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

// Called only from the internal API (protectInternal already verified the
// request came from admin-frontend's own server) when a merchant opens the
// "Open Merchant Panel" link from inside Shopify admin — mirrors how the
// real SparkLayer app auto-logs the store owner into its dashboard on
// install, instead of making them register a separate email/password.
async function ssoLogin(req, res, next) {
  try {
    const { shop } = req.body;

    let user = await User.findOne({ shop }).sort({ createdAt: 1 });

    if (!user) {
      const password_hash = await hashPassword(crypto.randomBytes(32).toString("hex"));
      user = await User.create({
        name: "Store Owner",
        email: `owner+${shop}@sparklayer.local`,
        password: password_hash,
        shop,
      });
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

async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "email is required" });
    }

    const user = await User.findOne({ email });

    if (user) {
      const { token, tokenHash } = generateResetToken();
      user.resetPasswordToken = tokenHash;
      user.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await user.save();

      const resetUrl = `${process.env.MERCHANT_PANEL_URL}/reset-password?token=${token}&email=${encodeURIComponent(user.email)}`;
      await sendPasswordResetEmail(user.email, resetUrl);
    }

    res.status(200).json({
      message: "If that email address matches an account, we have emailed a password reset link.",
    });
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { email, token, password } = req.body;

    if (!email || !token || !password) {
      return res.status(400).json({ message: "email, token and password are required" });
    }

    const user = await User.findOne({
      email,
      resetPasswordToken: hashResetToken(token),
      resetPasswordExpires: { $gt: new Date() },
    }).select("+resetPasswordToken +resetPasswordExpires");

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired reset link" });
    }

    user.password = await hashPassword(password);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.status(200).json({ message: "Password reset successful" });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, ssoLogin, getMe, forgotPassword, resetPassword };
