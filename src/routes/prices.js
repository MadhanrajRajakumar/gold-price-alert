const express = require("express");
const { toLocalDateString } = require("../services/authService");
const {
  completeOnboarding,
  DEFAULT_RANGE,
  fetchLatestGoldPrice,
  getDashboardSummary,
  getLast30DaysPrices,
  getRecentActivity,
  getTrendData,
  saveManualPrice,
  serializeStoredPrice,
  startOfDay,
  storeDailyGoldPrice,
  updateAlertSettings,
  updateUserCity,
  updateUserPaymentDate,
} = require("../services/goldPriceService");
const { verifyTelegramConnection } = require("../services/telegramService");

const router = express.Router();

router.get("/latest-price", async (request, response, next) => {
  try {
    const latest = await fetchLatestGoldPrice(request.user.id, request.user.city);
    response.json(latest);
  } catch (error) {
    next(error);
  }
});

router.post("/prices/fetch", async (request, response, next) => {
  try {
    const saved = await storeDailyGoldPrice(request.user.id, request.user.city);
    const summary = await getDashboardSummary(
      request.user.id,
      new Date(),
      DEFAULT_RANGE,
    );

    response.status(201).json({
      message: saved ? "Daily gold price stored" : "Live gold price unavailable",
      price: saved ? serializeStoredPrice(saved) : null,
      decision: summary.decision,
      dashboard: summary,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/prices", async (request, response, next) => {
  try {
    const prices = await getLast30DaysPrices(request.user.id, request.user.city);
    response.json(prices);
  } catch (error) {
    next(error);
  }
});

router.get("/dashboard", async (request, response, next) => {
  try {
    const range = request.query.range || DEFAULT_RANGE;
    const summary = await getDashboardSummary(request.user.id, new Date(), range);
    response.json(summary);
  } catch (error) {
    next(error);
  }
});

router.get("/trends", async (request, response, next) => {
  try {
    const range = request.query.range || DEFAULT_RANGE;
    const trend = await getTrendData(request.user.id, request.user.city, range);
    response.json(trend);
  } catch (error) {
    next(error);
  }
});

router.get("/activity", async (request, response, next) => {
  try {
    const items = await getRecentActivity(request.user.id);
    response.json(
      items.map((item) => ({
        id: item.id,
        event_type: item.event_type,
        created_at: item.created_at.toISOString(),
        details: JSON.parse(item.details),
      })),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/manual-price", async (request, response, next) => {
  try {
    const saved = await saveManualPrice(
      request.user.id,
      request.user.city,
      request.body.price_per_gram,
    );
    const summary = await getDashboardSummary(request.user.id);

    response.status(201).json({
      message: "Manual price saved for today",
      price: serializeStoredPrice(saved),
      dashboard: summary,
    });
  } catch (error) {
    error.statusCode = 400;
    next(error);
  }
});

router.post("/payment-date", async (request, response, next) => {
  try {
    const user = await updateUserPaymentDate(
      request.user.id,
      request.body.last_payment_date,
    );
    const summary = await getDashboardSummary(request.user.id);

    response.status(201).json({
      message: "Last payment date saved",
      lastPaymentDate: toLocalDateString(user.last_payment_date),
      paymentWindow: summary.paymentWindow,
      paymentTrend: summary.payment_trend,
    });
  } catch (error) {
    error.statusCode = 400;
    next(error);
  }
});

router.post("/city", async (request, response, next) => {
  try {
    const user = await updateUserCity(request.user.id, request.body.city);
    const summary = await getDashboardSummary(user.id);

    response.status(201).json({
      message: "City saved",
      user: {
        id: user.id,
        email: user.email,
        city: user.city,
      },
      dashboard: summary,
    });
  } catch (error) {
    error.statusCode = error.statusCode || 400;
    next(error);
  }
});

router.post("/alert-settings", async (request, response, next) => {
  try {
    await updateAlertSettings(request.user.id, request.body.alert_time, request.body.analysis_days);
    const summary = await getDashboardSummary(request.user.id);

    response.status(201).json({
      message: "Alert settings saved",
      dashboard: summary,
    });
  } catch (error) {
    error.statusCode = error.statusCode || 400;
    next(error);
  }
});

router.post("/onboarding/complete", async (request, response, next) => {
  try {
    const user = await completeOnboarding(request.user.id);
    response.status(201).json({
      message: "Onboarding completed",
      user: {
        id: user.id,
        onboarding_completed_at: user.onboarding_completed_at.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/telegram-connect", async (request, response, next) => {
  try {
    const user = await verifyTelegramConnection(
      request.user.id,
      request.body.telegram_chat_id,
    );

    response.status(201).json({
      message: "Telegram connected successfully",
      user: {
        id: user.id,
        email: user.email,
        telegram_chat_id: user.telegram_chat_id,
        telegram_verified: Boolean(user.telegram_verified),
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
