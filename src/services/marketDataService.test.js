const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
