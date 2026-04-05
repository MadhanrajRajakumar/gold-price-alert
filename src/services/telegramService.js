const prisma = require("../lib/prisma");
const { logActivity } = require("./notificationService");

function getTelegramToken() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();

  if (!token) {
    const error = new Error(
      "Telegram bot is not configured. Set TELEGRAM_BOT_TOKEN.",
    );
    error.statusCode = 500;
    throw error;
  }

  return token;
}

async function sendTelegramMessage(chatId, text) {
  const token = getTelegramToken();
  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    },
  );

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok || !data?.ok) {
    const error = new Error("Telegram send failed");
    error.statusCode = 502;
    error.details = data;
    throw error;
  }

  return data;
}

async function verifyTelegramConnection(userId, telegramChatId) {
  const normalizedChatId = String(telegramChatId || "").trim();

  if (!normalizedChatId) {
    const error = new Error("Telegram chat ID is required");
    error.statusCode = 400;
    throw error;
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      telegram_chat_id: normalizedChatId,
      telegram_verified: false,
    },
  });

  try {
    await sendTelegramMessage(normalizedChatId, "✅ Telegram connected successfully");

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        telegram_chat_id: normalizedChatId,
        telegram_verified: true,
      },
    });

    await logActivity(userId, "telegram_connected", {
      telegram_chat_id: normalizedChatId,
      telegram_verified: true,
    });

    return user;
  } catch (error) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        telegram_chat_id: normalizedChatId,
        telegram_verified: false,
      },
    });

    await logActivity(userId, "telegram_connect_failed", {
      telegram_chat_id: normalizedChatId,
    });

    if (error.statusCode === 500) {
      throw error;
    }

    const verificationError = new Error("Invalid chat ID or bot not started");
    verificationError.statusCode = 400;
    verificationError.cause = error;
    throw verificationError;
  }
}

async function markTelegramDisconnected(userId, reason) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      telegram_verified: false,
    },
  });

  await logActivity(userId, "telegram_disconnected", {
    reason,
  });
}

module.exports = {
  markTelegramDisconnected,
  sendTelegramMessage,
  verifyTelegramConnection,
};
