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
        
        if (text.startsWith("/start")) {
          const parts = message.text.split(" ");
          if (parts.length > 1) {
            const appUserId = Number(parts[1]);
            if (!isNaN(appUserId)) {
              const userMatch = await prisma.user.findUnique({ where: { id: appUserId } });
              if (userMatch) {
                await prisma.user.update({
                  where: { id: appUserId },
                  data: {
                    telegram_chat_id: String(chatId),
                    telegram_verified: true
                  }
                });
                
                await sendTelegramMessage(chatId, `✅ Telegram connected successfully!\n\nYou will now receive:\n• Daily gold alerts\n• Buy/Wait recommendations\n\nType "price" anytime to check current status.`);
              }
            }
          }
          continue;
        }

        const allowedCommands = ["hi", "price", "gold", "status", "alert"];
        
        if (allowedCommands.includes(text)) {
          const user = await prisma.user.findFirst({ where: { telegram_chat_id: String(chatId) } });
          if (!user) {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: "⚠️ Please connect your account first using the app." })
            });
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
  sendTelegramMessage,
  startTelegramListener,
};