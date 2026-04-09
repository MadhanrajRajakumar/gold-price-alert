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
const SUPPORTED_CITIES = ["Chennai", "Mumbai", "Delhi"];
const SUPPORTED_RANGES = {
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "6M": 180,
  "1Y": 365,
};
const LIVE_SOURCES = ["metalpriceapi", "goldapi", "manual:22k"];
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
    throw new Error("Fetched gold price is invalid");
  }

  const normalized = Number(numeric.toFixed(2));
  if (normalized < LIVE_MIN_PRICE || normalized > LIVE_MAX_PRICE) {
    throw new Error("Invalid price");
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

function getJsonValue(payload, paths) {
  for (const path of paths) {
    let current = payload;
    let valid = true;

    for (const key of path) {
      if (current && Object.prototype.hasOwnProperty.call(current, key)) {
        current = current[key];
      } else {
        valid = false;
        break;
      }
    }

    if (valid && current !== null && current !== undefined) {
      return current;
    }
  }

  return null;
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

function convertToINRPerGram(usdPrice, usdToInr) {
  const perGram = Number(usdPrice) / TROY_OUNCE_TO_GRAMS;
  return perGram * Number(usdToInr);
}

function convert24kTo22k(price) {
  return Number(price) * 0.916;
}

function inr10g24kTo22kPerGram(inrPer10g24k) {
  return normalizeFetchedPricePerGram(
    convert24kTo22k(Number(inrPer10g24k) / 10),
  );
}

function buildSourceSummary(source, extra = {}) {
  return {
    live_api: true,
    source,
    ...extra,
  };
}

async function fetchMetalsAPI() {
  const apiKey = process.env.METALPRICE_API_KEY || process.env.METALPRICEAPI_KEY || process.env.METALS_API_KEY;

  if (!apiKey) {
    throw new Error("MetalpriceAPI not configured");
  }

  const endpoint =
    process.env.METALPRICEAPI_URL ||
    process.env.METALS_API_URL ||
    "https://api.metalpriceapi.com/v1/latest";
  const url = new URL(endpoint);
  if (!url.searchParams.has("api_key")) {
    url.searchParams.set("api_key", apiKey);
  }
  if (!url.searchParams.has("base")) {
    url.searchParams.set("base", "USD");
  }
  if (!url.searchParams.has("currencies")) {
    url.searchParams.set("currencies", "XAU,INR");
  }

  console.log("[gold-price-alert] MetalpriceAPI Request:", {
    url: url.toString(),
    hasApiKey: !!apiKey,
  });

  const payload = await fetchJson(url.toString(), {
    headers: {
      accept: "application/json",
    },
  });

  console.log("[gold-price-alert] MetalpriceAPI Raw Response:", JSON.stringify(payload, null, 2));

  if (payload.success === false) {
    console.error("[gold-price-alert] MetalpriceAPI Error Response:", payload);
    throw new Error(payload.error?.info || "MetalpriceAPI failure");
  }

  const xauRate = getJsonValue(payload, [["rates", "USDXAU"], ["rates", "XAU"]]);
  const inrRate = getJsonValue(payload, [["rates", "INR"]]);

  console.log("[gold-price-alert] Extracted rates:", {
    xauRate,
    inrRate,
    allRates: payload.rates,
  });

  if (!xauRate || !inrRate) {
    console.error("[gold-price-alert] Missing rates:", { xauRate, inrRate, payload });
    throw new Error("MetalpriceAPI response missing USDXAU/INR rates");
  }

  const rawUSD = 1 / Number(xauRate);
  const inrPerOunce = rawUSD * Number(inrRate);
  const convertedINR = inrPerOunce / TROY_OUNCE_TO_GRAMS;
  const final22k = convert24kTo22k(convertedINR);
  const price = normalizeFetchedPricePerGram(final22k);
  console.log({
    rawUSD,
    convertedINR,
    final22k,
    source: "metals_api",
  });
  logLiveAttempt({ source: "metals_api", price, error: null });

  return {
    source: "metalpriceapi",
    price_per_gram: price,
    fetched_at: new Date().toISOString(),
    delayed_message: "Data may be delayed (free plan)",
    source_summary: buildSourceSummary("metalpriceapi", {
      raw_usd_ounce_24k: Number(rawUSD.toFixed(2)),
      converted_inr_gram_24k: Number(convertedINR.toFixed(2)),
      final_22k: price,
      usd_inr: Number(inrRate),
    }),
  };
}

async function fetchGoldAPI() {
  const apiKey = process.env.GOLDAPI_KEY;

  if (!apiKey) {
    throw new Error("GoldAPI not configured");
  }

  const endpoint = process.env.GOLDAPI_URL || "https://www.goldapi.io/api/XAU/INR";
  const payload = await fetchJson(endpoint, {
    headers: {
      accept: "application/json",
      "x-access-token": apiKey,
    },
  });

  const direct22kPerGram = getJsonValue(payload, [
    ["price_gram_22k"],
    ["price_gram_22ct"],
  ]);

  if (direct22kPerGram !== null) {
    const price = normalizeFetchedPricePerGram(direct22kPerGram);
    console.log({
      rawUSD: null,
      convertedINR: Number(direct22kPerGram),
      final22k: price,
      source: "goldapi",
    });
    logLiveAttempt({ source: "goldapi", price, error: null });
    return {
      source: "goldapi",
      price_per_gram: price,
      fetched_at: new Date().toISOString(),
      source_summary: buildSourceSummary("goldapi"),
    };
  }

  const direct24kPerGram = getJsonValue(payload, [
    ["price_gram_24k"],
    ["price_gram_24ct"],
  ]);

  if (direct24kPerGram !== null) {
    const convertedINR = Number(direct24kPerGram);
    const final22k = convert24kTo22k(convertedINR);
    const price = normalizeFetchedPricePerGram(final22k);
    console.log({
      rawUSD: null,
      convertedINR,
      final22k,
      source: "goldapi",
    });
    logLiveAttempt({ source: "goldapi", price, error: null });
    return {
      source: "goldapi",
      price_per_gram: price,
      fetched_at: new Date().toISOString(),
      source_summary: buildSourceSummary("goldapi"),
    };
  }

  const inrPerOunce = getJsonValue(payload, [["price"], ["price_ounce"]]);

  if (inrPerOunce !== null) {
    const rawUSD = null;
    const convertedINR = Number(inrPerOunce) / TROY_OUNCE_TO_GRAMS;
    const final22k = convert24kTo22k(convertedINR);
    const price = normalizeFetchedPricePerGram(final22k);
    console.log({
      rawUSD,
      convertedINR,
      final22k,
      source: "goldapi",
    });
    logLiveAttempt({ source: "goldapi", price, error: null });
    return {
      source: "goldapi",
      price_per_gram: price,
      fetched_at: new Date().toISOString(),
      source_summary: buildSourceSummary("goldapi"),
    };
  }

  throw new Error("GoldAPI response missing supported price fields");
}

async function fetchGoldPrice() {
  const attempts = [
    ["metalpriceapi", fetchMetalsAPI],
    ["goldapi", fetchGoldAPI],
  ];
  const errors = [];

  for (const [source, fn] of attempts) {
    try {
      const result = await fn();
      logLiveAttempt({ source, price: result.price_per_gram, error: null });
      return result;
    } catch (error) {
      const reason = error.message || "Unknown error";
      errors.push({ source, reason });
      logLiveAttempt({ source, price: null, error: reason });
    }
  }

  return {
    status: "unavailable",
    message: "Live data unavailable",
    errors,
  };
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

  return {
    id: entry.id,
    date: normalizeCalendarDate(entry.date).toISOString(),
    price_per_gram: entry.price_per_gram,
    min_price: entry.min_price ?? entry.price_per_gram,
    max_price: entry.max_price ?? entry.price_per_gram,
    confidence: entry.confidence,
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

async function findLatestStoredPrice(userId, city, beforeDate) {
  return prisma.goldPrice.findFirst({
    where: {
      user_id: userId,
      city: normalizeCity(city),
      ...(beforeDate
        ? {
            date: {
              lt: startOfDay(beforeDate),
            },
          }
        : {}),
    },
    orderBy: {
      date: "desc",
    },
  });
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
      min_price: null,
      max_price: null,
      confidence: null,
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
      min_price: null,
      max_price: null,
      confidence: null,
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
      freshness_label: serializedStored.freshness_label,
      ...serializedStored,
      delayed_message:
        latestStored.source === "metalpriceapi"
          ? "Data may be delayed (free plan)"
          : null,
      live_error: null,
    };
  }

  const liveResult = await fetchGoldPrice();

  if (liveResult.status === "unavailable") {
    return {
      status: "unavailable",
      is_live_available: false,
      city: normalizedCity,
      live_error: liveResult.message,
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
    fetchedAt: new Date(liveResult.fetched_at),
  });

  const serializedStored = serializeStoredPrice(stored, referenceDate);

  return {
    status: "available",
    is_live_available: true,
    city: normalizedCity,
    fetched_at: serializedStored.fetched_at,
    freshness_label: serializedStored.freshness_label,
    ...serializedStored,
    delayed_message: liveResult.delayed_message || null,
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
  const rows = await prisma.goldPrice.findMany({
    where: {
      user_id: userId,
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

  return prices.reduce((current, candidate) =>
    candidate.price_per_gram < current.price_per_gram ? candidate : current,
  );
}

function buildDecision(livePrice, historicalLow, paymentWindow) {
  if (!livePrice?.is_live_available) {
    return {
      score: null,
      label: "LIVE DATA UNAVAILABLE",
      message: "Unable to fetch live data",
    };
  }

  let score = 5;

  if (historicalLow !== null && livePrice.price_per_gram <= historicalLow + 50) {
    score += 3;
  }

  if (paymentWindow && paymentWindow.daysLeft <= 3) {
    score += 2;
  }

  if (score >= 8) {
    return {
      score,
      label: "PAY TODAY",
      message: "Good time to pay",
    };
  }

  return {
    score,
    label: "WAIT",
    message: "Wait",
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

function getNextTriggerTime(referenceDate = new Date()) {
  const localeString = referenceDate.toLocaleString("en-US", {
    timeZone: ALERT_TIMEZONE,
  });
  const localizedDate = new Date(localeString);
  const nextRunLocal = new Date(localizedDate);
  nextRunLocal.setHours(ALERT_HOUR, ALERT_MINUTE, 0, 0);

  if (nextRunLocal.getTime() <= localizedDate.getTime()) {
    nextRunLocal.setDate(nextRunLocal.getDate() + 1);
  }

  const localOffsetMinutes = -nextRunLocal.getTimezoneOffset();
  return new Date(nextRunLocal.getTime() - localOffsetMinutes * 60 * 1000);
}

function formatNextTriggerLabel(nextTriggerAt, referenceDate = new Date()) {
  const tomorrow = getNextTriggerTime(referenceDate);
  const isTomorrow =
    nextTriggerAt.toISOString().slice(0, 10) === tomorrow.toISOString().slice(0, 10);

  return isTomorrow
    ? "Next alert at 9:00 AM tomorrow"
    : "Next alert at 9:00 AM";
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

  const historicalLow = chart.lowest?.price_per_gram ?? null;
  const decision = buildDecision(livePrice, historicalLow, paymentWindow);
  const nextTriggerAt = getNextTriggerTime(referenceDate);

  return {
    user: {
      ...serializeUser(user),
      city,
      supported_cities: SUPPORTED_CITIES,
      alert_preferences: normalizeAlertPreferences(user.alert_preferences),
      next_trigger_at: nextTriggerAt.toISOString(),
      next_trigger_label: formatNextTriggerLabel(nextTriggerAt, referenceDate),
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
      ? "Live API price and historical trends are available"
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
      text: "\uD83D\uDD25 Gold is at the lowest point in the current trend window. PAY NOW",
    });
  }

  if (summary.paymentWindow && summary.paymentWindow.daysLeft <= 3) {
    messages.push({
      type: "DEADLINE",
      subject: "Gold Price Alert: Payment deadline approaching",
      text: summary.paymentWindow.isOverdue
        ? "\u26A0\uFE0F Payment overdue"
        : `\u26A0\uFE0F Only ${summary.paymentWindow.daysLeft} days left to pay`,
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
  } catch (_error) {
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

async function processAlertsForAllUsers(referenceDate = new Date()) {
  const users = await prisma.user.findMany({
    where: {
      telegram_verified: true,
    },
    select: { id: true },
  });

  const results = [];
  for (const user of users) {
    results.push(await processScheduledAlertsForUser(user.id, referenceDate));
  }

  return results;
}

module.exports = {
  ALERT_TIMEZONE,
  DEFAULT_CITY,
  DEFAULT_RANGE,
  SUPPORTED_CITIES,
  SUPPORTED_RANGES,
  buildDecision,
  completeOnboarding,
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
  updateUserCity,
  updateUserPaymentDate,
};
