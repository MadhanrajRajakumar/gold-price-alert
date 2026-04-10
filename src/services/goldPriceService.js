const prisma = require("../lib/prisma");

const TROY_OUNCE_TO_GRAMS = 31.1035;
const LIVE_MIN_PRICE = 10000;
const LIVE_MAX_PRICE = 20000;

// -------------------- HELPERS --------------------

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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

// -------------------- VALIDATION --------------------

async function getScrapedChennaiPrice() {
  // NOT IMPLEMENTED YET → SAFE FAIL
  throw new Error("Scraper not implemented");
}

async function getValidatedPrice(apiPrice) {
  try {
    const scrapedPrice = await getScrapedChennaiPrice();

    const diff = Math.abs(apiPrice - scrapedPrice) / scrapedPrice;

    if (diff < 0.02) {
      return apiPrice;
    }

    return (apiPrice + scrapedPrice) / 2;
  } catch {
    return apiPrice;
  }
}

// -------------------- CORE ENGINE --------------------

async function fetchGoldAPI() {
  const endpoint = "https://api.gold-api.com/price/XAU/INR";

  const payload = await fetchJson(endpoint, {
    headers: { accept: "application/json" },
  });

  if (!payload || !payload.price) {
    throw new Error("Gold API failed");
  }

  const pricePerOunce = Number(payload.price);

  // 1️⃣ ounce → gram (24K)
  const pricePerGram24k = pricePerOunce / TROY_OUNCE_TO_GRAMS;

  // 2️⃣ 24K → 22K
  const price22k = pricePerGram24k * 0.916;

  // 3️⃣ India adjustments
  const importDuty = price22k * 0.125;
  const gst = (price22k + importDuty) * 0.03;
  const margin = price22k * 0.03;

  // 4️⃣ Final Chennai price
  const finalPriceRaw = price22k + importDuty + gst + margin;

  let validatedPrice;

  try {
    validatedPrice = await getValidatedPrice(finalPriceRaw);
  } catch {
    validatedPrice = finalPriceRaw;
  }

  const finalPrice = Number(validatedPrice.toFixed(2));

  const normalizedPrice = normalizeFetchedPricePerGram(finalPrice);

  const fetchedAt = payload.updatedAt || new Date().toISOString();

  // 🔥 DEBUG (keep this for now)
  console.log("PRICE DEBUG:", {
    ounce: pricePerOunce,
    gram24k: pricePerGram24k,
    price22k,
    importDuty,
    gst,
    margin,
    final: finalPrice,
  });

  return {
    status: "available",
    is_live_available: true,
    source: "gold-api",
    price_per_gram: normalizedPrice,
    fetched_at: fetchedAt,
    last_updated: fetchedAt,
    source_summary: {
      ounce_inr: pricePerOunce,
      gram_24k: Number(pricePerGram24k.toFixed(2)),
      price_22k: Number(price22k.toFixed(2)),
      import_duty: Number(importDuty.toFixed(2)),
      gst: Number(gst.toFixed(2)),
      margin: Number(margin.toFixed(2)),
      final_price: normalizedPrice,
    },
  };
}

// -------------------- MAIN ENTRY --------------------

async function fetchGoldPrice() {
  try {
    return await fetchGoldAPI();
  } catch (error) {
    console.error("Gold fetch failed:", error.message);

    return {
      status: "unavailable",
      is_live_available: false,
      live_error: error.message,
    };
  }
}

// -------------------- EXPORT (CRITICAL FIX) --------------------

module.exports = {
  fetchGoldPrice,
};