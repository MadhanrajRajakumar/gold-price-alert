require('dotenv').config();

const express = require('express');
const cors = require('cors');

const path = require("path");
const prisma = require("./lib/prisma");
const authRoutes = require("./routes/auth");
const alertRoutes = require("./routes/alerts");
const userRoutes = require("./routes/prices");
const { validateEnv } = require("./config/env");
const { requireAuth } = require("./services/authService");
const { startScheduler } = require("./services/scheduler");
const { startTelegramListener } = require("./services/telegramService");

const app = express();
const env = validateEnv();
const port = env.port;

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

async function connectDatabase() {
  try {
    await prisma.$connect();
    console.log("[gold-price-alert] Database connection established");
  } catch (error) {
    console.error("[gold-price-alert] Database connection failed:", error);
    throw error;
  }
}

async function bootstrap() {
  await connectDatabase();
  startScheduler();
  startTelegramListener();

  const server = app.listen(port, () => {
    console.log(`[gold-price-alert] Server running on port ${port}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch(async (error) => {
  console.error("[gold-price-alert] Failed to start:", error);
  await prisma.$disconnect();
  process.exit(1);
});


console.log("TOKEN CHECK:", process.env.TELEGRAM_BOT_TOKEN);