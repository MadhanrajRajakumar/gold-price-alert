const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeConfidenceScore,
  getBuySignal,
  getMissingDatesBetween,
  normalizeRange,
  serializeDailySummary,
} = require("./marketDataService");

test("normalizes frontend 6M range to canonical backend range", () => {
  assert.equal(normalizeRange("6M"), "6M");
  assert.equal(normalizeRange("6m"), "6M");
});

test("serializes daily summary with chart-compatible price fields", () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:test@db.example.supabase.co:5432/postgres";
  process.env.DIRECT_URL = process.env.DIRECT_URL || "postgresql://postgres:test@db.example.supabase.co:5432/postgres";
  process.env.GOLD_API_KEY = process.env.GOLD_API_KEY || "test-key";
  process.env.GOLD_RETAIL_SPOT_MULTIPLIER =
    process.env.GOLD_RETAIL_SPOT_MULTIPLIER || "1.155";

  const row = {
    date: new Date("2026-05-23T00:00:00.000Z"),
    openPrice: 13900.12,
    highPrice: 14010.34,
    lowPrice: 13850.56,
    closePrice: 13940.78,
    source: "aggregation",
    validatedAt: null,
    validationStatus: "validated",
  };

  const point = serializeDailySummary(row);

  assert.equal(point.price_basis, "spot_24k_inr_per_gram");
  assert.equal(point.signal_price_basis, "spot_24k_inr_per_gram");
  assert.equal(point.display_price_basis, "retail_22k_inr_per_gram");
  assert.equal(point.spot_24k_inr_per_gram, 13940.78);
  assert.equal(point.signal_price_value, 13940.78);
  assert.equal(point.display_price_value, point.retail_22k_inr_per_gram);
  assert.equal(point.retail_price_is_modeled, true);
});

test("detects missing calendar days between latest stored date and today", () => {
  const missingDates = getMissingDatesBetween(
    new Date("2026-05-27T00:00:00.000Z"),
    new Date("2026-05-31T10:00:00.000Z"),
  );

  assert.deepEqual(
    missingDates.map((date) => date.toISOString().slice(0, 10)),
    ["2026-05-28", "2026-05-29", "2026-05-30", "2026-05-31"],
  );
});

test("buy signal matches the 30-day threshold rules", () => {
  assert.equal(getBuySignal(101, 100, 120), "BUY");
  assert.equal(getBuySignal(118, 100, 120), "WAIT");
  assert.equal(getBuySignal(109, 100, 120), "HOLD");
});

test("confidence is derived from coverage, validation, and signal strength", () => {
  const strongBuy = computeConfidenceScore({
    coverageRatio: 1,
    validationRatio: 1,
    rangePosition: 0.05,
    signal: "BUY",
  });
  const weakHold = computeConfidenceScore({
    coverageRatio: 0.4,
    validationRatio: 0.2,
    rangePosition: 0.5,
    signal: "HOLD",
  });

  assert.equal(Number.isInteger(strongBuy), true);
  assert.equal(strongBuy > weakHold, true);
  assert.equal(strongBuy <= 96, true);
  assert.equal(weakHold >= 35, true);
});
