const { loadEnv } = require("../config/loadEnv");
loadEnv();

const prisma = require("../lib/prisma");
const { validateEnv } = require("../config/env");
const {
  backfillHistory,
  ensureMarketDataConsistency,
} = require("../services/marketDataService");

async function main() {
  validateEnv();

  await prisma.$connect();

  const today = new Date();

  const oneYearAgo = new Date(today);
  oneYearAgo.setUTCDate(oneYearAgo.getUTCDate() - 365);

  const result = await backfillHistory({
    startDate: oneYearAgo,
    endDate: today,
    force: false,
  });

  const consistency = await ensureMarketDataConsistency(today);

  console.log(
    JSON.stringify(
      {
        result,
        consistency,
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);

  try {
    await prisma.$disconnect();
  } catch {}

  process.exit(1);
});