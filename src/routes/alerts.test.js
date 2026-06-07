const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");

function loadAlertsRouter({ refreshGoldPriceForUser, verifyTelegramConnection = async () => ({}) }) {
  const routerPath = path.resolve(__dirname, "./alerts.js");
  const goldPriceServicePath = path.resolve(__dirname, "../services/goldPriceService.js");
  const telegramServicePath = path.resolve(__dirname, "../services/telegramService.js");

  delete require.cache[routerPath];
  require.cache[goldPriceServicePath] = {
    exports: {
      completeOnboarding: async () => ({}),
      formatNextTriggerLabel: () => "Next alert at 9:00 AM",
      getAlertHistory: async () => [],
      getNextTriggerTime: () => new Date("2026-06-07T00:00:00.000Z"),
      refreshGoldPriceForUser,
    },
  };
  require.cache[telegramServicePath] = {
    exports: {
      verifyTelegramConnection,
    },
  };

  return require(routerPath);
}

async function invokeRefresh(router, { userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = { id: userId };
    next();
  });
  app.use("/api", router);
  app.use((error, _request, response, _next) => {
    response.status(error.statusCode || 500).json({
      error: error.message,
    });
  });

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/refresh-price`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
    });

    return {
      status: response.status,
      body: await response.json(),
    };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

test("refresh route returns the persisted snapshot fields", async () => {
  const router = loadAlertsRouter({
    refreshGoldPriceForUser: async () => ({
      is_live_available: true,
      primary_price_inr_per_gram: 14713.02,
      primary_price_label: "Chennai 22K Gold",
      secondary_price_inr_per_gram: 13951.1,
      secondary_price_label: "Spot 24K",
      source: "gold-api:realtime",
      fetched_at: "2026-06-07T08:00:00.000Z",
      freshness_label: "Last updated 0 minutes ago",
      response_time_ms: 321,
    }),
  });

  const response = await invokeRefresh(router);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    success: true,
    primary_price_inr_per_gram: 14713.02,
    primary_price_label: "Chennai 22K Gold",
    secondary_price_inr_per_gram: 13951.1,
    secondary_price_label: "Spot 24K",
    source: "gold-api:realtime",
    fetched_at: "2026-06-07T08:00:00.000Z",
    freshness_label: "Last updated 0 minutes ago",
    delayed_message: null,
    response_time_ms: 321,
  });
});

test("refresh route rejects a second request inside the throttle window", async () => {
  let refreshCalls = 0;
  const router = loadAlertsRouter({
    refreshGoldPriceForUser: async () => {
      refreshCalls += 1;
      return {
        is_live_available: true,
        primary_price_inr_per_gram: 14713.02,
        primary_price_label: "Chennai 22K Gold",
        secondary_price_inr_per_gram: 13951.1,
        secondary_price_label: "Spot 24K",
        source: "gold-api:realtime",
        fetched_at: "2026-06-07T08:00:00.000Z",
        freshness_label: "Last updated 0 minutes ago",
        response_time_ms: 321,
      };
    },
  });

  const firstResponse = await invokeRefresh(router, { userId: 42 });
  const secondResponse = await invokeRefresh(router, { userId: 42 });

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 429);
  assert.deepEqual(secondResponse.body, {
    error: "Wait before refreshing again",
  });
  assert.equal(refreshCalls, 1);
});

test("refresh route returns 503 when live data is unavailable", async () => {
  const router = loadAlertsRouter({
    refreshGoldPriceForUser: async () => ({
      is_live_available: false,
      live_error: "Live API unavailable",
      response_time_ms: 987,
    }),
  });

  const response = await invokeRefresh(router, { userId: 84 });

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    success: false,
    error: "Live API unavailable",
    response_time_ms: 987,
  });
});
