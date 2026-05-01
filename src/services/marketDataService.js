const prisma = require("../lib/prisma");
const {
  estimateRetail22KFromSpot24K,
  fetchHistoryRange,
  fetchOhlcRange,
  fetchRealtimePrice,
} = require("./goldApiClient");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const RANGE_TO_DAYS = {
  "7d": 7,
  "30d": 30,
  "6m": 183,
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "1Y": 365,
};

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
  return RANGE_TO_DAYS[normalized] ? normalized : "30d";
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
  const retail22kInrPerGramEstimate = estimateRetail22KFromSpot24K(
    spot24kInrPerGram,
  );

  return {
    id: row.id,
    date: row.timestamp.toISOString(),
    timestamp: row.timestamp.toISOString(),
    price_basis: "spot_24k_inr_per_gram",
    spot_24k_inr_per_gram: spot24kInrPerGram,
    retail_22k_inr_per_gram_estimate: retail22kInrPerGramEstimate,
    source: row.source,
    created_at: row.createdAt.toISOString(),
  };
}

function serializeDailySummary(row) {
  if (!row) {
    return null;
  }

  const closeSpot24kInrPerGram = Number(row.closePrice.toFixed(2));
  const closeRetail22kInrPerGramEstimate = estimateRetail22KFromSpot24K(
    closeSpot24kInrPerGram,
  );

  return {
    date: getDateKey(row.date),
    price_basis: "spot_24k_inr_per_gram",
    open_spot_24k_inr_per_gram: Number(row.openPrice.toFixed(2)),
    high_spot_24k_inr_per_gram: Number(row.highPrice.toFixed(2)),
    low_spot_24k_inr_per_gram: Number(row.lowPrice.toFixed(2)),
    close_spot_24k_inr_per_gram: closeSpot24kInrPerGram,
    close_retail_22k_inr_per_gram_estimate: closeRetail22kInrPerGramEstimate,
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
      source: snapshot.source,
    },
    create: {
      timestamp: snapshot.timestamp,
      pricePerGram: snapshot.spot24kInrPerGram,
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
        source: row.source,
      },
      create: {
        timestamp: row.timestamp,
        pricePerGram: row.spot24kInrPerGram,
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
    latest?.retail_22k_inr_per_gram_estimate ?? null;
  return {
    current_price: currentPrice,
    current_spot_24k_inr_per_gram: currentPrice,
    current_retail_22k_inr_per_gram_estimate: currentRetailPrice,
    low_30d: low30d,
    high_30d: high30d,
    retail_low_30d: low30d === null ? null : estimateRetail22KFromSpot24K(low30d),
    retail_high_30d:
      high30d === null ? null : estimateRetail22KFromSpot24K(high30d),
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

  if (normalizedRange === "6m") {
    const rows = await getDailySummaryRowsBetween(
      getRangeStart(normalizedRange, referenceDate),
      startOfDay(referenceDate),
    );

    points = rows.map((row) => ({
      date: row.date.toISOString(),
      timestamp: row.date.toISOString(),
      price_basis: "spot_24k_inr_per_gram",
      spot_24k_inr_per_gram: Number(row.closePrice.toFixed(2)),
      retail_22k_inr_per_gram_estimate: estimateRetail22KFromSpot24K(
        Number(row.closePrice.toFixed(2)),
      ),
      source: row.source,
    }));
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
    price_basis: "spot_24k_inr_per_gram",
    display_basis_label: "24K spot INR/g",
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
  buildAnalytics,
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
  validateDailySummary,
};
