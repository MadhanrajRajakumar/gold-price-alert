const prisma = require("../lib/prisma");
const { logActivity, sendEmailAlert } = require("./notificationService");
const {
  markTelegramDisconnected,
  sendTelegramMessage,
} = require("./telegramService");
const { serializeUser } = require("./authService");
const {
  buildAnalytics,
  getBuySignal,
  getLatestStoredPrice,
  ingestRealtimeSnapshot,
  getPaymentWindowRange,
  getPricePosition,
  getPriceRangePayload,
  normalizeRange,
  startOfDay,
} = require("./marketDataService");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const CYCLE_DAYS = 30;
const ALERT_TIMEZONE = "Asia/Calcutta";
const DEFAULT_CITY = "Chennai";
const DEFAULT_RANGE = "30d";
const SUPPORTED_CITIES = ["Chennai", "Mumbai", "Delhi", "Coimbatore"];
const SUPPORTED_RANGES = {
  "7d": 7,
  "30d": 30,
  "6M": 183,
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "1Y": 365,
};

function normalizeCity(city) {
  const normalized = String(city || DEFAULT_CITY).trim().toLowerCase();
  const match = SUPPORTED_CITIES.find(
    (candidate) => candidate.toLowerCase() === normalized,
  );

  if (!match) {
    const error = new Error(
      `City must be one of: ${SUPPORTED_CITIES.join(", ")}`,
    );
    error.statusCode = 400;
    throw error;
  }

  return match;
}

function normalizeAlertPreferences(value) {
  const raw =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};

  return {
    daily: raw.daily !== false,
    lowest: raw.lowest !== false,
    deadline: raw.deadline !== false,
  };
}

function parseInputDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return startOfDay(parsed);
}

function validateLastPaymentDate(date, referenceDate = new Date()) {
  const normalized = startOfDay(date);
  const today = startOfDay(referenceDate);

  if (normalized.getTime() > today.getTime()) {
    const error = new Error("Last payment date cannot be in future");
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

/**
 * Get cycle info for buy cycle tracking.
 * last_payment_date is used as the user's last gold purchase date.
 * @param {Date|null} lastPurchaseDate - Last gold purchase date (or null if never purchased)
 * @param {Date} referenceDate - Reference date for calculations (default: today)
 * @returns {{ status: string, nextCycleDate: Date|null, daysRemaining: number|null }}
 *   - status: "never" (no purchase), "active" (within 30-day cycle), "available" (past cycle)
 *   - nextCycleDate: When user can buy next (or null if never purchased)
 *   - daysRemaining: Days until next cycle end (or null if never purchased)
 */
function getCycleInfo(lastPurchaseDate, referenceDate = new Date()) {
  if (!lastPurchaseDate) {
    return {
      status: "never",
      nextCycleDate: null,
      daysRemaining: null,
    };
  }

  const normalizedPurchaseDate = startOfDay(lastPurchaseDate);
  const today = startOfDay(referenceDate);
  
  // Calculate next cycle: purchase date + 30 days
  const nextCycleDate = new Date(normalizedPurchaseDate);
  nextCycleDate.setUTCDate(nextCycleDate.getUTCDate() + CYCLE_DAYS);

  const daysRemaining = Math.ceil(
    (nextCycleDate.getTime() - today.getTime()) / DAY_IN_MS
  );

  const status = daysRemaining > 0 ? "active" : "available";

  return {
    status,
    nextCycleDate,
    daysRemaining,
  };
}

// DEPRECATED: Use getCycleInfo() instead. Kept for backward compatibility.
function getNextDueDate(lastPaymentDate) {
  const dueDate = startOfDay(lastPaymentDate);
  dueDate.setUTCMonth(dueDate.getUTCMonth() + 1);
  return dueDate;
}

// DEPRECATED: Use getCycleInfo() instead. Kept for backward compatibility.
function getDaysLeft(lastPaymentDate, referenceDate = new Date()) {
  const today = startOfDay(referenceDate);
  const nextDueDate = getNextDueDate(lastPaymentDate);
  return Math.ceil((nextDueDate.getTime() - today.getTime()) / DAY_IN_MS);
}

function getNextTriggerTime(referenceDate = new Date(), alertTimeStr = "09:00") {
  const localeString = referenceDate.toLocaleString("en-US", {
    timeZone: ALERT_TIMEZONE,
  });
  const localizedDate = new Date(localeString);
  const nextRunLocal = new Date(localizedDate);

  const [hourStr, minuteStr] = String(alertTimeStr || "09:00").split(":");
  const alertHour = Number.parseInt(hourStr, 10) || 9;
  const alertMinute = Number.parseInt(minuteStr, 10) || 0;

  nextRunLocal.setHours(alertHour, alertMinute, 0, 0);

  if (nextRunLocal.getTime() <= localizedDate.getTime()) {
    nextRunLocal.setDate(nextRunLocal.getDate() + 1);
  }

  const localOffsetMinutes = -nextRunLocal.getTimezoneOffset();
  return new Date(nextRunLocal.getTime() - localOffsetMinutes * 60 * 1000);
}

function formatNextTriggerLabel(
  nextTriggerAt,
  referenceDate = new Date(),
  alertTimeStr = "09:00",
) {
  const tomorrow = getNextTriggerTime(referenceDate, alertTimeStr);
  const isTomorrow =
    nextTriggerAt.toISOString().slice(0, 10) === tomorrow.toISOString().slice(0, 10);

  const [hourStr, minuteStr] = String(alertTimeStr || "09:00").split(":");
  let hour = Number.parseInt(hourStr, 10) || 9;
  const minute = Number.parseInt(minuteStr, 10) || 0;
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  const displayTime = `${hour}:${String(minute).padStart(2, "0")} ${ampm}`;

  return isTomorrow
    ? `Next alert at ${displayTime} tomorrow`
    : `Next alert at ${displayTime}`;
}

function getRetailHeadlineLabel(entry) {
  return "Chennai 22K Gold";
}

function getRangeContextLabel(entry) {
  return entry?.retail_price_is_modeled
    ? "modeled retail"
    : "retail";
}

function serializeStoredPrice(entry, referenceDate = new Date()) {
  if (!entry) {
    return null;
  }

  const timestamp = new Date(entry.timestamp);
  const minutesSince = Math.max(
    0,
    Math.round((referenceDate.getTime() - timestamp.getTime()) / (60 * 1000)),
  );
  const freshnessLabel =
    minutesSince < 60
      ? `Last updated ${minutesSince} minute${minutesSince === 1 ? "" : "s"} ago`
      : `Last updated ${(minutesSince / 60).toFixed(1)} hours ago`;

  return {
    id: entry.id,
    date: timestamp.toISOString(),
    timestamp: timestamp.toISOString(),
    display_price_value:
      entry.retail_22k_inr_per_gram ?? entry.retail_22k_inr_per_gram_estimate,
    display_price_basis: "retail_22k_inr_per_gram",
    display_price_source: entry.retail_price_source || "modeled_spot_multiplier",
    display_price_model_version:
      entry.retail_price_model_version || "spot_multiplier_v1",
    signal_price_value: entry.spot_24k_inr_per_gram,
    signal_price_basis: "spot_24k_inr_per_gram",
    primary_price_inr_per_gram:
      entry.retail_22k_inr_per_gram ?? entry.retail_22k_inr_per_gram_estimate,
    primary_price_label: getRetailHeadlineLabel(entry),
    secondary_price_inr_per_gram: entry.spot_24k_inr_per_gram,
    secondary_price_label: "Spot 24K",
    spot_24k_inr_per_gram: entry.spot_24k_inr_per_gram,
    retail_24k_inr_per_gram: entry.retail_24k_inr_per_gram ?? null,
    retail_22k_inr_per_gram:
      entry.retail_22k_inr_per_gram ?? entry.retail_22k_inr_per_gram_estimate,
    retail_22k_inr_per_gram_estimate: entry.retail_22k_inr_per_gram_estimate,
    retail_price_source: entry.retail_price_source || "modeled_spot_multiplier",
    retail_price_model_version:
      entry.retail_price_model_version || "spot_multiplier_v1",
    retail_price_is_modeled: Boolean(entry.retail_price_is_modeled),
    price_basis: "retail_22k_inr_per_gram",
    source: entry.source,
    fetched_at: timestamp.toISOString(),
    freshness_label: freshnessLabel,
    minutes_since_update: minutesSince,
    is_live_available: true,
  };
}

async function fetchLatestGoldPrice(_userId, _city = DEFAULT_CITY, referenceDate = new Date()) {
  const latest = await getLatestStoredPrice();

  if (!latest) {
    return {
      status: "unavailable",
      is_live_available: false,
      live_error: "No stored gold price data available",
      fetched_at: referenceDate.toISOString(),
    };
  }

  return {
    status: "available",
    is_live_available: true,
    ...serializeStoredPrice(latest, referenceDate),
  };
}

async function storeDailyGoldPrice(_userId, _city = DEFAULT_CITY, referenceDate = new Date()) {
  return fetchLatestGoldPrice(null, null, referenceDate);
}

async function refreshGoldPriceForUser(userId, referenceDate = new Date()) {
  const startedAt = Date.now();
  const snapshot = await ingestRealtimeSnapshot();
  const durationMs = Date.now() - startedAt;

  await logActivity(userId, "manual_refresh_requested", {
    requested_at: referenceDate.toISOString(),
    result: "available",
  });

  return {
    status: "available",
    is_live_available: true,
    ...serializeStoredPrice(snapshot, referenceDate),
    response_time_ms: durationMs,
  };
}

async function getLast30DaysPrices(_userId, _city = DEFAULT_CITY, referenceDate = new Date()) {
  const payload = await getPriceRangePayload("30d", referenceDate);
  return payload.points;
}

async function getTrendData(
  _userId,
  _city = DEFAULT_CITY,
  range = DEFAULT_RANGE,
  referenceDate = new Date(),
) {
  return getPriceRangePayload(normalizeRange(range), referenceDate);
}

async function getTrendFromPaymentDate(
  _userId,
  _city = DEFAULT_CITY,
  lastPaymentDate,
  referenceDate = new Date(),
) {
  if (!lastPaymentDate) {
    return {
      is_available: false,
      from_date: null,
      to_date: null,
      points: [],
    };
  }

  return getPaymentWindowRange(lastPaymentDate, referenceDate);
}

async function buildDecision({ currentPrice, lastPaymentDate, referenceDate = new Date() }) {
  const analytics = await buildAnalytics(referenceDate);
  const low = analytics.low_30d ?? currentPrice;
  const high = analytics.high_30d ?? currentPrice;
  const retailLow = analytics.retail_low_30d ?? null;
  const retailHigh = analytics.retail_high_30d ?? null;
  const currentRetailPrice = analytics.current_display_price ?? null;
  const signalRangePosition = getPricePosition(currentPrice, low, high) ?? 0.5;
  const displayRangePosition =
    getPricePosition(currentRetailPrice, retailLow, retailHigh) ?? signalRangePosition;
  const decision = getBuySignal(currentPrice, low, high);
  const daysLeft = lastPaymentDate ? getDaysLeft(lastPaymentDate, referenceDate) : 30;
  const urgency = Number(Math.max(0, Math.min(1, (30 - daysLeft) / 30)).toFixed(4));
  const retailDistanceFromLow =
    currentRetailPrice === null || retailLow === null
      ? null
      : Number((currentRetailPrice - retailLow).toFixed(2));

  return {
    decision,
    confidence: analytics.confidence,
    decisionNarrative: decision,
    lowestPrice: low,
    highestPrice: high,
    lowestRetailEstimate: retailLow,
    highestRetailEstimate: retailHigh,
    currentRetailPrice,
    signalRangePosition,
    displayRangePosition,
    urgency,
    daysLeft,
    trend:
      signalRangePosition <= 0.33
        ? "LOW"
        : signalRangePosition >= 0.66
          ? "HIGH"
          : "MID",
    avgPrice: Number((((low ?? currentPrice) + (high ?? currentPrice)) / 2).toFixed(2)),
    deviationPercent: Number((((currentPrice - low) / (low || currentPrice || 1)) * 100).toFixed(2)),
    deviation: Number((currentPrice - low).toFixed(2)),
    distanceFromLow: Number((currentPrice - low).toFixed(2)),
    displayDistanceFromLow: retailDistanceFromLow,
    dataPoints: analytics.monthly_data_points,
    coverageRatio: analytics.coverage_ratio,
    validationRatio: analytics.validation_ratio,
    extraCost: Number((Math.max(0, currentPrice - low)).toFixed(2)),
    meta: {
      fallbackMode: "DB_ONLY",
    },
  };
}

function getPaymentWindow(lastPaymentDate, referenceDate = new Date()) {
  const cycleInfo = getCycleInfo(lastPaymentDate, referenceDate);
  
  if (!cycleInfo.nextCycleDate) {
    return null;
  }

  return {
    lastPaymentDate: startOfDay(lastPaymentDate).toISOString().slice(0, 10),
    nextCycleDate: cycleInfo.nextCycleDate.toISOString().slice(0, 10),
    daysLeft: cycleInfo.daysRemaining,
    status: cycleInfo.status,
  };
}

async function getRecentActivity(userId) {
  return prisma.activityLog.findMany({
    where: {
      user_id: userId,
    },
    orderBy: {
      created_at: "desc",
    },
    take: 20,
  });
}

async function getAlertHistory(userId) {
  return prisma.alertLog.findMany({
    where: {
      user_id: userId,
    },
    orderBy: {
      sent_at: "desc",
    },
    take: 30,
  });
}

async function getDashboardSummary(
  userId,
  referenceDate = new Date(),
  range = DEFAULT_RANGE,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  const livePrice = await fetchLatestGoldPrice(userId, DEFAULT_CITY, referenceDate);
  const chart = await getTrendData(userId, DEFAULT_CITY, range, referenceDate);
  const paymentTrend = await getTrendFromPaymentDate(
    userId,
    DEFAULT_CITY,
    user?.last_payment_date,
    referenceDate,
  );

  let paymentWindow = null;
  if (user?.last_payment_date) {
    paymentWindow = getPaymentWindow(user.last_payment_date, referenceDate);
  }

  const decisionData = livePrice.is_live_available
    ? await buildDecision({
        currentPrice: livePrice.spot_24k_inr_per_gram,
        lastPaymentDate: user?.last_payment_date,
        referenceDate,
      })
    : {
        decision: "HOLD",
        confidence: 0,
        decisionNarrative: "NO_DATA",
        lowestPrice: null,
        highestPrice: null,
        lowestRetailEstimate: null,
        highestRetailEstimate: null,
        currentRetailPrice: null,
        signalRangePosition: null,
        displayRangePosition: null,
        urgency: 0,
        daysLeft: paymentWindow?.daysLeft ?? 30,
        trend: "UNKNOWN",
        avgPrice: null,
        deviationPercent: 0,
        deviation: 0,
        distanceFromLow: 0,
        displayDistanceFromLow: 0,
        extraCost: 0,
        dataPoints: 0,
        coverageRatio: 0,
        validationRatio: 0,
        meta: { fallbackMode: "NO_DB_DATA" },
      };

  return {
    user: {
      ...serializeUser(user),
      city: normalizeCity(user?.city || DEFAULT_CITY),
      alert_time: user?.alert_time || "09:00",
      analysis_days: user?.analysis_days || 30,
      supported_cities: SUPPORTED_CITIES,
      alert_preferences: normalizeAlertPreferences(user?.alert_preferences),
      next_trigger_at: getNextTriggerTime(referenceDate, user?.alert_time).toISOString(),
      next_trigger_label: formatNextTriggerLabel(
        getNextTriggerTime(referenceDate, user?.alert_time),
        referenceDate,
        user?.alert_time,
      ),
    },
    live_price: livePrice,
    decision: {
      decision: decisionData.decision,
      confidence: decisionData.confidence,
      decision_meta: {
        decision_narrative: decisionData.decisionNarrative,
        lowest_price: decisionData.lowestPrice,
        highest_price: decisionData.highestPrice,
        lowest_retail_estimate: decisionData.lowestRetailEstimate,
        highest_retail_estimate: decisionData.highestRetailEstimate,
        current_retail_price: decisionData.currentRetailPrice,
        range_position: decisionData.signalRangePosition,
        display_range_position: decisionData.displayRangePosition,
        urgency: decisionData.urgency,
        days_left: decisionData.daysLeft,
        trend: decisionData.trend,
        signal_basis: "spot_24k_inr_per_gram",
        display_basis: "retail_22k_inr_per_gram",
        display_price_source:
          livePrice.retail_price_source || "modeled_spot_multiplier",
        display_price_model_version:
          livePrice.retail_price_model_version || "spot_multiplier_v1",
        distance_from_low: decisionData.distanceFromLow,
        display_distance_from_low: decisionData.displayDistanceFromLow,
        extra_cost: decisionData.extraCost,
        data_points: decisionData.dataPoints,
        coverage_ratio: decisionData.coverageRatio,
        validation_ratio: decisionData.validationRatio,
        fallback_mode: decisionData.meta?.fallbackMode || null,
        price_basis: "spot_24k_inr_per_gram",
      },
    },
    monthly_summary: {
      low_price: decisionData.lowestRetailEstimate,
      high_price: decisionData.highestRetailEstimate,
      signal_low_price: decisionData.lowestPrice,
      signal_high_price: decisionData.highestPrice,
      signal_basis: "spot_24k_inr_per_gram",
      display_basis: "retail_22k_inr_per_gram",
      low_date: chart.lowest?.date || null,
      high_date: chart.highest?.date || null,
    },
    advanced_insights: {
      freshness_label: livePrice.freshness_label || null,
      signal_basis: "spot_24k_inr_per_gram",
      display_basis: "retail_22k_inr_per_gram",
      data_points_reviewed: decisionData.dataPoints,
      range_position: decisionData.signalRangePosition,
      display_range_position: decisionData.displayRangePosition,
      days_left: decisionData.daysLeft,
      urgency: decisionData.urgency,
      trend: decisionData.trend,
      distance_from_low: decisionData.distanceFromLow,
      display_distance_from_low: decisionData.displayDistanceFromLow,
      extra_cost: decisionData.extraCost,
      coverage_ratio: decisionData.coverageRatio,
      validation_ratio: decisionData.validationRatio,
      analytics_reference_date: chart.analytics_reference_date || null,
      live_price_source: livePrice.retail_price_source || "modeled_spot_multiplier",
      live_price_model_version:
        livePrice.retail_price_model_version || "spot_multiplier_v1",
      debug_pricing_enabled: process.env.NODE_ENV !== "production",
    },
    chart,
    payment_trend: paymentTrend,
    paymentWindow,
    message: livePrice.is_live_available
      ? "Showing Chennai 22K Gold across the full display experience"
      : "No stored market data available yet",
  };
}

function buildAlertMessages(summary) {
  if (!summary.live_price?.is_live_available) {
    return [];
  }

  const messages = [];
  const retailCurrent = summary.live_price.primary_price_inr_per_gram;
  const spotCurrent = summary.live_price.spot_24k_inr_per_gram;
  const retailContextLabel = getRangeContextLabel(summary.live_price);
  const lowest = summary.decision?.decision_meta?.lowest_price;
  const buySignal = summary.chart?.buy_signal || "HOLD";

  if (buySignal === "BUY" && lowest && spotCurrent <= lowest * 1.02) {
    messages.push({
      type: "LOWEST",
      subject: "Gold Price Alert: Near 30-day low",
      text: `Chennai 22K Gold is near the 30-day low at INR ${retailCurrent.toFixed(2)}/g. BUY.`,
    });
  }

  if (summary.paymentWindow && summary.paymentWindow.daysLeft > 0 && summary.paymentWindow.daysLeft <= 3) {
    messages.push({
      type: "DEADLINE",
      subject: "Gold Price Alert: Buy cycle reminder",
      text: `Only ${summary.paymentWindow.daysLeft} days until next buy cycle on ${summary.paymentWindow.nextCycleDate}`,
    });
  }

  if (summary.paymentWindow && summary.paymentWindow.status === "available") {
    messages.push({
      type: "CYCLE_AVAILABLE",
      subject: "Gold Price Alert: Buy cycle available",
      text: "You can buy anytime now. Consider your budget and timing for the best purchase.",
    });
  }

  messages.push({
    type: "DAILY",
    subject: "Gold Price Alert: Daily summary",
    text: `Chennai 22K Gold: INR ${retailCurrent.toFixed(2)}/g. Signal: ${buySignal}.`,
  });

  return messages;
}

function filterAlertMessagesByPreferences(messages, preferences) {
  return messages.filter((message) => {
    if (message.type === "LOWEST") {
      return preferences.lowest;
    }
    if (message.type === "DEADLINE" || message.type === "CYCLE_AVAILABLE") {
      return preferences.deadline;
    }
    if (message.type === "DAILY") {
      return preferences.daily;
    }
    return false;
  });
}

async function hasAlertBeenSentOnDay(userId, type, date = new Date()) {
  const shifted = new Date(date.getTime() + 330 * 60 * 1000);
  const start = new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
      0,
      0,
      0,
    ) - 330 * 60 * 1000,
  );

  const existing = await prisma.alertLog.findFirst({
    where: {
      user_id: userId,
      type,
      sent_at: {
        gte: start,
        lt: new Date(start.getTime() + DAY_IN_MS),
      },
    },
  });

  return Boolean(existing);
}

async function recordAlertLog(userId, type, message, sentAt = new Date()) {
  await prisma.alertLog.create({
    data: {
      user_id: userId,
      type,
      message,
      sent_at: sentAt,
    },
  });
}

async function deliverAlertMessage(user, alert, sentAt = new Date()) {
  if (await hasAlertBeenSentOnDay(user.id, alert.type, sentAt)) {
    return {
      skipped: true,
      reason: "already-sent",
      type: alert.type,
    };
  }

  const channelsSent = [];

  try {
    await sendTelegramMessage(user.telegram_chat_id, alert.text);
    channelsSent.push("telegram");
  } catch {
    await markTelegramDisconnected(user.id, "send_failed");
  }

  try {
    const emailResult = await sendEmailAlert(user, alert.subject, alert.text);
    if (emailResult.ok) {
      channelsSent.push("email");
    }
  } catch {}

  if (!channelsSent.length) {
    return {
      skipped: true,
      reason: "no-channel",
      type: alert.type,
    };
  }

  await recordAlertLog(user.id, alert.type, alert.text, sentAt);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      last_alert_sent_at: sentAt,
    },
  });

  await logActivity(user.id, "alert_sent", {
    type: alert.type,
    channelsSent,
    sent_at: sentAt.toISOString(),
  });

  return {
    skipped: false,
    type: alert.type,
    channelsSent,
  };
}

async function processScheduledAlertsForUser(userId, referenceDate = new Date()) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user?.telegram_verified || !user.telegram_chat_id) {
    return {
      skipped: true,
      reason: "telegram-not-verified",
      summary: null,
      results: [],
    };
  }

  const summary = await getDashboardSummary(userId, referenceDate, "30d");
  const preferences = normalizeAlertPreferences(user.alert_preferences);
  const alertMessages = filterAlertMessagesByPreferences(
    buildAlertMessages(summary),
    preferences,
  );
  const results = [];

  for (const alert of alertMessages) {
    results.push(await deliverAlertMessage(user, alert, referenceDate));
  }

  return {
    skipped: false,
    summary,
    results,
  };
}

async function processAlertsForAllUsers(referenceDate = new Date(), filterTimeString = null) {
  const where = {
    telegram_verified: true,
    alert_enabled: true,
  };

  if (filterTimeString) {
    where.alert_time = filterTimeString;
  }

  const users = await prisma.user.findMany({
    where,
    select: { id: true },
  });

  const results = [];
  for (const user of users) {
    results.push(await processScheduledAlertsForUser(user.id, referenceDate));
  }

  return results;
}

async function updateUserPaymentDate(userId, lastPaymentDate) {
  const parsed = parseInputDate(lastPaymentDate);

  if (!parsed) {
    const error = new Error("Please enter a valid date");
    error.statusCode = 400;
    throw error;
  }

  validateLastPaymentDate(parsed);

  return prisma.user.update({
    where: { id: userId },
    data: {
      last_payment_date: parsed,
    },
  });
}

async function updateAlertSettings(userId, alertTime = "09:00", analysisDays = 30) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      alert_time: String(alertTime),
      analysis_days: Number(analysisDays),
    },
  });
}

async function updateUserCity(userId, city) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      city: normalizeCity(city),
    },
  });
}

async function completeOnboarding(userId) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      onboarding_completed_at: new Date(),
    },
  });
}

async function saveManualPrice() {
  const error = new Error("Manual market price overrides are no longer supported");
  error.statusCode = 410;
  throw error;
}

async function buildGoldAlert(userId) {
  const summary = await getDashboardSummary(userId, new Date(), "30d");

  if (!summary.live_price?.is_live_available) {
    return "Gold price data is not available in the database yet.";
  }

  const retailPrice = summary.live_price.primary_price_inr_per_gram;
  const spotPrice = summary.live_price.spot_24k_inr_per_gram;
  const retailContextLabel = getRangeContextLabel(summary.live_price);
  const signal = summary.chart.buy_signal || "HOLD";
  const low = summary.chart.low_30d ?? spotPrice;
  const high = summary.chart.high_30d ?? spotPrice;
  const daysLeft = summary.paymentWindow?.daysLeft ?? 30;

  return `Gold Alert

${retailContextLabel} 22K: INR ${retailPrice.toFixed(2)}/g
30-day low: INR ${estimateRetailDisplay(low).toFixed(2)}/g
30-day high: INR ${estimateRetailDisplay(high).toFixed(2)}/g
Signal: ${signal}
Days left: ${daysLeft}`;
}

function estimateRetailDisplay(value) {
  if (!Number.isFinite(Number(value))) {
    return 0;
  }

  const { estimateRetail22KFromSpot24K } = require("./goldApiClient");
  return estimateRetail22KFromSpot24K(Number(value));
}

module.exports = {
  ALERT_TIMEZONE,
  CYCLE_DAYS,
  DEFAULT_CITY,
  DEFAULT_RANGE,
  SUPPORTED_CITIES,
  SUPPORTED_RANGES,
  buildDecision,
  buildGoldAlert,
  completeOnboarding,
  fetchLatestGoldPrice,
  formatNextTriggerLabel,
  getCycleInfo,
  getAlertHistory,
  getDashboardSummary,
  getLast30DaysPrices,
  getNextTriggerTime,
  getRecentActivity,
  getTrendData,
  getTrendFromPaymentDate,
  normalizeAlertPreferences,
  processAlertsForAllUsers,
  refreshGoldPriceForUser,
  saveManualPrice,
  serializeStoredPrice,
  startOfDay,
  storeDailyGoldPrice,
  updateAlertSettings,
  updateUserCity,
  updateUserPaymentDate,
};
