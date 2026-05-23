const prisma = require("../lib/prisma");
const {
  estimateRetail22KFromSpot24K,
  fetchHistoryRange,
  fetchOhlcRange,
  fetchRealtimePrice,
  MODELED_RETAIL_MODEL_VERSION,
  MODELED_RETAIL_PRICE_SOURCE,
  modelRetail24KFromSpot24K,
} = require("./goldApiClient");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const RANGE_ALIASES = {
  "7d": "7d",
  "7D": "7d",
  "30d": "30d",
  "30D": "30d",
  "6m": "6M",
  "6M": "6M",
  "1w": "1W",
  "1W": "1W",
  "1m": "1M",
  "1M": "1M",
  "3m": "3M",
  "3M": "3M",
  "1y": "1Y",
  "1Y": "1Y",
};
const RANGE_TO_DAYS = {
  "7d": 7,
  "30d": 30,
  "6M": 183,
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "1Y": 365,
};
const SIGNAL_PRICE_BASIS = "spot_24k_inr_per_gram";
const DISPLAY_PRICE_BASIS = "retail_22k_inr_per_gram";
const SHORT_RANGE_SAMPLING_STRATEGY = "mixed_daily_history_and_intraday_realtime";
const LONG_RANGE_SAMPLING_STRATEGY = "daily_close_summary";

function isMissingTableError(error) {
  return (
    error?.code === "P2021" ||
    /does not exist in the current database/i.test(error?.message || "")
  );
}

async function withMissingTableFallback(operation, fallbackValue) {
  try {
    return await operation();
  } catch (error) {
    if (isMissingTableError(error)) {
      return fallbackValue;
    }

    throw error;
  }
}

function startOfDay(date = new Date()) {
  const value = new Date(date);
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function endOfDay(date = new Date()) {
  return new Date(startOfDay(date).getTime() + DAY_IN_MS - 1);
}

function getDateKey(date = new Date()) {
  return startOfDay(date).toISOString().slice(0, 10);
}

function normalizeRange(range = "30d") {
  const normalized = String(range).trim();
  return RANGE_ALIASES[normalized] || "30d";
}

function getRangeStart(range = "30d", referenceDate = new Date()) {
  const days = RANGE_TO_DAYS[normalizeRange(range)];
  return new Date(startOfDay(referenceDate).getTime() - (days - 1) * DAY_IN_MS);
}

function serializeGoldPrice(row) {
  if (!row) {
    return null;
  }

  const spot24kInrPerGram = Number(row.pricePerGram.toFixed(2));
  const retail24kInrPerGram = Number(
    (row.retail24kPricePerGram ?? modelRetail24KFromSpot24K(spot24kInrPerGram)).toFixed(2),
  );
  const retail22kInrPerGram = Number(
    (
      row.retail22kPricePerGram ??
      estimateRetail22KFromSpot24K(spot24kInrPerGram)
    ).toFixed(2),
  );
  const retailPriceSource = row.retailPriceSource || MODELED_RETAIL_PRICE_SOURCE;
  const retailPriceModelVersion =
    row.retailPriceModelVersion || MODELED_RETAIL_MODEL_VERSION;

  return {
    id: row.id,
    date: row.timestamp.toISOString(),
    timestamp: row.timestamp.toISOString(),
    price_basis: SIGNAL_PRICE_BASIS,
    signal_price_value: spot24kInrPerGram,
    signal_price_basis: SIGNAL_PRICE_BASIS,
    display_price_value: retail22kInrPerGram,
    display_price_basis: DISPLAY_PRICE_BASIS,
    display_price_source: retailPriceSource,
    display_price_model_version: retailPriceModelVersion,
    spot_24k_inr_per_gram: spot24kInrPerGram,
    retail_24k_inr_per_gram: retail24kInrPerGram,
    retail_22k_inr_per_gram: retail22kInrPerGram,
    retail_22k_inr_per_gram_estimate: retail22kInrPerGram,
    retail_price_source: retailPriceSource,
    retail_price_model_version: retailPriceModelVersion,
    retail_price_is_modeled: retailPriceSource === "modeled_spot_multiplier",
    source: row.source,
    created_at: row.createdAt.toISOString(),
  };
}

function serializeDailySummary(row) {
  if (!row) {
    return null;
  }

  const closeSpot24kInrPerGram = Number(row.closePrice.toFixed(2));
  const closeRetail24kInrPerGram = modelRetail24KFromSpot24K(
    closeSpot24kInrPerGram,
  );
  const closeRetail22kInrPerGram = estimateRetail22KFromSpot24K(
    closeSpot24kInrPerGram,
  );

  return {
    date: getDateKey(row.date),
    timestamp: row.date.toISOString(),
    price_basis: SIGNAL_PRICE_BASIS,
    signal_price_value: closeSpot24kInrPerGram,
    signal_price_basis: SIGNAL_PRICE_BASIS,
    display_price_value: closeRetail22kInrPerGram,
    display_price_basis: DISPLAY_PRICE_BASIS,
    display_price_source: MODELED_RETAIL_PRICE_SOURCE,
    display_price_model_version: MODELED_RETAIL_MODEL_VERSION,
    spot_24k_inr_per_gram: closeSpot24kInrPerGram,
    retail_24k_inr_per_gram: closeRetail24kInrPerGram,
    retail_22k_inr_per_gram: closeRetail22kInrPerGram,
    open_spot_24k_inr_per_gram: Number(row.openPrice.toFixed(2)),
    high_spot_24k_inr_per_gram: Number(row.highPrice.toFixed(2)),
    low_spot_24k_inr_per_gram: Number(row.lowPrice.toFixed(2)),
    close_spot_24k_inr_per_gram: closeSpot24kInrPerGram,
    close_retail_24k_inr_per_gram: closeRetail24kInrPerGram,
    close_retail_22k_inr_per_gram: closeRetail22kInrPerGram,
    close_retail_22k_inr_per_gram_estimate: closeRetail22kInrPerGram,
    retail_price_source: MODELED_RETAIL_PRICE_SOURCE,
    retail_price_model_version: MODELED_RETAIL_MODEL_VERSION,
    retail_price_is_modeled: true,
    source: row.source,
    validated_at: row.validatedAt ? row.validatedAt.toISOString() : null,
    validation_status: row.validationStatus,
  };
}

async function recordJobRun(jobName, data) {
  return prisma.systemJobRun.upsert({
    where: { jobName },
    update: data,
    create: {
      jobName,
      ...data,
    },
  });
}

async function storeRealtimeSnapshot(snapshot) {
  return prisma.goldPrice.upsert({
    where: {
      timestamp: snapshot.timestamp,
    },
    update: {
      pricePerGram: snapshot.spot24kInrPerGram,
      retail24kPricePerGram: snapshot.retail24kInrPerGram ?? null,
      retail22kPricePerGram: snapshot.retail22kInrPerGram ?? null,
      retailPriceSource: snapshot.retailPriceSource || MODELED_RETAIL_PRICE_SOURCE,
      retailPriceModelVersion:
        snapshot.retailPriceModelVersion || MODELED_RETAIL_MODEL_VERSION,
      source: snapshot.source,
    },
    create: {
      timestamp: snapshot.timestamp,
      pricePerGram: snapshot.spot24kInrPerGram,
      retail24kPricePerGram: snapshot.retail24kInrPerGram ?? null,
      retail22kPricePerGram: snapshot.retail22kInrPerGram ?? null,
      retailPriceSource: snapshot.retailPriceSource || MODELED_RETAIL_PRICE_SOURCE,
      retailPriceModelVersion:
        snapshot.retailPriceModelVersion || MODELED_RETAIL_MODEL_VERSION,
      source: snapshot.source,
    },
  });
}

async function rebuildDailySummariesFromRows(rows) {
  const distinctDays = [
    ...new Set(rows.map((row) => startOfDay(row.timestamp).toISOString())),
  ];

  await prisma.dailySummary.deleteMany({});

  for (const day of distinctDays) {
    await aggregateDailySummary(new Date(day));
  }
}

async function syncDailySummariesBetween(startDate, endDate) {
  const rows = await getPriceRowsBetween(startOfDay(startDate), endOfDay(endDate));
  const distinctDays = [
    ...new Set(rows.map((row) => startOfDay(row.timestamp).toISOString())),
  ];

  for (const day of distinctDays) {
    await aggregateDailySummary(new Date(day));
  }

  return distinctDays.length;
}

async function syncDailySummariesThrough(referenceDate = new Date()) {
  const latestSummary = await withMissingTableFallback(
    () =>
      prisma.dailySummary.findFirst({
        orderBy: {
          date: "desc",
        },
      }),
    null,
  );

  if (!latestSummary) {
    return syncDailySummariesBetween(getRangeStart("6M", referenceDate), referenceDate);
  }

  const nextDate = new Date(startOfDay(latestSummary.date).getTime() + DAY_IN_MS);
  if (nextDate.getTime() > startOfDay(referenceDate).getTime()) {
    return 0;
  }

  return syncDailySummariesBetween(nextDate, referenceDate);
}

async function backfillModeledRetailPrices({ force = false } = {}) {
  const retailSpotMultiplier = Number(process.env.GOLD_RETAIL_SPOT_MULTIPLIER || 1.155);
  const purityRatio = 22 / 24;

  if (!Number.isFinite(retailSpotMultiplier) || retailSpotMultiplier <= 0) {
    throw new Error("GOLD_RETAIL_SPOT_MULTIPLIER must be a positive number");
  }

  const whereClause = force
    ? ""
    : `WHERE "retail_24k_price_per_gram" IS NULL
        OR "retail_22k_price_per_gram" IS NULL
        OR "retail_price_source" IS NULL
        OR "retail_price_model_version" IS NULL`;

  return prisma.$executeRawUnsafe(
    `
      UPDATE "gold_prices"
      SET
        "retail_24k_price_per_gram" = ROUND(("price_per_gram"::numeric * $1::numeric), 2),
        "retail_22k_price_per_gram" = ROUND(("price_per_gram"::numeric * $1::numeric * $2::numeric), 2),
        "retail_price_source" = $3,
        "retail_price_model_version" = $4
      ${whereClause}
    `,
    retailSpotMultiplier,
    purityRatio,
    MODELED_RETAIL_PRICE_SOURCE,
    MODELED_RETAIL_MODEL_VERSION,
  );
}

async function ingestRealtimeSnapshot() {
  const snapshot = await fetchRealtimePrice();
  const stored = await storeRealtimeSnapshot(snapshot);

  return serializeGoldPrice(stored);
}

async function getLatestStoredPrice() {
  const latest = await withMissingTableFallback(
    () =>
      prisma.goldPrice.findFirst({
        orderBy: {
          timestamp: "desc",
        },
      }),
    null,
  );

  return serializeGoldPrice(latest);
}

async function getPriceRowsBetween(startDate, endDate) {
  return withMissingTableFallback(
    () =>
      prisma.goldPrice.findMany({
        where: {
          timestamp: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: {
          timestamp: "asc",
        },
      }),
    [],
  );
}

async function getDailySummaryRowsBetween(startDate, endDate) {
  return withMissingTableFallback(
    () =>
      prisma.dailySummary.findMany({
        where: {
          date: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: {
          date: "asc",
        },
      }),
    [],
  );
}

async function getMinPriceBetween(startDate, endDate) {
  const row = await withMissingTableFallback(
    () =>
      prisma.goldPrice.aggregate({
        _min: {
          pricePerGram: true,
        },
        where: {
          timestamp: {
            gte: startDate,
            lte: endDate,
          },
        },
      }),
    { _min: { pricePerGram: null } },
  );

  return row._min.pricePerGram ?? null;
}

async function getMaxPriceBetween(startDate, endDate) {
  const row = await withMissingTableFallback(
    () =>
      prisma.goldPrice.aggregate({
        _max: {
          pricePerGram: true,
        },
        where: {
          timestamp: {
            gte: startDate,
            lte: endDate,
          },
        },
      }),
    { _max: { pricePerGram: null } },
  );

  return row._max.pricePerGram ?? null;
}

function buildChartExtrema(points) {
  if (!points.length) {
    return {
      highest: null,
      lowest: null,
      today: null,
    };
  }

  const bySpotValue = [...points].sort(
    (left, right) =>
      left.spot_24k_inr_per_gram - right.spot_24k_inr_per_gram,
  );
  const latestPoint = [...points].sort(
    (left, right) => new Date(right.timestamp) - new Date(left.timestamp),
  )[0];

  return {
    lowest: bySpotValue[0],
    highest: bySpotValue[bySpotValue.length - 1],
    today: latestPoint,
  };
}

async function aggregateDailySummary(date = new Date()) {
  const day = startOfDay(date);
  const rows = await getPriceRowsBetween(day, endOfDay(day));

  if (!rows.length) {
    return null;
  }

  const prices = rows.map((row) => row.pricePerGram);
  const summary = await prisma.dailySummary.upsert({
    where: {
      date: day,
    },
    update: {
      openPrice: rows[0].pricePerGram,
      highPrice: Math.max(...prices),
      lowPrice: Math.min(...prices),
      closePrice: rows[rows.length - 1].pricePerGram,
      source: "aggregation",
    },
    create: {
      date: day,
      openPrice: rows[0].pricePerGram,
      highPrice: Math.max(...prices),
      lowPrice: Math.min(...prices),
      closePrice: rows[rows.length - 1].pricePerGram,
      source: "aggregation",
    },
  });

  return serializeDailySummary(summary);
}

function getPercentDiff(left, right) {
  const baseline = Math.abs(right) || 1;
  return Math.abs(left - right) / baseline;
}

async function validateDailySummary(date = new Date()) {
  const day = startOfDay(date);
  const summary = await prisma.dailySummary.findUnique({
    where: {
      date: day,
    },
  });

  if (!summary) {
    return null;
  }

  const startTimestamp = Math.floor(day.getTime() / 1000);
  const endTimestamp = Math.floor(endOfDay(day).getTime() / 1000);
  const [ohlcRow] = await fetchOhlcRange(startTimestamp, endTimestamp);

  if (!ohlcRow) {
    return null;
  }

  const diffs = {
    high: getPercentDiff(summary.highPrice, ohlcRow.highPrice),
    low: getPercentDiff(summary.lowPrice, ohlcRow.lowPrice),
    close: getPercentDiff(summary.closePrice, ohlcRow.closePrice),
  };

  const hasMismatch = Object.values(diffs).some((value) => value > 0.02);
  const shouldCorrect =
    String(process.env.GOLD_API_AUTO_CORRECT_DAILY_SUMMARY).toLowerCase() ===
    "true";

  const updated = await prisma.dailySummary.update({
    where: {
      date: day,
    },
    data: {
      highPrice: hasMismatch && shouldCorrect ? ohlcRow.highPrice : summary.highPrice,
      lowPrice: hasMismatch && shouldCorrect ? ohlcRow.lowPrice : summary.lowPrice,
      closePrice:
        hasMismatch && shouldCorrect ? ohlcRow.closePrice : summary.closePrice,
      validatedAt: new Date(),
      validationStatus: hasMismatch ? "mismatch" : "validated",
    },
  });

  if (hasMismatch) {
    console.warn("[gold-price-alert] daily summary mismatch", {
      date: getDateKey(day),
      diffs,
      corrected: shouldCorrect,
    });
  }

  return {
    summary: serializeDailySummary(updated),
    diffs,
    corrected: hasMismatch && shouldCorrect,
  };
}

async function backfillHistory({ startDate, endDate, force = false } = {}) {
  const jobName = "history-backfill";
  const existingRun = await prisma.systemJobRun.findUnique({
    where: { jobName },
  });
  const now = new Date();

  if (
    !force &&
    existingRun?.lastCompletedAt &&
    startOfDay(existingRun.lastCompletedAt).getTime() === startOfDay(now).getTime()
  ) {
    return {
      skipped: true,
      reason: "already-ran-today",
      inserted: 0,
    };
  }

  const start = startDate ? startOfDay(startDate) : new Date(startOfDay(now).getTime() - 182 * DAY_IN_MS);
  const end = endDate ? endOfDay(endDate) : endOfDay(now);

  await recordJobRun(jobName, {
    lastStartedAt: now,
    status: "running",
    metadata: {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    },
  });

  const rows = await fetchHistoryRange(
    Math.floor(start.getTime() / 1000),
    Math.floor(end.getTime() / 1000),
  );

  if (force) {
    await prisma.goldPrice.deleteMany({
      where: {
        source: "gold-api:history",
      },
    });
  }

  let inserted = 0;
  for (const row of rows) {
    await prisma.goldPrice.upsert({
      where: {
        timestamp: row.timestamp,
      },
      update: {
        pricePerGram: row.spot24kInrPerGram,
        retail24kPricePerGram: row.retail24kInrPerGram ?? null,
        retail22kPricePerGram: row.retail22kInrPerGram ?? null,
        retailPriceSource: row.retailPriceSource || MODELED_RETAIL_PRICE_SOURCE,
        retailPriceModelVersion:
          row.retailPriceModelVersion || MODELED_RETAIL_MODEL_VERSION,
        source: row.source,
      },
      create: {
        timestamp: row.timestamp,
        pricePerGram: row.spot24kInrPerGram,
        retail24kPricePerGram: row.retail24kInrPerGram ?? null,
        retail22kPricePerGram: row.retail22kInrPerGram ?? null,
        retailPriceSource: row.retailPriceSource || MODELED_RETAIL_PRICE_SOURCE,
        retailPriceModelVersion:
          row.retailPriceModelVersion || MODELED_RETAIL_MODEL_VERSION,
        source: row.source,
      },
    });
    inserted += 1;
  }

  await rebuildDailySummariesFromRows(rows);

  await recordJobRun(jobName, {
    lastStartedAt: now,
    lastCompletedAt: new Date(),
    status: "completed",
    metadata: {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      inserted,
    },
  });

  return {
    skipped: false,
    inserted,
  };
}

async function ensureMarketDataConsistency(referenceDate = new Date()) {
  const [backfilledRetailRows] = await Promise.all([
    backfillModeledRetailPrices(),
  ]);
  const syncedDailySummaryDays = await syncDailySummariesBetween(
    getRangeStart("6M", referenceDate),
    referenceDate,
  );

  return {
    backfilledRetailRows,
    syncedDailySummaryDays,
  };
}

async function get30DayLow(referenceDate = new Date()) {
  return getMinPriceBetween(getRangeStart("30d", referenceDate), referenceDate);
}

async function get30DayHigh(referenceDate = new Date()) {
  return getMaxPriceBetween(getRangeStart("30d", referenceDate), referenceDate);
}

function getPricePosition(currentPrice, lowPrice, highPrice) {
  if (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(lowPrice) ||
    !Number.isFinite(highPrice)
  ) {
    return null;
  }

  if (highPrice === lowPrice) {
    return 0.5;
  }

  return Number(
    ((currentPrice - lowPrice) / (highPrice - lowPrice)).toFixed(4),
  );
}

function getBuySignal(currentPrice, lowPrice, highPrice) {
  if (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(lowPrice) ||
    !Number.isFinite(highPrice)
  ) {
    return "HOLD";
  }

  if (currentPrice <= lowPrice * 1.02) {
    return "BUY";
  }

  if (currentPrice >= highPrice * 0.98) {
    return "WAIT";
  }

  return "HOLD";
}

async function buildAnalytics(referenceDate = new Date()) {
  const [latest, low30d, high30d] = await Promise.all([
    getLatestStoredPrice(),
    get30DayLow(referenceDate),
    get30DayHigh(referenceDate),
  ]);

  const currentPrice = latest?.spot_24k_inr_per_gram ?? null;
  const currentRetailPrice =
    latest?.retail_22k_inr_per_gram ?? latest?.retail_22k_inr_per_gram_estimate ?? null;
  return {
    current_price: currentPrice,
    current_spot_24k_inr_per_gram: currentPrice,
    current_display_price: currentRetailPrice,
    current_display_price_basis: DISPLAY_PRICE_BASIS,
    current_display_price_source:
      latest?.retail_price_source || MODELED_RETAIL_PRICE_SOURCE,
    current_display_price_model_version:
      latest?.retail_price_model_version || MODELED_RETAIL_MODEL_VERSION,
    current_retail_22k_inr_per_gram_estimate: currentRetailPrice,
    low_30d: low30d,
    high_30d: high30d,
    retail_low_30d: low30d === null ? null : estimateRetail22KFromSpot24K(low30d),
    retail_high_30d:
      high30d === null ? null : estimateRetail22KFromSpot24K(high30d),
    signal_price_basis: SIGNAL_PRICE_BASIS,
    display_price_basis: DISPLAY_PRICE_BASIS,
    price_position:
      currentPrice === null ? null : getPricePosition(currentPrice, low30d, high30d),
    buy_signal:
      currentPrice === null ? "HOLD" : getBuySignal(currentPrice, low30d, high30d),
    last_updated: latest?.timestamp ?? null,
  };
}

async function getPriceRangePayload(range = "30d", referenceDate = new Date()) {
  const normalizedRange = normalizeRange(range);
  let points = [];

  if (normalizedRange === "6M") {
    await syncDailySummariesThrough(referenceDate);
    const rows = await getDailySummaryRowsBetween(
      getRangeStart(normalizedRange, referenceDate),
      startOfDay(referenceDate),
    );

    points = rows.map(serializeDailySummary);
  } else {
    const rows = await getPriceRowsBetween(
      getRangeStart(normalizedRange, referenceDate),
      referenceDate,
    );
    points = rows.map(serializeGoldPrice);
  }

  const extrema = buildChartExtrema(points);
  return {
    range: normalizedRange,
    price_basis: SIGNAL_PRICE_BASIS,
    signal_price_basis: SIGNAL_PRICE_BASIS,
    display_price_basis: DISPLAY_PRICE_BASIS,
    display_price_source: MODELED_RETAIL_PRICE_SOURCE,
    display_price_model_version: MODELED_RETAIL_MODEL_VERSION,
    display_basis_label: "24K spot INR/g",
    sampling_strategy:
      normalizedRange === "6M"
        ? LONG_RANGE_SAMPLING_STRATEGY
        : SHORT_RANGE_SAMPLING_STRATEGY,
    points,
    ...extrema,
    ...(await buildAnalytics(referenceDate)),
  };
}

async function getPaymentWindowRange(lastPaymentDate, referenceDate = new Date()) {
  const start = startOfDay(lastPaymentDate);
  const rows = await getPriceRowsBetween(start, referenceDate);

  return {
    is_available: true,
    from_date: getDateKey(start),
    to_date: getDateKey(referenceDate),
    points: rows.map(serializeGoldPrice),
  };
}

module.exports = {
  aggregateDailySummary,
  backfillHistory,
  backfillModeledRetailPrices,
  buildAnalytics,
  ensureMarketDataConsistency,
  endOfDay,
  get30DayHigh,
  get30DayLow,
  getBuySignal,
  getLatestStoredPrice,
  getPaymentWindowRange,
  getPricePosition,
  getPriceRangePayload,
  getRangeStart,
  getDateKey,
  ingestRealtimeSnapshot,
  normalizeRange,
  serializeDailySummary,
  serializeGoldPrice,
  startOfDay,
  storeRealtimeSnapshot,
  syncDailySummariesBetween,
  syncDailySummariesThrough,
  validateDailySummary,
};
