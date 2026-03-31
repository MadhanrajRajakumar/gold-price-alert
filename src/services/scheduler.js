const cron = require("node-cron");
const { processAlertsForAllUsers } = require("./goldPriceService");

async function runDailyPriceJob() {
  const results = await processAlertsForAllUsers();

  console.log(
    `[gold-price-alert] processed daily checks for ${results.length} user(s)`,
  );

  return results;
}

function startScheduler() {
  const cronSchedule = process.env.CRON_SCHEDULE || "0 9 * * *";
  cron.schedule(cronSchedule, async () => {
    try {
      await runDailyPriceJob();
    } catch (error) {
      console.error("[gold-price-alert] Daily job failed:", error);
    }
  });

  console.log(`[gold-price-alert] Scheduler started with "${cronSchedule}"`);
}

module.exports = {
  runDailyPriceJob,
  startScheduler,
};
