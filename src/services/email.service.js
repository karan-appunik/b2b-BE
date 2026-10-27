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

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Tells the customer and the agent that an order was placed by a sales agent
// on the customer's behalf (spec §10.2 "Order placed"). Skipped quietly when
// SMTP isn't configured so an unconfigured environment never breaks order
// sync; callers treat a failure here as non-fatal.
async function sendAgentOrderPlacedEmails({ order, agent, customer }) {
  if (!process.env.SMTP_HOST) {
    console.warn("[email] SMTP_HOST not set — skipping agent order notification");
    return;
  }

  const transporter = createTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const total = `${order.totalPrice} ${order.currency}`;

  const messages = [];

  if (customer.email) {
    messages.push({
      from,
      to: customer.email,
      subject: `Order ${order.name} was placed for you`,
      html: `
        <p>Hello ${escapeHtml(customer.name)},</p>
        <p>${escapeHtml(agent.name)} placed order <strong>${escapeHtml(order.name)}</strong>
        (${escapeHtml(total)}) on your behalf.</p>
        <p>If you weren't expecting this, please contact us.</p>
        <p>Regards,<br/>SparkLayer</p>
      `,
    });
  }

  if (agent.email) {
    messages.push({
      from,
      to: agent.email,
      subject: `You placed order ${order.name} for ${customer.name}`,
      html: `
        <p>Hello ${escapeHtml(agent.name)},</p>
        <p>Order <strong>${escapeHtml(order.name)}</strong> (${escapeHtml(total)}) was placed for
        ${escapeHtml(customer.name)}.</p>
        <p>Regards,<br/>SparkLayer</p>
      `,
    });
  }

  for (const message of messages) {
    await transporter.sendMail(message);
  }
}

// Tells someone they have been given sales access and how to start (spec
// §3.1, §10.2). It never contains a password: they already sign in to the
// store as themselves. When the role requires MFA it says so, because
// setting up the authenticator is what activates their access.
async function sendAgentAccessEmail({ agent, roleName, shop, mfaRequired }) {
  if (!process.env.SMTP_HOST) {
    console.warn("[email] SMTP_HOST not set — skipping agent access email");
    return;
  }
  if (!agent.email) return;

  const portalUrl = `https://${shop}/apps/sparklayer/agent-portal`;
  const transporter = createTransporter();

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: agent.email,
    subject: "You now have sales agent access",
    html: `
      <p>Hello ${escapeHtml(agent.name)},</p>
      <p>You have been given the role <strong>${escapeHtml(roleName)}</strong>, so you can now place orders on behalf of your assigned customers.</p>
      <p>Sign in to the store with your usual account and open the Sales Agent Portal:<br/>
      <a href="${escapeHtml(portalUrl)}">${escapeHtml(portalUrl)}</a></p>
      ${
        mfaRequired
          ? "<p>Your role uses two-step verification. The first time you start an order you will be asked to add an authenticator app (such as Google Authenticator) and enter a 6-digit code. Your access is active once that is done.</p>"
          : ""
      }
      <p>If you were not expecting this, please contact your administrator.</p>
      <p>Regards,<br/>SparkLayer</p>
    `,
  });
}

function formatMinor(amount, currency) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount / 100);
  } catch {
    return `${amount / 100} ${currency}`;
  }
}

// Tells the customer a quote is ready for them (spec §10.2 "Quote sent"). It
// points them to their account — the quote itself is never in the email, and
// they must sign in to answer it.
async function sendQuoteSentEmail({ shop, quote, version, customer, agent }) {
  if (!process.env.SMTP_HOST) {
    console.warn("[email] SMTP_HOST not set — skipping quote email");
    return;
  }
  if (!customer || !customer.email) return;

  const transporter = createTransporter();
  const total = formatMinor(version.totals.subtotal, version.currency);
  const until = quote.expiresAt ? quote.expiresAt.toDateString() : "";

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: customer.email,
    subject: `Quote ${quote.number} from ${agent ? agent.name : "your sales contact"}`,
    html: `
      <p>Hello ${escapeHtml(customer.name)},</p>
      <p>${escapeHtml(agent ? agent.name : "Your sales contact")} has sent you quote <strong>${escapeHtml(quote.number)}</strong>
      for <strong>${escapeHtml(total)}</strong>${until ? `, open until ${escapeHtml(until)}` : ""}.</p>
      <p>Sign in at <a href="https://${escapeHtml(shop)}">https://${escapeHtml(shop)}</a> and open <em>My Account → Quotes</em> to review it and accept, decline or ask for changes.</p>
      <p>Regards,<br/>SparkLayer</p>
    `,
  });
}

// Tells the agent how the customer answered.
async function sendQuoteRespondedEmail({ shop, quote, owner, customer, response, comment }) {
  if (!process.env.SMTP_HOST) {
    console.warn("[email] SMTP_HOST not set — skipping quote response email");
    return;
  }
  if (!owner || !owner.email) return;

  const wording = { accept: "accepted", decline: "declined", changes: "asked for changes to" }[response] || response;
  const transporter = createTransporter();

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: owner.email,
    subject: `${customer.name} ${wording} quote ${quote.number}`,
    html: `
      <p>Hello ${escapeHtml(owner.name)},</p>
      <p>${escapeHtml(customer.name)} ${escapeHtml(wording)} quote <strong>${escapeHtml(quote.number)}</strong>.</p>
      ${comment ? `<p>They said: “${escapeHtml(comment)}”</p>` : ""}
      <p>Regards,<br/>SparkLayer</p>
    `,
  });
}

// Sends the buyer their secure payment link. The link itself is the only
// thing in the email that matters: it carries no card or order details.
async function sendPaymentLinkEmail({ customer, agent, amountText, expiresAt, url }) {
  if (!process.env.SMTP_HOST) {
    console.warn("[email] SMTP_HOST not set — skipping payment link email");
    return;
  }
  if (!customer || !customer.email) return;

  const transporter = createTransporter();

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: customer.email,
    subject: "Your secure payment link",
    html: `
      <p>Hello ${escapeHtml(customer.name)},</p>
      <p>${escapeHtml(agent ? agent.name : "Your sales contact")} has set up an order for you
      (<strong>${escapeHtml(amountText)}</strong>). Use this secure link to pay on our hosted checkout page:</p>
      <p><a href="${escapeHtml(url)}">Pay securely</a></p>
      <p>The link works for you only, and expires on ${escapeHtml(expiresAt.toDateString())}. We will never ask you to share card details with us directly.</p>
      <p>Regards,<br/>SparkLayer</p>
    `,
  });
}

const TYPE_TEXT = {
  UNIT_PRICE: "a price change",
  ORDER_DISCOUNT: "an order discount",
  QUANTITY_RULE: "a quantity rule exception",
  SHIPPING_PRICE: "a shipping price change",
  CUSTOM_LINE: "a custom line",
};

// Tells an approver an exception is waiting. The link works once, only for
// them, only while signed in, and only until it expires.
async function sendApprovalLinkEmail({ approver, requester, customerName, type, reason, expiresAt, url }) {
  if (!process.env.SMTP_HOST) {
    console.warn("[email] SMTP_HOST not set — skipping approval link email");
    return;
  }
  if (!approver || !approver.email) return;

  const transporter = createTransporter();

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: approver.email,
    subject: "An exception is waiting for your approval",
    html: `
      <p>Hello ${escapeHtml(approver.name)},</p>
      <p>${escapeHtml(requester || "A sales agent")} asked for ${escapeHtml(TYPE_TEXT[type] || "an exception")}
      for ${escapeHtml(customerName || "a customer")}. Reason: ${escapeHtml(reason)}</p>
      <p><a href="${escapeHtml(url)}">Review and decide</a></p>
      <p>You will need to be signed in to your account. The link works once and expires on ${escapeHtml(expiresAt.toDateString())}.</p>
    `,
  });
}

// The plain email for an alert. The text is the alert's own; there is nothing
// else in it.
async function sendNotificationEmail({ to, name, title, body, url }) {
  if (!process.env.SMTP_HOST) return;

  await createTransporter().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: title,
    html: `
      <p>Hello ${escapeHtml(name)},</p>
      <p><strong>${escapeHtml(title)}</strong></p>
      ${body ? `<p>${escapeHtml(body)}</p>` : ""}
      ${url ? `<p><a href="${escapeHtml(url)}">Open</a></p>` : ""}
      <p>Regards,<br/>SparkLayer</p>
    `,
  });
}

module.exports = {
  sendNotificationEmail,
  sendApprovalLinkEmail,
  sendPaymentLinkEmail,
  sendPasswordResetEmail,
  sendAgentOrderPlacedEmails,
  sendAgentAccessEmail,
  sendQuoteSentEmail,
  sendQuoteRespondedEmail,
};
