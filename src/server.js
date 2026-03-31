require("dotenv").config();

const cors = require("cors");
const express = require("express");
const path = require("path");
const prisma = require("./lib/prisma");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/prices");
const { requireAuth } = require("./services/authService");
const { runDailyPriceJob, startScheduler } = require("./services/scheduler");

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/auth", authRoutes);
app.use("/api/me", requireAuth, userRoutes);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({
    error: error.message || "Internal server error",
  });
});

async function tableExists(tableName) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`,
  );
  return rows.length > 0;
}

async function getColumns(tableName) {
  if (!(await tableExists(tableName))) {
    return [];
  }

  return prisma.$queryRawUnsafe(`PRAGMA table_info("${tableName}")`);
}

async function backupIfLegacy(tableName, requiredColumn, backupName) {
  const columns = await getColumns(tableName);

  if (!columns.length) {
    return;
  }

  const hasRequiredColumn = columns.some((column) => column.name === requiredColumn);
  if (!hasRequiredColumn && !(await tableExists(backupName))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${tableName}" RENAME TO "${backupName}"`,
    );
  }
}

async function ensureDatabaseReady() {
  await backupIfLegacy("GoldPrice", "user_id", "GoldPriceLegacyBackup");
  await backupIfLegacy("AlertLog", "user_id", "AlertLogLegacyBackup");
  await backupIfLegacy("ActivityLog", "user_id", "ActivityLogLegacyBackup");

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "User" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "email" TEXT NOT NULL UNIQUE,
      "telegram_chat_id" TEXT,
      "last_payment_date" DATETIME,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Session" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "token" TEXT NOT NULL UNIQUE,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "expires_at" DATETIME NOT NULL,
      "user_id" INTEGER NOT NULL
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "GoldPrice" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "date" DATETIME NOT NULL,
      "price_per_gram" REAL NOT NULL,
      "source" TEXT NOT NULL DEFAULT 'system',
      "manual_override" BOOLEAN NOT NULL DEFAULT 0,
      "user_id" INTEGER NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "GoldPrice_user_id_date_key"
    ON "GoldPrice"("user_id", "date")
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AlertLog" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "alert_date" DATETIME NOT NULL,
      "condition" TEXT NOT NULL,
      "sent_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "status" TEXT NOT NULL,
      "details" TEXT,
      "user_id" INTEGER NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "AlertLog_user_id_alert_date_condition_key"
    ON "AlertLog"("user_id", "alert_date", "condition")
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ActivityLog" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "event_type" TEXT NOT NULL,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "details" TEXT NOT NULL,
      "user_id" INTEGER NOT NULL
    )
  `);
}

async function bootstrap() {
  await ensureDatabaseReady();
  await runDailyPriceJob();
  startScheduler();

  const server = app.listen(port, () => {
    console.log(`[gold-price-alert] Server running at http://localhost:${port}`);
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
