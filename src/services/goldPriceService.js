const prisma = require("../lib/prisma");
const { logActivity, sendEmailAlert } = require("./notificationService");
const {
  markTelegramDisconnected,
  sendTelegramMessage,
} = require("./telegramService");
const { serializeUser } = require("./authService");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const STALE_PRICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const ALERT_TIMEZONE = "Asia/Calcutta";
const ALERT_HOUR = 9;
const ALERT_MINUTE = 0;
const DEFAULT_CITY = "Chennai";
const DEFAULT_RANGE = "1M";
const DEFAULT_ALERT_PREFERENCES = {
  daily: true,
  lowest: true,
  deadline: true,
};

const SUPPORTED_CITIES = ["Chennai", "Mumbai", "Delhi", "Coimbatore"];
const SUPPORTED_RANGES = {
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "6M": 180,
  "1Y": 365,
};
const LIVE_SOURCES = [
  "gold-api",
  "goldapi",
  "metalpriceapi",
  "metal_api",
  "calculated_metal_api",
  "manual:22k",
];
const TROY_OUNCE_TO_GRAMS = 31.1035;
const LIVE_MIN_PRICE = 10000;
const LIVE_MAX_PRICE = 20000;

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

function normalizeRange(range) {
  const normalized = String(range || DEFAULT_RANGE).toUpperCase();
  return SUPPORTED_RANGES[normalized] ? normalized : DEFAULT_RANGE;
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

function startOfDay(date = new Date()) {
  const normalized = new Date(date);
  return new Date(
    Date.UTC(
      normalized.getUTCFullYear(),
      normalized.getUTCMonth(),
      normalized.getUTCDate(),
    ),
  );
}

function normalizeCalendarDate(date) {
  const normalized = new Date(date);
  const hasUtcTimeComponent =
    normalized.getUTCHours() !== 0 ||
    normalized.getUTCMinutes() !== 0 ||
    normalized.getUTCSeconds() !== 0 ||
    normalized.getUTCMilliseconds() !== 0;

  if (!hasUtcTimeComponent) {
    return startOfDay(normalized);
  }

  return startOfDay(new Date(normalized.getTime() + 330 * 60 * 1000));
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
  const dueDate = normalizeCalendarDate(lastPaymentDate);
  dueDate.setUTCMonth(dueDate.getUTCMonth() + 1);
  return dueDate;
}

function getDaysLeft(lastPaymentDate, referenceDate = new Date()) {
  const today = startOfDay(referenceDate);
  const nextDueDate = getNextDueDate(lastPaymentDate);
  return Math.ceil((nextDueDate.getTime() - today.getTime()) / DAY_IN_MS);
}

function getHoursSince(timestamp, referenceDate = new Date()) {
  const diff = referenceDate.getTime() - new Date(timestamp).getTime();
  return Math.max(0, Number((diff / (60 * 60 * 1000)).toFixed(1)));
}

function getMinutesSince(timestamp, referenceDate = new Date()) {
  const diff = referenceDate.getTime() - new Date(timestamp).getTime();
  return Math.max(0, Math.round(diff / (60 * 1000)));
}

function formatFreshnessLabel(timestamp, referenceDate = new Date()) {
  const minutesSince = getMinutesSince(timestamp, referenceDate);

  if (minutesSince < 60) {
    return `Last updated ${minutesSince} minute${minutesSince === 1 ? "" : "s"} ago`;
  }

  const hoursSince = Number((minutesSince / 60).toFixed(1));
  return `Last updated ${hoursSince} hour${hoursSince === 1 ? "" : "s"} ago`;
}

function normalizeFetchedPricePerGram(rawPrice) {
  const numeric = Number(rawPrice);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("Invalid gold price");
  }

  const normalized = Number(numeric.toFixed(2));
  if (normalized < LIVE_MIN_PRICE || normalized > LIVE_MAX_PRICE) {
    throw new Error("Price out of expected range");
  }

  return normalized;
}

function isReasonablePriceValue(price) {
  const numeric = Number(price);
  return (
    Number.isFinite(numeric) &&
    numeric >= LIVE_MIN_PRICE &&
    numeric <= LIVE_MAX_PRICE
  );
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function logLiveAttempt({ source, price = null, error = null }) {
  console.log({
    source,
    price,
    error,
  });
}



function getPriceRange(price) {
  return {
    min: Number((price * 0.98).toFixed(2)),
    max: Number((price * 1.02).toFixed(2)),
  };
}

function buildSourceSummary(source, extra = {}) {
  return {
    live_api: true,
    source,
    ...extra,
  };
}

async function fetchGoldAPI(city = DEFAULT_CITY) {
  const resolvedCity = city || DEFAULT_CITY;
  const endpoint = "https://api.gold-api.com/price/XAU/INR";
  const payload = await fetchJson(endpoint, {
    headers: {
      accept: "application/json",
    },
  });

  if (!payload || !payload.price || !Number.isFinite(Number(payload.price))) {
    throw new Error("Gold API failed");
  }

  const pricePerOunce = Number(payload.price);

  // Step 1: Convert ounce → gram (24K)
  const price24K = pricePerOunce / TROY_OUNCE_TO_GRAMS;

  // Step 2: Convert 24K → 22K (IMPORTANT FIX)
  const price22K = price24K * 0.916;

  // Step 3: Apply India markup (FINAL FIX)
  const INDIA_MARKUP = 1.085;

  const finalPriceRaw = price22K * INDIA_MARKUP;

  const finalPrice = Number(finalPriceRaw.toFixed(2));
  const confidence = 90; // static for now
  const range = getPriceRange(finalPrice);
  const normalizedPrice = normalizeFetchedPricePerGram(finalPrice);
  const fetchedAt = payload.updatedAt || new Date().toISOString();

  console.log({
    api_24k: price24K,
    converted_22k: price22K,
    adjusted_india: finalPriceRaw,
  });
  logLiveAttempt({ source: "gold-api", price: normalizedPrice, error: null });

  return {
    status: "available",
    is_live_available: true,
    source: "gold-api",
    city: resolvedCity,
    price_per_gram: normalizedPrice,
    confidence,
    price_range: range,
    fetched_at: fetchedAt,
    last_updated: fetchedAt,
    source_summary: buildSourceSummary("gold-api", {
      city: resolvedCity,
      india_markup: 1.085,
      ounce_inr: pricePerOunce,
      gram_inr: Number(price24K.toFixed(2)),
      final_price: normalizedPrice,
      confidence,
      price_range: range,
    }),
  };
}

async function fetchGoldPrice(city = DEFAULT_CITY) {
  try {
    const result = await fetchGoldAPI(city);
    logLiveAttempt({ source: "gold-api", price: result.price_per_gram, error: null });
    return result;
  } catch (error) {
    const reason = error.message || "Gold API failed";
    logLiveAttempt({ source: "gold-api", price: null, error: reason });
    return {
      status: "unavailable",
      is_live_available: false,
      live_error: reason,
      errors: [{ source: "gold-api", reason }],
    };
  }
}

function isPriceStale(priceRecord, referenceDate = new Date()) {
  if (!priceRecord?.fetched_at) {
    return true;
  }

  return (
    referenceDate.getTime() - new Date(priceRecord.fetched_at).getTime() >
    STALE_PRICE_WINDOW_MS
  );
}

function isApiBackedLiveSource(source) {
  return LIVE_SOURCES.includes(String(source || "").toLowerCase());
}

function serializeStoredPrice(entry, referenceDate = new Date()) {
  const fetchedAt = new Date(entry.fetched_at);
  const priceRange = {
    min: entry.min_price ?? Number((entry.price_per_gram * 0.98).toFixed(2)),
    max: entry.max_price ?? Number((entry.price_per_gram * 1.02).toFixed(2)),
  };

  return {
    id: entry.id,
    date: normalizeCalendarDate(entry.date).toISOString(),
    price_per_gram: entry.price_per_gram,
    min_price: entry.min_price ?? entry.price_per_gram,
    max_price: entry.max_price ?? entry.price_per_gram,
    confidence: entry.confidence,
    price_range: priceRange,
    city: entry.city,
    source: entry.source,
    source_summary: entry.source_summary,
    fetched_at: fetchedAt.toISOString(),
    freshness_label: formatFreshnessLabel(fetchedAt, referenceDate),
    minutes_since_update: getMinutesSince(fetchedAt, referenceDate),
    hours_since_update: getHoursSince(fetchedAt, referenceDate),
    is_outdated: getHoursSince(fetchedAt, referenceDate) > 6,
    is_stale: isPriceStale(entry, referenceDate),
    manual_override: entry.manual_override,
  };
}

async function findLatestStoredPriceAny(userId, city) {
  return prisma.goldPrice.findFirst({
    where: {
      user_id: userId,
      city: normalizeCity(city),
    },
    orderBy: {
      date: "desc",
    },
  });
}

async function findLatestReasonableStoredPriceAny(userId, city) {
  return prisma.goldPrice.findFirst({
    where: {
      user_id: userId,
      city: normalizeCity(city),
      price_per_gram: {
        gte: LIVE_MIN_PRICE,
        lte: LIVE_MAX_PRICE,
      },
    },
    orderBy: {
      date: "desc",
    },
  });
}

async function upsertGoldPrice({
  userId,
  city,
  date,
  pricePerGram,
  source,
  sourceSummary = null,
  confidence = null,
  priceRange = null,
  fetchedAt = new Date(),
  manualOverride = false,
}) {
  const normalizedCity = normalizeCity(city);
  const normalizedDate = startOfDay(date);

  const existing = await prisma.goldPrice.findUnique({
    where: {
      user_id_date_city: {
        user_id: userId,
        date: normalizedDate,
        city: normalizedCity,
      },
    },
  });

  if (existing?.manual_override && !manualOverride) {
    return existing;
  }

  return prisma.goldPrice.upsert({
    where: {
      user_id_date_city: {
        user_id: userId,
        date: normalizedDate,
        city: normalizedCity,
      },
    },
    update: {
      price_per_gram: pricePerGram,
      source,
      source_summary: sourceSummary,
      fetched_at: fetchedAt,
      min_price: priceRange?.min ?? null,
      max_price: priceRange?.max ?? null,
      confidence,
      manual_override: manualOverride,
    },
    create: {
      user_id: userId,
      date: normalizedDate,
      city: normalizedCity,
      price_per_gram: pricePerGram,
      source,
      source_summary: sourceSummary,
      fetched_at: fetchedAt,
      min_price: priceRange?.min ?? null,
      max_price: priceRange?.max ?? null,
      confidence,
      manual_override: manualOverride,
    },
  });
}

async function fetchLatestGoldPrice(
  userId,
  city = DEFAULT_CITY,
  referenceDate = new Date(),
  options = {},
) {
  const { forceRefresh = false } = options;
  const normalizedCity = normalizeCity(city);
  const today = startOfDay(referenceDate);
  const latestStored = await findLatestStoredPriceAny(userId, normalizedCity);
  const latestReasonableStored = await findLatestReasonableStoredPriceAny(
    userId,
    normalizedCity,
  );

  if (
    !forceRefresh &&
    latestStored &&
    normalizeCalendarDate(latestStored.date).getTime() === today.getTime() &&
    !isPriceStale(latestStored, referenceDate) &&
    isApiBackedLiveSource(latestStored.source)
  ) {
    const serializedStored = serializeStoredPrice(latestStored, referenceDate);

    return {
      status: "available",
      is_live_available: true,
      city: normalizedCity,
      fetched_at: serializedStored.fetched_at,
      last_updated: serializedStored.fetched_at,
      freshness_label: serializedStored.freshness_label,
      ...serializedStored,
      delayed_message: null,
      live_error: null,
    };
  }

  const liveResult = await fetchGoldPrice(normalizedCity);

  if (liveResult.status === "unavailable") {
    return {
      status: "unavailable",
      is_live_available: false,
      city: normalizedCity,
      live_error: liveResult.live_error || liveResult.message,
      fetched_at: new Date().toISOString(),
      last_known_historical:
        latestReasonableStored &&
          normalizeCalendarDate(latestReasonableStored.date).getTime() <= today.getTime()
          ? serializeStoredPrice(latestReasonableStored, referenceDate)
          : null,
      errors: liveResult.errors,
    };
  }

  const stored = await upsertGoldPrice({
    userId,
    city: normalizedCity,
    date: today,
    pricePerGram: liveResult.price_per_gram,
    source: liveResult.source,
    sourceSummary: liveResult.source_summary,
    confidence: liveResult.confidence ?? null,
    priceRange: liveResult.price_range || null,
    fetchedAt: new Date(liveResult.fetched_at),
  });

  const serializedStored = serializeStoredPrice(stored, referenceDate);

  return {
    status: "available",
    is_live_available: true,
    city: normalizedCity,
    fetched_at: serializedStored.fetched_at,
    last_updated: serializedStored.fetched_at,
    freshness_label: serializedStored.freshness_label,
    ...serializedStored,
    delayed_message: null,
    live_error: null,
  };
}

async function storeDailyGoldPrice(
  userId,
  city = DEFAULT_CITY,
  referenceDate = new Date(),
  options = {},
) {
  const livePrice = await fetchLatestGoldPrice(userId, city, referenceDate, options);

  if (!livePrice.is_live_available) {
    return null;
  }

  return prisma.goldPrice.findUnique({
    where: {
      user_id_date_city: {
        user_id: userId,
        date: startOfDay(referenceDate),
        city: normalizeCity(city),
      },
    },
  });
}

async function saveManualPrice(
  userId,
  city,
  pricePerGram,
  referenceDate = new Date(),
) {
  const normalizedPrice = normalizeFetchedPricePerGram(pricePerGram);
  const range = getPriceRange(normalizedPrice);

  const stored = await upsertGoldPrice({
    userId,
    city,
    date: referenceDate,
    pricePerGram: normalizedPrice,
    source: "manual:22K",
    sourceSummary: {
      live_api: false,
      source: "manual",
    },
    confidence: null,
    priceRange: range,
    fetchedAt: new Date(),
    manualOverride: true,
  });

  await logActivity(userId, "manual_override_saved", {
    city: normalizeCity(city),
    date: startOfDay(referenceDate).toISOString(),
    price_per_gram: normalizedPrice,
  });

  return stored;
}

async function getHistoricalRows(userId, city, startDate, endDate) {
  // Global history: do not filter by user_id
  const rows = await prisma.goldPrice.findMany({
    where: {
      city: normalizeCity(city),
      date: {
        gte: startOfDay(startDate),
        lte: startOfDay(endDate),
      },
    },
    orderBy: {
      date: "asc",
    },
  });

  return rows.filter((row) => isReasonablePriceValue(row.price_per_gram));
}

function dedupeHistoricalRows(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = normalizeCalendarDate(row.date).toISOString();
    const existing = map.get(key);

    if (!existing || new Date(row.fetched_at).getTime() > new Date(existing.fetched_at).getTime()) {
      map.set(key, row);
    }
  }

  return [...map.values()].sort(
    (left, right) => new Date(left.date).getTime() - new Date(right.date).getTime(),
  );
}

function buildTrendPayload(rows, range, referenceDate = new Date()) {
  const serializedRows = dedupeHistoricalRows(rows).map((row) =>
    serializeStoredPrice(row, referenceDate),
  );

  if (!serializedRows.length) {
    return {
      range,
      points: [],
      lowest: null,
      highest: null,
      today: null,
    };
  }

  const lowest = serializedRows.reduce((current, candidate) =>
    candidate.price_per_gram < current.price_per_gram ? candidate : current,
  );
  const highest = serializedRows.reduce((current, candidate) =>
    candidate.price_per_gram > current.price_per_gram ? candidate : current,
  );
  const todayKey = startOfDay(referenceDate).toISOString();
  const today =
    serializedRows.find((row) => row.date === todayKey) ||
    serializedRows[serializedRows.length - 1];

  return {
    range,
    points: serializedRows,
    lowest,
    highest,
    today,
  };
}

function getRangeStart(range, referenceDate = new Date()) {
  const days = SUPPORTED_RANGES[normalizeRange(range)];
  return new Date(startOfDay(referenceDate).getTime() - (days - 1) * DAY_IN_MS);
}

async function getTrendData(
  userId,
  city = DEFAULT_CITY,
  range = DEFAULT_RANGE,
  referenceDate = new Date(),
) {
  const normalizedRange = normalizeRange(range);
  const rows = await getHistoricalRows(
    userId,
    city,
    getRangeStart(normalizedRange, referenceDate),
    referenceDate,
  );

  return buildTrendPayload(rows, normalizedRange, referenceDate);
}

async function getTrendFromPaymentDate(
  userId,
  city = DEFAULT_CITY,
  lastPaymentDate,
  referenceDate = new Date(),
) {
  if (!lastPaymentDate) {
    return {
      is_available: false,
      from_date: null,
      to_date: null,
      points: [],
      lowest: null,
      highest: null,
      today: null,
    };
  }

  const normalizedPaymentDate = normalizeCalendarDate(lastPaymentDate);
  const rows = await getHistoricalRows(
    userId,
    city,
    normalizedPaymentDate,
    referenceDate,
  );
  const trend = buildTrendPayload(rows, "PAYMENT_WINDOW", referenceDate);

  return {
    is_available: true,
    from_date: normalizedPaymentDate.toISOString().slice(0, 10),
    to_date: startOfDay(referenceDate).toISOString().slice(0, 10),
    ...trend,
  };
}

async function getLast30DaysPrices(
  userId,
  city = DEFAULT_CITY,
  referenceDate = new Date(),
) {
  const rows = await getHistoricalRows(
    userId,
    city,
    new Date(startOfDay(referenceDate).getTime() - 29 * DAY_IN_MS),
    referenceDate,
  );

  return dedupeHistoricalRows(rows).map((row) => serializeStoredPrice(row, referenceDate));
}

async function getLowestPriceInLast30Days(
  userId,
  city = DEFAULT_CITY,
  referenceDate = new Date(),
) {
  const prices = await getLast30DaysPrices(userId, city, referenceDate);
  if (!prices.length) {
    return null;
  }
  if (!prices.length) {
    return {
      decision: "HOLD",
      confidence: 0,
      avgPrice: currentPrice,
      trend: "NONE"
    };
  }
  return prices.reduce((current, candidate) =>
    candidate.price_per_gram < current.price_per_gram ? candidate : current,
  );
}

async function buildDecision({ userId, currentPrice, daysLeft, analysisDays = 30 }) {
  const userObj = await prisma.user.findUnique({ where: { id: userId }, select: { city: true } });
  const city = userObj?.city || "Chennai";

  const historyRaw = await prisma.goldPrice.findMany({
    where: { city },
    orderBy: { date: "desc" },
    take: 100 // fetch a bunch to dedupe correctly
  });

  const map = new Map();
  for (const row of historyRaw) {
    const key = row.date.toISOString().slice(0, 10);
    if (
      !map.has(key) ||
      new Date(row.fetched_at) > new Date(map.get(key).fetched_at)
    ) {
      map.set(key, row);
    }
  }
  const history = Array.from(map.values())
    .sort((a, b) => new Date(b.date) - new Date(a.date)) // ensure desc
    .slice(0, analysisDays);

  if (!history || history.length === 0) {
    return {
      decision: "HOLD",
      confidence: 0,
      avgPrice: currentPrice,
      trend: "NONE",
      currentPrice,
      avg: currentPrice,
      deviationPercent: 0,
      deviation: 0,
      daysLeft,
      source: "gold-api"
    };
  }

  const rawPrices = history.map(p => p.price_per_gram);
  const avgTemp = rawPrices.reduce((a, b) => a + b, 0) / rawPrices.length;

  const prices = rawPrices.filter(p => Math.abs(p - avgTemp) < avgTemp * 0.2);
  
  if (prices.length < 2) {
    return {
      decision: "HOLD",
      confidence: 0,
      avgPrice: currentPrice,
      trend: "NONE",
      currentPrice,
      avg: currentPrice,
      deviationPercent: 0,
      deviation: 0,
      daysLeft,
      source: "gold-api"
    };
  }

  // 1. avg
  const avg = prices.reduce((sum, val) => sum + val, 0) / prices.length;

  // 2. avgVolatility
  const avgVolatility = prices.reduce((sum, price, i, arr) => {
    if (i === 0) return sum;
    return sum + Math.abs(price - arr[i - 1]);
  }, 0) / prices.length;

  // 3. volatility
  const volatility = Math.sqrt(
    prices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / (prices.length - 1 || 1)
  );

  // 4. zScore
  const zScore = (currentPrice - avg) / (volatility || 1);

  // 5. momentum
  const recentPrices = prices.length >= 5 ? prices.slice(0, 5) : prices;
  let momentum = 0;

  if (recentPrices.length >= 3) {
    const first = recentPrices[recentPrices.length - 1];
    const last = recentPrices[0];
    momentum = last - first;
  }

  let momentumSignal = "WEAK";
  const momentumThreshold = Math.max(volatility * 0.5, avg * 0.0015);

  if (momentum > momentumThreshold) momentumSignal = "STRONG_UP";
  if (momentum < -momentumThreshold) momentumSignal = "STRONG_DOWN";

  // 6. trendDirection
  let trendDirection = "FLAT";
  if (recentPrices.length >= 5) {
    const firstHalfAvg = recentPrices.slice(0, Math.floor(recentPrices.length / 2))
      .reduce((a, b) => a + b, 0) / Math.floor(recentPrices.length / 2);

    const secondHalfAvg = recentPrices.slice(Math.floor(recentPrices.length / 2))
      .reduce((a, b) => a + b, 0) / Math.ceil(recentPrices.length / 2);

    if (firstHalfAvg > secondHalfAvg) trendDirection = "UP";
    else if (firstHalfAvg < secondHalfAvg) trendDirection = "DOWN";
  }

  // 7. decision
  let decision = "HOLD";

  if (Math.abs(zScore) < 0.5) {
    decision = "HOLD";
  } else if (zScore < -1.2 && momentumSignal !== "STRONG_UP") {
    decision = "BUY";
  } else if (zScore > 1.2 && momentumSignal !== "STRONG_DOWN") {
    decision = "WAIT";
  }

  if (daysLeft <= 3 && decision !== "BUY") {
    decision = "BUY";
  }

  // 8. confidence
  let confidence = 40;

  confidence += Math.min(Math.abs(zScore) * 10, 20);

  if (prices.length >= 25) confidence += 10;

  if (volatility < avgVolatility) confidence += 10;

  if (momentumSignal.includes("STRONG") && Math.abs(zScore) > 0.8) {
    confidence += 10;
  }

  if (daysLeft <= 5) confidence += 10;

  confidence = Math.min(Math.round(confidence), 95);

  console.log("SMART ANALYSIS:", {
    currentPrice,
    avg,
    zScore,
    momentumSignal,
    trendDirection,
    volatility,
    decision,
    confidence,
    daysLeft
  });

  return {
    currentPrice,
    avg: Number(avg.toFixed(2)),
    avgPrice: Number(avg.toFixed(2)),
    deviationPercent: Number(((currentPrice - avg) / avg * 100).toFixed(2)),
    deviation: Number((currentPrice - avg).toFixed(2)),
    trend: trendDirection,
    decision,
    confidence,
    daysLeft,
    source: "gold-api",
    meta: {
      zScore: Number(zScore.toFixed(2)),
      momentum: momentumSignal,
      volatility: Number(volatility.toFixed(2)),
      trendDirection
    }
  };
}

function getPaymentWindow(lastPaymentDate, referenceDate = new Date()) {
  const nextDueDate = getNextDueDate(lastPaymentDate);
  const daysLeft = getDaysLeft(lastPaymentDate, referenceDate);

  console.log("[gold-price-alert] Payment window calculation", {
    lastPaymentDate: normalizeCalendarDate(lastPaymentDate).toISOString(),
    nextDueDate: nextDueDate.toISOString(),
    daysLeft,
  });

  return {
    lastPaymentDate: normalizeCalendarDate(lastPaymentDate).toISOString().slice(0, 10),
    nextDueDate: nextDueDate.toISOString().slice(0, 10),
    daysLeft,
    isOverdue: daysLeft < 0,
  };
}

function getNextTriggerTime(referenceDate = new Date(), alertTimeStr = "09:00") {
  const localeString = referenceDate.toLocaleString("en-US", {
    timeZone: ALERT_TIMEZONE,
  });
  const localizedDate = new Date(localeString);
  const nextRunLocal = new Date(localizedDate);

  const [hourStr, minuteStr] = (alertTimeStr || "09:00").split(":");
  let alertHour = parseInt(hourStr, 10);
  let alertMinute = parseInt(minuteStr, 10);

  if (isNaN(alertHour)) alertHour = 9;
  if (isNaN(alertMinute)) alertMinute = 0;

  nextRunLocal.setHours(alertHour, alertMinute, 0, 0);

  if (nextRunLocal.getTime() <= localizedDate.getTime()) {
    nextRunLocal.setDate(nextRunLocal.getDate() + 1);
  }

  const localOffsetMinutes = -nextRunLocal.getTimezoneOffset();
  return new Date(nextRunLocal.getTime() - localOffsetMinutes * 60 * 1000);
}

function formatNextTriggerLabel(nextTriggerAt, referenceDate = new Date(), alertTimeStr = "09:00") {
  const tomorrow = getNextTriggerTime(referenceDate, alertTimeStr);
  const isTomorrow =
    nextTriggerAt.toISOString().slice(0, 10) === tomorrow.toISOString().slice(0, 10);

  const [hourStr, minuteStr] = (alertTimeStr || "09:00").split(":");
  let h = parseInt(hourStr, 10);
  let m = parseInt(minuteStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  h = h ? h : 12;

  const displayTime = `${h}:${m < 10 ? '0' + m : m} ${ampm}`;

  return isTomorrow
    ? `Next alert at ${displayTime} tomorrow`
    : `Next alert at ${displayTime}`;
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
      analysis_days: Number(analysisDays)
    }
  });
}

async function updateUserCity(userId, city) {
  const normalizedCity = normalizeCity(city);

  return prisma.user.update({
    where: { id: userId },
    data: {
      city: normalizedCity,
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

  const city = normalizeCity(user?.city || DEFAULT_CITY);
  const livePrice = await fetchLatestGoldPrice(userId, city, referenceDate);
  const chart = await getTrendData(userId, city, range, referenceDate);
  const paymentTrend = await getTrendFromPaymentDate(
    userId,
    city,
    user?.last_payment_date,
    referenceDate,
  );

  let paymentWindow = null;
  let paymentWarning = null;

  if (user?.last_payment_date) {
    try {
      paymentWindow = getPaymentWindow(user.last_payment_date, referenceDate);
    } catch (error) {
      paymentWarning = error.message;
    }
  }

  const daysLeft = paymentWindow ? paymentWindow.daysLeft : 30;

  let decisionData;
  if (!livePrice?.is_live_available) {
    decisionData = {
      decision: "WAIT",
      confidence: 50,
      avgPrice: 0,
      deviation: 0,
      trend: "NONE"
    };
  } else {
    decisionData = await buildDecision({
      userId,
      currentPrice: livePrice.price_per_gram,
      daysLeft,
      analysisDays: user.analysis_days || 30
    });
  }

  const decision = {
    decision: decisionData.decision,
    confidence: decisionData.confidence,
    decision_meta: {
      avg30: decisionData.avgPrice,
      deviation_percent: decisionData.deviation,
      trend: decisionData.trend
    }
  };

  console.log({
    currentPrice: livePrice?.price_per_gram,
    avgPrice: decisionData.avgPrice,
    deviation: decisionData.deviation,
    trend: decisionData.trend,
    daysLeft,
    decision: decisionData.decision
  });

  const nextTriggerAt = getNextTriggerTime(referenceDate, user.alert_time);

  return {
    user: {
      ...serializeUser(user),
      city,
      alert_time: user.alert_time,
      analysis_days: user.analysis_days,
      supported_cities: SUPPORTED_CITIES,
      alert_preferences: normalizeAlertPreferences(user.alert_preferences),
      next_trigger_at: nextTriggerAt.toISOString(),
      next_trigger_label: formatNextTriggerLabel(nextTriggerAt, referenceDate, user.alert_time),
    },
    onboarding: {
      show_onboarding: !user.onboarding_completed_at,
      completed_at: user.onboarding_completed_at
        ? user.onboarding_completed_at.toISOString()
        : null,
      onboardingCompleted: Boolean(user.onboarding_completed_at),
      screens: [
        "You are overpaying gold every month",
        "Gold price changes daily - you miss the lowest",
        "We track and tell you when to pay",
        "Start saving money",
      ],
    },
    live_price: livePrice,
    decision,
    chart,
    payment_trend: paymentTrend,
    paymentWindow,
    paymentWarning,
    message: livePrice.is_live_available
      ? "Using gold-api market price"
      : "Live price unavailable. Historical data is shown below.",
  };
}

async function refreshGoldPriceForUser(userId, referenceDate = new Date()) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  const city = normalizeCity(user?.city || DEFAULT_CITY);
  const startedAt = Date.now();

  await logActivity(userId, "manual_refresh_requested", {
    city,
    requested_at: new Date().toISOString(),
  });

  const livePrice = await fetchLatestGoldPrice(userId, city, referenceDate, {
    forceRefresh: true,
  });
  const durationMs = Date.now() - startedAt;

  console.log("[gold-price-alert] Manual refresh response", {
    userId,
    city,
    response_time_ms: durationMs,
    is_live_available: livePrice.is_live_available,
    source: livePrice.source || null,
    price_per_gram: livePrice.price_per_gram || null,
    error: livePrice.live_error || null,
  });

  await logActivity(userId, "manual_refresh_completed", {
    city,
    response_time_ms: durationMs,
    is_live_available: livePrice.is_live_available,
    source: livePrice.source || null,
    price_per_gram: livePrice.price_per_gram || null,
    live_error: livePrice.live_error || null,
  });

  return {
    ...livePrice,
    response_time_ms: durationMs,
  };
}

function buildAlertMessages(summary) {
  if (!summary.live_price?.is_live_available) {
    return [];
  }

  const messages = [];

  if (
    summary.chart.lowest &&
    summary.live_price.price_per_gram <= summary.chart.lowest.price_per_gram
  ) {
    messages.push({
      type: "LOWEST",
      subject: "Gold Price Alert: Today is the low in range",
      text: "Gold is at the lowest point in the current trend window. PAY NOW",
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
    text: `Daily gold update: INR ${summary.live_price.price_per_gram.toFixed(2)}/g from ${summary.live_price.source}.`,
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
  const failures = [];

  try {
    await sendTelegramMessage(user.telegram_chat_id, alert.text);
    channelsSent.push("telegram");
  } catch {
    failures.push("telegram");
    await markTelegramDisconnected(user.id, "send_failed");
  }

  try {
    const emailResult = await sendEmailAlert(user, alert.subject, alert.text);
    if (emailResult.ok) {
      channelsSent.push("email");
    } else {
      failures.push(emailResult.reason);
    }
  } catch {
    failures.push("email");
  }

  if (!channelsSent.length) {
    return {
      skipped: true,
      reason: failures.join(",") || "no-channel",
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

  const summary = await getDashboardSummary(userId, referenceDate, "1M");
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
  const where = { telegram_verified: true };
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

async function buildGoldAlert(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const city = normalizeCity(user?.city || DEFAULT_CITY);
  const livePriceData = await fetchLatestGoldPrice(userId, city, new Date());

  if (!livePriceData || !livePriceData.is_live_available) {
    return "❌ Gold price is currently unavailable.";
  }

  const currentPrice = livePriceData.price_per_gram;

  let paymentWindow = null;
  if (user?.last_payment_date) {
    try {
      paymentWindow = getPaymentWindow(user.last_payment_date, new Date());
    } catch (e) { }
  }
  const daysLeft = paymentWindow ? paymentWindow.daysLeft : 30;

  const analysisDays = user?.analysis_days || 30;

  const decisionData = await buildDecision({
    userId,
    currentPrice,
    daysLeft,
    analysisDays
  });

  const difference = Math.abs(currentPrice - decisionData.avgPrice).toFixed(2);
  const aboveBelow = currentPrice > decisionData.avgPrice ? "Above" : "Below";

  const text = `🔥 Gold Alert (${city})

Price: ₹${currentPrice}
Status: ${decisionData.decision}
Confidence: ${decisionData.confidence}%

📊 ${aboveBelow} ${analysisDays}-day avg by ₹${difference}
⏳ Days left: ${daysLeft}

👉 Recommendation: ${decisionData.decision}`;

  return text;
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
  fetchGoldAPI,
  fetchGoldPrice,
  fetchLatestGoldPrice,
  formatNextTriggerLabel,
  getAlertHistory,
  getDashboardSummary,
  getLast30DaysPrices,
  getLowestPriceInLast30Days,
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
