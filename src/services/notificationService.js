const nodemailer = require("nodemailer");
const prisma = require("../lib/prisma");

function getMailConfig() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.ALERT_EMAIL_FROM || user;

  if (!host || !user || !pass || !from) {
    return null;
  }

  return {
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    from,
  };
}

async function logActivity(userId, eventType, details) {
  await prisma.activityLog.create({
    data: {
      user_id: userId,
      event_type: eventType,
      details: JSON.stringify(details),
    },
  });
}

async function sendEmailAlert(user, subject, text) {
  const config = getMailConfig();

  if (!config) {
    return { ok: false, reason: "missing-smtp-config" };
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });

  await transporter.sendMail({
    from: config.from,
    to: user.email,
    subject,
    text,
  });

  return { ok: true };
}

module.exports = {
  logActivity,
  sendEmailAlert,
};
