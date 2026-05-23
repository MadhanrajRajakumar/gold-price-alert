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

function parseUrl(value, envName) {
  try {
    return new URL(value);
  } catch {
    const error = new Error(
      `${envName} is not a valid URL. Check the connection string copied from Supabase.`,
    );
    error.code = "INVALID_ENV";
    throw error;
  }
}

function getSupabaseProjectRefFromDatabaseUrl(url) {
  if (url.hostname.endsWith(".pooler.supabase.com")) {
    const match = /^.+\.([a-z0-9]{20})$/i.exec(url.username);
    return match ? match[1] : null;
  }

  if (url.hostname.startsWith("db.") && url.hostname.endsWith(".supabase.co")) {
    return url.hostname.split(".")[1] || null;
  }

  return null;
}

function validateDatabaseUrls() {
  const databaseUrl = parseUrl(process.env.DATABASE_URL, "DATABASE_URL");
  const directUrl = parseUrl(process.env.DIRECT_URL, "DIRECT_URL");

  if (directUrl.hostname.endsWith(".pooler.supabase.com")) {
    const error = new Error(
      "DIRECT_URL must use the direct Supabase host (`db.<project-ref>.supabase.co:5432`), not the pooler host. Open Supabase > Connect and copy the Direct connection string for DIRECT_URL.",
    );
    error.code = "INVALID_ENV";
    throw error;
  }

  const pooledProjectRef = getSupabaseProjectRefFromDatabaseUrl(databaseUrl);
  const directProjectRef = getSupabaseProjectRefFromDatabaseUrl(directUrl);

  if (
    pooledProjectRef &&
    directProjectRef &&
    pooledProjectRef !== directProjectRef
  ) {
    const error = new Error(
      `DATABASE_URL and DIRECT_URL point to different Supabase projects (${pooledProjectRef} vs ${directProjectRef}). Copy both URLs from the same project's Connect screen.`,
    );
    error.code = "INVALID_ENV";
    throw error;
  }
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

  validateDatabaseUrls();

  return {
    nodeEnv: process.env.NODE_ENV || "development",
    port: Number(process.env.PORT || 3000),
    schedulerEnabled: parseBoolean(process.env.GOLD_API_SCHEDULER_ENABLED, true),
    autoCorrectDailySummary: parseBoolean(
      process.env.GOLD_API_AUTO_CORRECT_DAILY_SUMMARY,
      false,
    ),
    retailSpotMultiplier: parseNumber(
      process.env.GOLD_RETAIL_SPOT_MULTIPLIER,
      1.155,
    ),
  };
}

module.exports = {
  parseBoolean,
  parseNumber,
  validateEnv,
};
