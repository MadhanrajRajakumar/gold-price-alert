const REQUIRED_ENV_VARS = ["DATABASE_URL", "DIRECT_URL"];

function isMissingOrPlaceholder(value) {
  if (!value || !value.trim()) {
    return true;
  }

  return /USERNAME|PASSWORD|HOST/.test(value);
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
  };
}

module.exports = {
  validateEnv,
};
