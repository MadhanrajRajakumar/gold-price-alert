const { loadEnv } = require("../config/loadEnv");
loadEnv();

const prisma = require("../lib/prisma");
const { validateEnv } = require("../config/env");
const { backfillHistory } = require("../services/marketDataService");

async function main() {
  validateEnv();
  await prisma.$connect();

  const result = await backfillHistory({
    force: process.argv.includes("--force"),
  });

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch(async (error) => {
    console.error("[gold-price-alert] Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
