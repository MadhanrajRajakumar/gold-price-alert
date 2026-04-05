const cron = require("node-cron");
const {
  ALERT_TIMEZONE,
  getNextTriggerTime,
  processAlertsForAllUsers,
} = require("./goldPriceService");

async function runDailyPriceJob() {
  const results = await processAlertsForAllUsers();

  console.log(
    `[gold-price-alert] processed daily checks for ${results.length} user(s)`,
  );

  return results;
}

function startScheduler() {
  const cronSchedule = process.env.CRON_SCHEDULE || "0 9 * * *";
  cron.schedule(
    cronSchedule,
    async () => {
      try {
        await runDailyPriceJob();
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
  startScheduler,
};
