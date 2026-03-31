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

function getTelegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    return null;
  }

  return { token };
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

async function recordAlert({ userId, alertDate, condition, status, details }) {
  return prisma.alertLog.create({
    data: {
      user_id: userId,
      alert_date: alertDate,
      condition,
      status,
      details: details ? JSON.stringify(details) : null,
    },
  });
}

async function hasAlertBeenProcessed(userId, alertDate, condition) {
  const existing = await prisma.alertLog.findUnique({
    where: {
      user_id_alert_date_condition: {
        user_id: userId,
        alert_date: alertDate,
        condition,
      },
    },
  });

  return Boolean(existing);
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

async function sendTelegramAlert(user, text) {
  const config = getTelegramConfig();

  if (!config) {
    return { ok: false, reason: "missing-telegram-config" };
  }

  if (!user.telegram_chat_id) {
    return { ok: false, reason: "missing-telegram-chat-id" };
  }

  const response = await fetch(
    `https://api.telegram.org/bot${config.token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: user.telegram_chat_id,
        text,
      }),
    },
  );

  if (!response.ok) {
    return { ok: false, reason: `telegram-http-${response.status}` };
  }

  return { ok: true };
}

async function sendDecisionAlert({
  user,
  alertDate,
  condition,
  subject,
  text,
  details,
}) {
  if (await hasAlertBeenProcessed(user.id, alertDate, condition)) {
    return { skipped: true, reason: "already-processed" };
  }

  const emailResult = await sendEmailAlert(user, subject, text);
  const telegramResult = await sendTelegramAlert(user, text);
  const channelsSent = [];
  const skippedReasons = [];

  if (emailResult.ok) {
    channelsSent.push("email");
  } else {
    skippedReasons.push(emailResult.reason);
  }

  if (telegramResult.ok) {
    channelsSent.push("telegram");
  } else {
    skippedReasons.push(telegramResult.reason);
  }

  const status = channelsSent.length ? "sent" : "skipped";
  const payload = {
    channelsSent,
    skippedReasons,
    ...details,
  };

  await recordAlert({
    userId: user.id,
    alertDate,
    condition,
    status,
    details: payload,
  });

  await logActivity(
    user.id,
    status === "sent" ? "alert_sent" : "alert_skipped",
    {
      condition,
      alert_date: alertDate.toISOString(),
      ...payload,
    },
  );

  return {
    skipped: status !== "sent",
    reason: status === "sent" ? null : skippedReasons.join(","),
    channelsSent,
  };
}

module.exports = {
  logActivity,
  sendDecisionAlert,
};
