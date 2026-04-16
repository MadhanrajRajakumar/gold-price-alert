const cron = require("node-cron");
const {
  ALERT_TIMEZONE,
  getNextTriggerTime,
  processAlertsForAllUsers,
} = require("./goldPriceService");

const prisma = require("../lib/prisma");

async function runDailyPriceJob() {
  const { processAlertsForAllUsers, ALERT_TIMEZONE } = require("./goldPriceService");
  const now = new Date();
  const timeString = now.toLocaleTimeString("en-US", {
    timeZone: ALERT_TIMEZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });

  const results = await processAlertsForAllUsers(now, timeString);

  if (results.length > 0) {
    console.log(`[gold-price-alert] processed daily checks for ${results.length} user(s) at ${timeString}`);
  }

  return results;
}

async function sendDailyTelegramAlerts() {
  const { buildGoldAlert, ALERT_TIMEZONE } = require("./goldPriceService");
  const { sendTelegramMessage } = require("./telegramService");

  const now = new Date();
  const timeString = now.toLocaleTimeString("en-US", {
    timeZone: ALERT_TIMEZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });

  const users = await prisma.user.findMany({
    where: {
      telegram_verified: true,
      alert_enabled: true,
      alert_time: timeString
    }
  });

  let sentCount = 0;
  for (const user of users) {
    if (user.telegram_chat_id) {
      try {
        const alertMessage = await buildGoldAlert(user.id);
        await sendTelegramMessage(user.telegram_chat_id, alertMessage);
        sentCount++;
      } catch (e) {
        console.error(`[gold-price-alert] Failed to send to ${user.id}: ${e}`);
      }
    }
  }
  
  if (sentCount > 0) {
    console.log(`[gold-price-alert] Daily Telegram alerts sent to ${sentCount} user(s) at ${timeString}`);
  }
}

function startScheduler() {
  // We enforce minute-by-minute evaluation because users can have custom alert times.
  const cronSchedule = "* * * * *";
  cron.schedule(
    cronSchedule,
    async () => {
      try {
        await runDailyPriceJob();
        await sendDailyTelegramAlerts();
      } catch (error) {
        console.error("[gold-price-alert] Daily job failed:", error);
      }
    },
    {
      timezone: ALERT_TIMEZONE,
    },
  );

  console.log(
    `[gold-price-alert] Scheduler started with "${cronSchedule}" in ${ALERT_TIMEZONE}; next run ${getNextTriggerTime().toISOString()}`,
  );
}

module.exports = {
  runDailyPriceJob,
  sendDailyTelegramAlerts,
  startScheduler,
};
