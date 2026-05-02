const express = require("express");
const { toLocalDateString } = require("../services/authService");
const {
  completeOnboarding,
  CYCLE_DAYS,
  DEFAULT_RANGE,
  fetchLatestGoldPrice,
  getCycleInfo,
  getDashboardSummary,
  getLast30DaysPrices,
  getRecentActivity,
  getTrendData,
  saveManualPrice,
  updateAlertSettings,
  updateUserCity,
  updateUserPaymentDate,
} = require("../services/goldPriceService");

const router = express.Router();

router.get("/latest-price", async (request, response, next) => {
  try {
    const latest = await fetchLatestGoldPrice(request.user.id, request.user.city);
    response.json(latest);
  } catch (error) {
    next(error);
  }
});

router.get("/prices", async (request, response, next) => {
  try {
    const range = request.query.range || DEFAULT_RANGE;
    const payload = await getTrendData(request.user.id, request.user.city, range);
    response.json(payload);
  } catch (error) {
    next(error);
  }
});

router.post("/prices/fetch", async (request, response, next) => {
  try {
    const latest = await fetchLatestGoldPrice(request.user.id, request.user.city);
    const summary = await getDashboardSummary(
      request.user.id,
      new Date(),
      request.query.range || DEFAULT_RANGE,
    );

    response.json({
      message: "Prices are served from stored market data only",
      price: latest.is_live_available ? latest : null,
      decision: summary.decision,
      dashboard: summary,
    });
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

router.get("/prices/last-30-days", async (request, response, next) => {
  try {
    const prices = await getLast30DaysPrices(request.user.id, request.user.city);
    response.json(prices);
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
    await saveManualPrice(
      request.user.id,
      request.user.city,
      request.body.price_per_gram,
    );
    response.status(410).json({
      error: "Manual market price overrides are no longer supported",
    });
  } catch (error) {
    error.statusCode = error.statusCode || 410;
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
    await updateAlertSettings(
      request.user.id,
      request.body.alert_time,
      request.body.analysis_days,
    );
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

router.post("/mark-bought", async (request, response, next) => {
  try {
    const prisma = require("../lib/prisma");
    const user = await prisma.user.update({
      where: { id: request.user.id },
      data: { last_payment_date: new Date() },
    });

    const cycleInfo = getCycleInfo(user.last_payment_date, new Date());

    response.status(201).json({
      success: true,
      message: "Purchase recorded",
      lastPurchaseDate: user.last_payment_date
        ? toLocalDateString(user.last_payment_date)
        : null,
      nextCycleDate: cycleInfo.nextCycleDate
        ? cycleInfo.nextCycleDate.toISOString().slice(0, 10)
        : null,
      daysRemaining: cycleInfo.daysRemaining,
      status: cycleInfo.status,
    });
  } catch (error) {
    error.statusCode = 400;
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

module.exports = router;
