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
  ingestRealtimeSnapshot,
  getLatestStoredPrice,
  getPaymentWindowRange,
  getPricePosition,
  getPriceRangePayload,
  normalizeRange,
  startOfDay,
} = require("./marketDataService");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const ALERT_TIMEZONE = "Asia/Calcutta";
const DEFAULT_CITY = "Chennai";
const DEFAULT_RANGE = "30d";
const SUPPORTED_CITIES = ["Chennai", "Mumbai", "Delhi", "Coimbatore"];
const SUPPORTED_RANGES = {
  "7d": 7,
  "30d": 30,
  "6m": 183,
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

function getNextDueDate(lastPaymentDate) {
  const dueDate = startOfDay(lastPaymentDate);
  dueDate.setUTCMonth(dueDate.getUTCMonth() + 1);
  return dueDate;
}

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
    primary_price_inr_per_gram: entry.retail_22k_inr_per_gram_estimate,
    primary_price_label: "Estimated retail 22K",
    secondary_price_inr_per_gram: entry.spot_24k_inr_per_gram,
    secondary_price_label: "Spot 24K",
    spot_24k_inr_per_gram: entry.spot_24k_inr_per_gram,
    retail_22k_inr_per_gram_estimate: entry.retail_22k_inr_per_gram_estimate,
    price_basis: "retail_22k_inr_per_gram_estimate",
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
  const latestSnapshot = await ingestRealtimeSnapshot();
  const livePrice = {
    status: "available",
    is_live_available: true,
    ...serializeStoredPrice(latestSnapshot, referenceDate),
  };
  const durationMs = Date.now() - startedAt;

  await logActivity(userId, "manual_refresh_requested", {
    requested_at: referenceDate.toISOString(),
    result: livePrice.status,
  });

  return {
    ...livePrice,
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
  const currentRetailPrice =
    analytics.current_retail_22k_inr_per_gram_estimate ?? null;
  const rangePosition = getPricePosition(currentPrice, low, high) ?? 0.5;
  const decision = getBuySignal(currentPrice, low, high);
  const daysLeft = lastPaymentDate ? getDaysLeft(lastPaymentDate, referenceDate) : 30;
  const urgency = Number(Math.max(0, Math.min(1, (30 - daysLeft) / 30)).toFixed(4));

  return {
    decision,
    confidence: decision === "BUY" ? 80 : decision === "WAIT" ? 75 : 60,
    decisionNarrative: decision,
    lowestPrice: low,
    highestPrice: high,
    lowestRetailEstimate: retailLow,
    highestRetailEstimate: retailHigh,
    currentRetailPrice,
    rangePosition,
    urgency,
    daysLeft,
    trend: rangePosition <= 0.33 ? "LOW" : rangePosition >= 0.66 ? "HIGH" : "MID",
    avgPrice: Number((((low ?? currentPrice) + (high ?? currentPrice)) / 2).toFixed(2)),
    deviationPercent: Number((((currentPrice - low) / (low || currentPrice || 1)) * 100).toFixed(2)),
    deviation: Number((currentPrice - low).toFixed(2)),
    distanceFromLow: Number((currentPrice - low).toFixed(2)),
    prediction_3d: {
      min: Math.round(retailLow ?? low),
      max: Math.round(retailHigh ?? high),
      expected: Math.round(currentRetailPrice ?? currentPrice),
      basis: "retail_22k_inr_per_gram_estimate",
    },
    drop_probability: decision === "BUY" ? 20 : decision === "WAIT" ? 70 : 50,
    extra_cost: Number((Math.max(0, currentPrice - low)).toFixed(2)),
    waitScenario: {
      risk_increase: Number((Math.max(0, high - currentPrice)).toFixed(2)),
      potential_saving: Number((Math.max(0, currentPrice - low)).toFixed(2)),
    },
    data_points: 0,
    premiumPrediction: {
      best_day: null,
      expected_price: null,
      confidence: null,
      locked: true,
    },
    meta: {
      fallbackMode: "DB_ONLY",
    },
  };
}

function getPaymentWindow(lastPaymentDate, referenceDate = new Date()) {
  const nextDueDate = getNextDueDate(lastPaymentDate);
  const daysLeft = getDaysLeft(lastPaymentDate, referenceDate);

  return {
    lastPaymentDate: startOfDay(lastPaymentDate).toISOString().slice(0, 10),
    nextDueDate: nextDueDate.toISOString().slice(0, 10),
    daysLeft,
    isOverdue: daysLeft < 0,
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
        rangePosition: null,
        urgency: 0,
        daysLeft: paymentWindow?.daysLeft ?? 30,
        trend: "UNKNOWN",
        avgPrice: null,
        deviationPercent: 0,
        deviation: 0,
        distanceFromLow: 0,
        prediction_3d: null,
        drop_probability: 0,
        extra_cost: 0,
        waitScenario: null,
        data_points: 0,
        premiumPrediction: null,
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
        range_position: decisionData.rangePosition,
        urgency: decisionData.urgency,
        days_left: decisionData.daysLeft,
        trend: decisionData.trend,
        distance_from_low: decisionData.distanceFromLow,
        prediction_3d: decisionData.prediction_3d,
        drop_probability: decisionData.drop_probability,
        extra_cost: decisionData.extra_cost,
        wait_scenario: decisionData.waitScenario,
        data_points: chart.points?.length || decisionData.data_points,
        premium_prediction: decisionData.premiumPrediction,
        fallback_mode: decisionData.meta?.fallbackMode || null,
        price_basis: "spot_24k_inr_per_gram",
      },
    },
    chart,
    payment_trend: paymentTrend,
    paymentWindow,
    message: livePrice.is_live_available
      ? "Using spot history for analytics and an estimated retail 22K headline price"
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
  const lowest = summary.decision?.decision_meta?.lowest_price;
  const buySignal = summary.chart?.buy_signal || "HOLD";

  if (buySignal === "BUY" && lowest && spotCurrent <= lowest * 1.02) {
    messages.push({
      type: "LOWEST",
      subject: "Gold Price Alert: Near 30-day low",
      text: `Gold spot is near the 30-day low at INR ${spotCurrent.toFixed(2)}/g. Estimated retail 22K is INR ${retailCurrent.toFixed(2)}/g. BUY.`,
    });
  }

  if (summary.paymentWindow && summary.paymentWindow.daysLeft <= 3) {
    messages.push({
      type: "DEADLINE",
      subject: "Gold Price Alert: Payment deadline approaching",
      text: summary.paymentWindow.isOverdue
        ? "Payment overdue"
        : `Only ${summary.paymentWindow.daysLeft} days left to pay`,
    });
  }

  messages.push({
    type: "DAILY",
    subject: "Gold Price Alert: Daily summary",
    text: `Estimated retail 22K: INR ${retailCurrent.toFixed(2)}/g. Spot 24K: INR ${spotCurrent.toFixed(2)}/g. Signal: ${buySignal}.`,
  });

  return messages;
}

function filterAlertMessagesByPreferences(messages, preferences) {
  return messages.filter((message) => {
    if (message.type === "LOWEST") {
      return preferences.lowest;
    }
    if (message.type === "DEADLINE") {
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
  const signal = summary.chart.buy_signal || "HOLD";
  const low = summary.chart.low_30d ?? spotPrice;
  const high = summary.chart.high_30d ?? spotPrice;
  const daysLeft = summary.paymentWindow?.daysLeft ?? 30;

  return `Gold Alert

Estimated retail 22K: INR ${retailPrice.toFixed(2)}/g
Spot 24K: INR ${spotPrice.toFixed(2)}/g
30-day spot low: INR ${Number(low).toFixed(2)}/g
30-day spot high: INR ${Number(high).toFixed(2)}/g
Signal: ${signal}
Days left: ${daysLeft}`;
}

module.exports = {
  ALERT_TIMEZONE,
  DEFAULT_CITY,
  DEFAULT_RANGE,
  SUPPORTED_CITIES,
  SUPPORTED_RANGES,
  buildDecision,
  buildGoldAlert,
  completeOnboarding,
  fetchLatestGoldPrice,
  formatNextTriggerLabel,
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
