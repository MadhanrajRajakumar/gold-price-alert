const REQUIRED_ENV_VARS = ["DATABASE_URL", "DIRECT_URL", "GOLD_API_KEY"];

function isMissingOrPlaceholder(value) {
  if (!value || !value.trim()) {
    return true;
  }

  return /USERNAME|PASSWORD|HOST/.test(value);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }

  return String(value).trim().toLowerCase() === "true";
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) =>
    isMissingOrPlaceholder(process.env[key]),
  );

  if (missing.length) {
    const error = new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
    error.code = "INVALID_ENV";
    throw error;
  }

  return {
    nodeEnv: process.env.NODE_ENV || "development",
    port: Number(process.env.PORT || 3000),
    schedulerEnabled: parseBoolean(process.env.GOLD_API_SCHEDULER_ENABLED, true),
    autoCorrectDailySummary: parseBoolean(
      process.env.GOLD_API_AUTO_CORRECT_DAILY_SUMMARY,
      false,
    ),
    retailPremiumInrPerGram: parseNumber(
      process.env.GOLD_RETAIL_PREMIUM_INR_PER_GRAM,
      1200,
    ),
  };
}

module.exports = {
  parseBoolean,
  parseNumber,
  validateEnv,
};
