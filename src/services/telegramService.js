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
  try {
    const user = await prisma.user.findFirst({ where: { telegram_chat_id: String(chatId) } });
    if (user) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      let sentToday = user.telegram_messages_sent_today || 0;
      const lastDate = user.last_message_date;

      if (!lastDate || lastDate.getTime() !== today.getTime()) {
        sentToday = 0;
      }

      if (sentToday >= 5) {
        return { success: false, reason: "rate limit" };
      }

      await prisma.user.update({
        where: { id: user.id },
        data: {
          telegram_messages_sent_today: sentToday + 1,
          last_message_date: today
        }
      });
    }

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
      return { success: false, reason: "telegram api error" };
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, reason: "network or config error" };
  }
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

let lastUpdateId = 0;

function startTelegramListener() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  console.log("[gold-price-alert] Starting Telegram listener...");
  
  setInterval(async () => {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId}`);
      if (!response.ok) return;
      const data = await response.json();
      if (!data.ok || !data.result) return;

      for (const update of data.result) {
        lastUpdateId = update.update_id + 1;
        
        const message = update.message;
        if (!message || !message.text) continue;
        
        const chatId = message.chat.id;
        const text = message.text.toLowerCase().trim();
        
        const allowedCommands = ["hi", "price", "gold", "status", "alert"];
        
        if (allowedCommands.includes(text)) {
          const user = await prisma.user.findFirst({ where: { telegram_chat_id: String(chatId) } });
          if (!user) {
            continue;
          }
          
          const { buildGoldAlert } = require("./goldPriceService");
          const alertMessage = await buildGoldAlert(user.id);
          await sendTelegramMessage(chatId, alertMessage);
        }
      }
    } catch (e) {
      // Ignore network errors in polling loop
    }
  }, 3000);
}

module.exports = {
  markTelegramDisconnected,
  sendTelegramMessage,
  verifyTelegramConnection,
  startTelegramListener,
};