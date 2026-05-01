const test = require("node:test");
const assert = require("node:assert/strict");

const {
  estimateRetail22KFromSpot24K,
  normalizeApiTimestamp,
  spotPerOunceToInrPerGram,
} = require("./goldApiClient");

test("converts XAU/INR ounce price into INR per gram", () => {
  const spot24kInrPerGram = spotPerOunceToInrPerGram(433672.2876);

  assert.equal(spot24kInrPerGram, 13942.88);
});

test("converts history-style ounce values with exchange rate into INR per gram", () => {
  const spot24kInrPerGram = spotPerOunceToInrPerGram(4635.7002, 94.9786);

  assert.equal(spot24kInrPerGram, 14155.72);
});

test("estimates retail 22K price from 24K spot with flat premium", () => {
  const retail22kEstimate = estimateRetail22KFromSpot24K(13942.54, 1200);

  assert.equal(retail22kEstimate, 13980.66);
});

test("parses day-based history timestamps", () => {
  const timestamp = normalizeApiTimestamp("2026-05-01 00:00:00");

  assert.equal(timestamp.toISOString(), "2026-05-01T00:00:00.000Z");
});
