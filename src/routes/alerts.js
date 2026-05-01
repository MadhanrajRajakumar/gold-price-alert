const express = require("express");
const {
  completeOnboarding,
  formatNextTriggerLabel,
  getAlertHistory,
  getNextTriggerTime,
  refreshGoldPriceForUser,
} = require("../services/goldPriceService");
const { verifyTelegramConnection } = require("../services/telegramService");

const router = express.Router();
const MANUAL_REFRESH_WINDOW_MS = 60 * 1000;
const lastRefreshByUser = new Map();

router.post("/telegram/connect", async (request, response, next) => {
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

router.get("/alerts", async (request, response, next) => {
  try {
    const alerts = await getAlertHistory(request.user.id);
    response.json(alerts);
  } catch (error) {
    next(error);
  }
});

router.get("/next-trigger", async (_request, response, next) => {
  try {
    const nextTriggerAt = getNextTriggerTime();

    response.json({
      next_trigger_at: nextTriggerAt.toISOString(),
      label: formatNextTriggerLabel(nextTriggerAt),
    });
  } catch (error) {
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
        onboardingCompleted: true,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/refresh-price", async (request, response, next) => {
  try {
    const now = Date.now();
    const lastRefreshTime = lastRefreshByUser.get(request.user.id) || 0;

    if (now - lastRefreshTime < MANUAL_REFRESH_WINDOW_MS) {
      const error = new Error("Wait before refreshing again");
      error.statusCode = 429;
      throw error;
    }

    lastRefreshByUser.set(request.user.id, now);
    const refreshedPrice = await refreshGoldPriceForUser(request.user.id);

    if (!refreshedPrice.is_live_available) {
      response.status(503).json({
        success: false,
        error: refreshedPrice.live_error || "Unable to fetch live data",
        response_time_ms: refreshedPrice.response_time_ms,
      });
      return;
    }

    response.json({
      success: true,
      primary_price_inr_per_gram: refreshedPrice.primary_price_inr_per_gram,
      primary_price_label: refreshedPrice.primary_price_label,
      secondary_price_inr_per_gram: refreshedPrice.secondary_price_inr_per_gram,
      secondary_price_label: refreshedPrice.secondary_price_label,
      source: refreshedPrice.source,
      fetched_at: refreshedPrice.fetched_at,
      freshness_label: refreshedPrice.freshness_label,
      delayed_message: refreshedPrice.delayed_message || null,
      response_time_ms: refreshedPrice.response_time_ms,
    });
  } catch (error) {
    if (error.statusCode !== 429) {
      lastRefreshByUser.delete(request.user.id);
    }
    next(error);
  }
});

module.exports = router;
