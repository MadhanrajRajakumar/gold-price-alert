const express = require("express");
const { toLocalDateString } = require("../services/authService");
const {
  fetchLatestGoldPrice,
  getDashboardSummary,
  getLast30DaysPrices,
  getRecentActivity,
  processAlerts,
  saveManualPrice,
  serializePrice,
  storeDailyGoldPrice,
  updateTelegramChatId,
  updateUserPaymentDate,
} = require("../services/goldPriceService");

const router = express.Router();

router.get("/latest-price", async (request, response, next) => {
  try {
    const latest = await fetchLatestGoldPrice(request.user.id);
    response.json({
      date: latest.date.toISOString(),
      price_per_gram: latest.pricePerGram,
      source: latest.source,
      source_detail: latest.sourceDetail,
      used_fallback: latest.usedFallback,
      fallback_reason: latest.fallbackReason || null,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/prices/fetch", async (request, response, next) => {
  try {
    const saved = await storeDailyGoldPrice(request.user.id);
    const { summary, results } = await processAlerts(request.user.id, saved.date);

    response.status(201).json({
      message: "Daily gold price stored",
      price: serializePrice(saved),
      decision: summary.decision,
      alertResults: results,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/prices", async (request, response, next) => {
  try {
    await storeDailyGoldPrice(request.user.id);
    const prices = await getLast30DaysPrices(request.user.id);
    response.json(prices.map(serializePrice));
  } catch (error) {
    next(error);
  }
});

router.get("/dashboard", async (request, response, next) => {
  try {
    const summary = await getDashboardSummary(request.user.id);
    response.json(summary);
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
      request.body.price_per_gram,
    );
    const { summary, results } = await processAlerts(request.user.id, saved.date);

    response.status(201).json({
      message: "Manual price saved for today",
      price: serializePrice(saved),
      dashboard: summary,
      alertResults: results,
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
    const { summary, results } = await processAlerts(request.user.id);

    response.status(201).json({
      message: "Last payment date saved",
      lastPaymentDate: toLocalDateString(user.last_payment_date),
      paymentWindow: summary.paymentWindow,
      alertResults: results,
    });
  } catch (error) {
    error.statusCode = 400;
    next(error);
  }
});

router.post("/telegram-connect", async (request, response, next) => {
  try {
    const user = await updateTelegramChatId(
      request.user.id,
      request.body.telegram_chat_id,
    );

    response.status(201).json({
      message: "Telegram chat ID saved",
      user: {
        id: user.id,
        email: user.email,
        telegram_chat_id: user.telegram_chat_id,
        telegram_connected: Boolean(user.telegram_chat_id),
      },
    });
  } catch (error) {
    error.statusCode = 400;
    next(error);
  }
});

module.exports = router;
