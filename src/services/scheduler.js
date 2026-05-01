const cron = require("node-cron");
const { validateEnv } = require("../config/env");
const {
  aggregateDailySummary,
  backfillHistory,
  ingestRealtimeSnapshot,
  getLatestStoredPrice,
  startOfDay,
  validateDailySummary,
} = require("./marketDataService");
const {
  ALERT_TIMEZONE,
  getNextTriggerTime,
  processAlertsForAllUsers,
} = require("./goldPriceService");

async function runRealtimeIngestionJob() {
  const snapshot = await ingestRealtimeSnapshot();
  console.log("[gold-price-alert] stored realtime gold snapshot", {
    timestamp: snapshot.timestamp,
    spot_24k_inr_per_gram: snapshot.spot_24k_inr_per_gram,
    retail_22k_inr_per_gram_estimate: snapshot.retail_22k_inr_per_gram_estimate,
  });
  return snapshot;
}

async function runDailyAggregationJob(referenceDate = new Date()) {
  const targetDate = new Date(
    startOfDay(referenceDate).getTime() - 24 * 60 * 60 * 1000,
  );
  return aggregateDailySummary(targetDate);
}

async function runDailyValidationJob(referenceDate = new Date()) {
  const targetDate = new Date(
    startOfDay(referenceDate).getTime() - 24 * 60 * 60 * 1000,
  );
  return validateDailySummary(targetDate);
}

async function runDailyPriceJob() {
  const now = new Date();
  const timeString = now.toLocaleTimeString("en-US", {
    timeZone: ALERT_TIMEZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

  const results = await processAlertsForAllUsers(now, timeString);

  if (results.length > 0) {
    console.log(
      `[gold-price-alert] processed alert checks for ${results.length} user(s) at ${timeString}`,
    );
  }

  return results;
}

async function primeMarketData() {
  const latest = await getLatestStoredPrice();

  if (!latest) {
    await backfillHistory();
  }
}

function startScheduler() {
  const env = validateEnv();

  if (!env.schedulerEnabled) {
    console.log("[gold-price-alert] Scheduler disabled by GOLD_API_SCHEDULER_ENABLED");
    return;
  }

  cron.schedule(
    "*/30 * * * *",
    async () => {
      try {
        await runRealtimeIngestionJob();
      } catch (error) {
        console.error("[gold-price-alert] Realtime ingestion job failed:", error);
      }
    },
    { timezone: ALERT_TIMEZONE },
  );

  cron.schedule(
    "5 0 * * *",
    async () => {
      try {
        await runDailyAggregationJob();
      } catch (error) {
        console.error("[gold-price-alert] Daily aggregation job failed:", error);
      }
    },
    { timezone: ALERT_TIMEZONE },
  );

  cron.schedule(
    "20 0 * * *",
    async () => {
      try {
        await runDailyValidationJob();
      } catch (error) {
        console.error("[gold-price-alert] Daily validation job failed:", error);
      }
    },
    { timezone: ALERT_TIMEZONE },
  );

  cron.schedule(
    "* * * * *",
    async () => {
      try {
        await runDailyPriceJob();
      } catch (error) {
        console.error("[gold-price-alert] User alert job failed:", error);
      }
    },
    { timezone: ALERT_TIMEZONE },
  );

  primeMarketData().catch((error) => {
    console.error("[gold-price-alert] Initial market data priming failed:", error);
  });

  console.log(
    `[gold-price-alert] Scheduler started in ${ALERT_TIMEZONE}; next alert run ${getNextTriggerTime().toISOString()}`,
  );
}

module.exports = {
  runDailyAggregationJob,
  runDailyPriceJob,
  runDailyValidationJob,
  runRealtimeIngestionJob,
  startScheduler,
};
