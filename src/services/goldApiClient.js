const { validateEnv } = require("../config/env");

const GOLD_API_BASE_URL = "https://api.gold-api.com";
const TROY_OUNCE_TO_GRAMS = 31.1035;
const RETAIL_PURITY_RATIO = 22 / 24;
const EXCHANGE_RATE_CACHE_TTL_MS = 10 * 60 * 1000;

let cachedSpotReference = null;

function roundPrice(value) {
  return Number(Number(value).toFixed(2));
}

function ounceToGram(pricePerOunce) {
  return roundPrice(Number(pricePerOunce) / TROY_OUNCE_TO_GRAMS);
}

function spotPerOunceToInrPerGram(pricePerOunce, exchangeRate = 1) {
  return ounceToGram(Number(pricePerOunce) * Number(exchangeRate));
}

function getRetailPremiumInrPerGram() {
  return validateEnv().retailPremiumInrPerGram;
}

function estimateRetail22KFromSpot24K(
  spot24kInrPerGram,
  premiumInrPerGram = getRetailPremiumInrPerGram(),
) {
  return roundPrice(
    Number(spot24kInrPerGram) * RETAIL_PURITY_RATIO + Number(premiumInrPerGram),
  );
}

function normalizeApiTimestamp(value, fallback = new Date()) {
  if (!value) {
    return fallback;
  }

  if (typeof value === "number") {
    const candidate = new Date(value * 1000);
    return Number.isNaN(candidate.getTime()) ? fallback : candidate;
  }

  const normalizedValue = String(value).includes(" ")
    ? String(value).replace(" ", "T").concat("Z")
    : String(value);
  const candidate = new Date(normalizedValue);

  if (Number.isNaN(candidate.getTime())) {
    return fallback;
  }

  return candidate;
}

function buildNormalizedSpotPrice({
  timestamp,
  spot24kInrPerGram,
  source,
  exchangeRate = null,
  raw = null,
}) {
  const normalizedSpot = roundPrice(spot24kInrPerGram);

  return {
    timestamp,
    source,
    exchangeRate: exchangeRate === null ? null : Number(exchangeRate),
    spot24kInrPerGram: normalizedSpot,
    retail22kInrPerGramEstimate: estimateRetail22KFromSpot24K(normalizedSpot),
    raw,
  };
}

function buildNormalizedHistoryPoint({
  timestamp,
  spot24kInrPerGram,
  source,
  exchangeRate = null,
  raw = null,
}) {
  return {
    ...buildNormalizedSpotPrice({
      timestamp,
      spot24kInrPerGram,
      source,
      exchangeRate,
      raw,
    }),
    date: timestamp.toISOString(),
  };
}

function normalizeOhlcPoint(row, exchangeRate) {
  return {
    timestamp: normalizeApiTimestamp(
      row.timestamp || row.date || row.time || row.endTimestamp || row.day,
      new Date(row.endTimestamp ? row.endTimestamp * 1000 : Date.now()),
    ),
    openPrice: spotPerOunceToInrPerGram(
      Number(row.open_price ?? row.open),
      exchangeRate,
    ),
    highPrice: spotPerOunceToInrPerGram(
      Number(row.high_price ?? row.high),
      exchangeRate,
    ),
    lowPrice: spotPerOunceToInrPerGram(
      Number(row.low_price ?? row.low),
      exchangeRate,
    ),
    closePrice: spotPerOunceToInrPerGram(
      Number(row.close_price ?? row.close),
      exchangeRate,
    ),
    exchangeRate: Number(exchangeRate),
    raw: row,
  };
}

function getAuthHeaders() {
  return {
    accept: "application/json",
    "x-api-key": process.env.GOLD_API_KEY,
  };
}

async function fetchJson(pathname, query = null) {
  const url = new URL(`${GOLD_API_BASE_URL}${pathname}`);

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const response = await fetch(url, {
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    const error = new Error(`Gold API request failed with HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
}

async function fetchSpotReferenceQuote({ forceRefresh = false } = {}) {
  if (
    !forceRefresh &&
    cachedSpotReference &&
    Date.now() - cachedSpotReference.cachedAt < EXCHANGE_RATE_CACHE_TTL_MS
  ) {
    return cachedSpotReference.value;
  }

  const payload = await fetchJson("/price/XAU/INR");
  const pricePerOunceInr = Number(payload?.price);
  const exchangeRate = Number(payload?.exchangeRate);

  if (!Number.isFinite(pricePerOunceInr) || pricePerOunceInr <= 0) {
    throw new Error("Gold API returned an invalid realtime price");
  }

  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    throw new Error("Gold API returned an invalid exchange rate");
  }

  const value = buildNormalizedSpotPrice({
    timestamp: normalizeApiTimestamp(
      payload.updatedAt || payload.timestamp || payload.time,
      new Date(),
    ),
    spot24kInrPerGram: spotPerOunceToInrPerGram(pricePerOunceInr),
    source: "gold-api:realtime",
    exchangeRate,
    raw: payload,
  });

  cachedSpotReference = {
    cachedAt: Date.now(),
    value,
  };

  return value;
}

async function fetchRealtimePrice() {
  return fetchSpotReferenceQuote({ forceRefresh: true });
}

async function fetchHistoryRange(startTimestamp, endTimestamp) {
  const [referenceQuote, payload] = await Promise.all([
    fetchSpotReferenceQuote(),
    fetchJson("/history", {
      symbol: "XAU",
      currency: "INR",
      groupBy: "day",
      startTimestamp,
      endTimestamp,
    }),
  ]);

  const rows = Array.isArray(payload)
    ? payload
    : payload?.data || payload?.prices || payload?.history || [];

  if (!Array.isArray(rows)) {
    throw new Error("Gold API history response is not iterable");
  }

  return rows.map((row) => {
    const rawSpotPerOunce = Number(
      row.max_price ?? row.price ?? row.close_price ?? row.close,
    );

    if (!Number.isFinite(rawSpotPerOunce) || rawSpotPerOunce <= 0) {
      throw new Error("Gold API history row has an invalid price");
    }

    return buildNormalizedHistoryPoint({
      timestamp: normalizeApiTimestamp(
        row.timestamp || row.date || row.time || row.endTimestamp || row.day,
        new Date(startTimestamp * 1000),
      ),
      spot24kInrPerGram: spotPerOunceToInrPerGram(
        rawSpotPerOunce,
        referenceQuote.exchangeRate,
      ),
      source: "gold-api:history",
      exchangeRate: referenceQuote.exchangeRate,
      raw: row,
    });
  });
}

async function fetchOhlcRange(startTimestamp, endTimestamp) {
  const [referenceQuote, payload] = await Promise.all([
    fetchSpotReferenceQuote(),
    fetchJson("/ohlc/XAU", {
      currency: "INR",
      startTimestamp,
      endTimestamp,
    }),
  ]);

  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.prices)
        ? payload.prices
        : Array.isArray(payload?.ohlc)
          ? payload.ohlc
          : payload && typeof payload === "object"
            ? [payload]
            : [];

  if (!Array.isArray(rows)) {
    throw new Error("Gold API OHLC response is not iterable");
  }

  return rows.map((row) => normalizeOhlcPoint(row, referenceQuote.exchangeRate));
}

module.exports = {
  RETAIL_PURITY_RATIO,
  TROY_OUNCE_TO_GRAMS,
  buildNormalizedHistoryPoint,
  buildNormalizedSpotPrice,
  estimateRetail22KFromSpot24K,
  fetchHistoryRange,
  fetchOhlcRange,
  fetchRealtimePrice,
  fetchSpotReferenceQuote,
  normalizeApiTimestamp,
  ounceToGram,
  spotPerOunceToInrPerGram,
};
