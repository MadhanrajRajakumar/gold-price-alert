const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:test@db.example.supabase.co:5432/postgres";
process.env.DIRECT_URL =
  process.env.DIRECT_URL ||
  "postgresql://postgres:test@db.example.supabase.co:5432/postgres";
process.env.GOLD_API_KEY = process.env.GOLD_API_KEY || "test-key";
process.env.GOLD_RETAIL_SPOT_MULTIPLIER =
  process.env.GOLD_RETAIL_SPOT_MULTIPLIER || "1.155";

function loadGoldPriceService({ ingestRealtimeSnapshot, logActivity }) {
  const modulePath = path.resolve(__dirname, "./goldPriceService.js");
  const prismaPath = path.resolve(__dirname, "../lib/prisma.js");
  const notificationPath = path.resolve(__dirname, "./notificationService.js");
  const telegramPath = path.resolve(__dirname, "./telegramService.js");
  const authPath = path.resolve(__dirname, "./authService.js");
  const marketDataPath = path.resolve(__dirname, "./marketDataService.js");

  delete require.cache[modulePath];
  require.cache[prismaPath] = { exports: {} };
  require.cache[notificationPath] = {
    exports: {
      logActivity,
      sendEmailAlert: async () => {},
    },
  };
  require.cache[telegramPath] = {
    exports: {
      markTelegramDisconnected: async () => {},
      sendTelegramMessage: async () => {},
    },
  };
  require.cache[authPath] = {
    exports: {
      serializeUser: (value) => value,
    },
  };
  require.cache[marketDataPath] = {
    exports: {
      buildAnalytics: async () => ({}),
      getBuySignal: () => "HOLD",
      getLatestStoredPrice: async () => null,
      ingestRealtimeSnapshot,
      getPaymentWindowRange: async () => ({}),
      getPricePosition: () => 0.5,
      getPriceRangePayload: async () => ({ points: [] }),
      normalizeRange: (value) => value,
      startOfDay: (value) => value,
    },
  };

  return require(modulePath);
}

test("manual refresh persists and returns the new snapshot", async () => {
  const snapshot = {
    id: 99,
    timestamp: "2026-06-07T07:30:00.000Z",
    spot_24k_inr_per_gram: 12814.56,
    retail_24k_inr_per_gram: 14799.82,
    retail_22k_inr_per_gram: 13566.5,
    retail_22k_inr_per_gram_estimate: 13566.5,
    retail_price_source: "modeled_spot_multiplier",
    retail_price_model_version: "spot_multiplier_v1",
    retail_price_is_modeled: true,
    source: "gold-api:realtime",
  };
  const activityCalls = [];
  const service = loadGoldPriceService({
    ingestRealtimeSnapshot: async () => snapshot,
    logActivity: async (...args) => {
      activityCalls.push(args);
    },
  });

  const referenceDate = new Date("2026-06-07T07:34:00.000Z");
  const refreshed = await service.refreshGoldPriceForUser(42, referenceDate);

  assert.equal(refreshed.status, "available");
  assert.equal(refreshed.is_live_available, true);
  assert.equal(refreshed.primary_price_inr_per_gram, 13566.5);
  assert.equal(refreshed.secondary_price_inr_per_gram, 12814.56);
  assert.equal(refreshed.source, "gold-api:realtime");
  assert.equal(refreshed.fetched_at, "2026-06-07T07:30:00.000Z");
  assert.equal(refreshed.freshness_label, "Last updated 4 minutes ago");
  assert.equal(typeof refreshed.response_time_ms, "number");
  assert.equal(activityCalls.length, 1);
  assert.deepEqual(activityCalls[0], [
    42,
    "manual_refresh_requested",
    {
      requested_at: "2026-06-07T07:34:00.000Z",
      result: "available",
    },
  ]);
});

test("manual refresh surfaces live ingestion failures", async () => {
  const expectedError = new Error("Live API unavailable");
  const service = loadGoldPriceService({
    ingestRealtimeSnapshot: async () => {
      throw expectedError;
    },
    logActivity: async () => {
      throw new Error("logActivity should not run on failure");
    },
  });

  await assert.rejects(
    service.refreshGoldPriceForUser(42, new Date("2026-06-07T07:34:00.000Z")),
    expectedError,
  );
});
