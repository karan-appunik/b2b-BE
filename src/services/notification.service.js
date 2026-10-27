const Notification = require("../models/notification.model");
const Customer = require("../models/customer.model");
const { getSettings } = require("./override.service");
const { sendNotificationEmail } = require("./email.service");

// The hour (0-23) in a time zone. An unknown zone falls back to UTC.
function hourIn(timeZone, now) {
  try {
    return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  } catch {
    return now.getUTCHours();
  }
}

// Spec §12 "explicit business timezone": quiet hours are read in the shop's
// own time. A window like 21 -> 7 runs across midnight.
function inQuietHours(settings, now = new Date()) {
  const { quietHoursStart: start, quietHoursEnd: end } = settings;
  if (start === null || start === undefined || end === null || end === undefined || start === end) return false;

  const hour = hourIn(settings.businessTimezone || "UTC", now);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// Makes the alert for one person unless they already have this one. Returns
// whether it was new. Failing to alert never breaks what triggered it.
// The merchant's own wording for a notification type (and the recipient's
// language, if there is one), with {title} {body} {recipient} {shop} filled in.
function renderTemplate(templates, type, lang, vars) {
  const t = templates && (templates[type + "|" + lang] || templates[type]);
  if (!t) return null;
  const fill = (text) => String(text || "").replace(/\{(title|body|recipient|shop)\}/g, (_, k) => vars[k] || "");
  return { title: t.title ? fill(t.title) : vars.title, body: t.body ? fill(t.body) : vars.body };
}

async function notify({ shop, recipient, type, title, body, link, dedupeKey, email = true, inApp = true }) {
  const person = recipient && recipient.email !== undefined ? recipient : await Customer.findById(recipient);
  if (!person) return { created: false };

  const AgentSettings = require("../models/agentSettings.model");
  const settings = await AgentSettings.findOne({ shop }).select("notificationTemplates").lean();
  const lang = person.agentProfile && person.agentProfile.locale ? String(person.agentProfile.locale).split(/[-_]/)[0].toLowerCase() : "";
  const custom = renderTemplate(settings && settings.notificationTemplates, type, lang, { title, body, recipient: person.name, shop });
  if (custom) {
    title = custom.title;
    body = custom.body;
  }

  try {
    await Notification.create({
      shop,
      recipient: person._id,
      type,
      title,
      body,
      link,
      dedupeKey,
      inApp,
      emailPending: !!(email && person.email),
    });
    return { created: true };
  } catch (err) {
    if (err && err.code === 11000) return { created: false };
    console.error("[notify] could not create notification", err);
    return { created: false };
  }
}

// Sends the emails that are waiting, unless it is quiet hours for that shop.
async function sendPendingEmails(now = new Date()) {
  const pending = await Notification.find({ emailPending: true, emailSentAt: null }).sort({ createdAt: 1 }).limit(100);
  const quiet = new Map();
  let sent = 0;
  let held = 0;

  for (const n of pending) {
    if (!quiet.has(n.shop)) quiet.set(n.shop, inQuietHours(await getSettings(n.shop), now));
    if (quiet.get(n.shop)) { held += 1; continue; }

    const person = await Customer.findById(n.recipient).select("name email");
    n.emailPending = false;
    if (person && person.email) {
      try {
        await sendNotificationEmail({ to: person.email, name: person.name, title: n.title, body: n.body, url: n.link ? `https://${n.shop}${n.link}` : null });
        n.emailSentAt = now;
        sent += 1;
      } catch (err) {
        console.error("[notify] email failed", err.message);
        n.emailPending = true;
        n.emailSentAt = null;
      }
    }
    await n.save();
  }

  return { sent, held };
}

async function listFor(shop, agent) {
  const items = await Notification.find({ shop, recipient: agent._id, inApp: true }).sort({ createdAt: -1 }).limit(30).lean();
  const unread = await Notification.countDocuments({ shop, recipient: agent._id, inApp: true, readAt: null });
  return {
    unread,
    notifications: items.map((n) => ({ id: n._id, type: n.type, title: n.title, body: n.body || null, link: n.link || null, read: !!n.readAt, createdAt: n.createdAt })),
  };
}

async function markRead(shop, agent, ids) {
  const filter = { shop, recipient: agent._id, readAt: null };
  if (Array.isArray(ids) && ids.length) filter._id = { $in: ids };
  const result = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
  return result.modifiedCount;
}

module.exports = { inQuietHours, notify, sendPendingEmails, listFor, markRead };
