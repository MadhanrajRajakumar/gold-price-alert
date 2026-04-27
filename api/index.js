if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require('express');
const cors = require('cors');
const path = require("path");
const authRoutes = require("../src/routes/auth");
const alertRoutes = require("../src/routes/alerts");
const userRoutes = require("../src/routes/prices");
const { validateEnv } = require("../src/config/env");
const { requireAuth } = require("../src/services/authService");

// NOTE: This must run in a separate worker (Railway/Render/local)
// const { startScheduler } = require("../src/services/scheduler");
// const { startTelegramListener } = require("../src/services/telegramService");

const app = express();
validateEnv();

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/auth", authRoutes);
app.use("/api", requireAuth, alertRoutes);
app.use("/api/me", requireAuth, userRoutes);

app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

app.use((error, _req, res, _next) => {
  console.error("[gold-price-alert] Critical request failure:", error);
  res.status(error.statusCode || 500).json({
    error: error.message || "Internal server error",
  });
});

module.exports = app;
