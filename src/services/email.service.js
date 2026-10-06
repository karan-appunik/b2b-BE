const nodemailer = require("nodemailer");

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendPasswordResetEmail(to, resetUrl) {
  const transporter = createTransporter();

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: "Reset your SparkLayer password",
    html: `
      <p>Hello!</p>
      <p>You are receiving this email because we received a password reset request for your account.</p>
      <p><a href="${resetUrl}">Reset Password</a></p>
      <p>This password reset link will expire in 60 minutes.</p>
      <p>If you did not request a password reset, no further action is required.</p>
      <p>Regards,<br/>SparkLayer</p>
    `,
  });
}

module.exports = { sendPasswordResetEmail };
