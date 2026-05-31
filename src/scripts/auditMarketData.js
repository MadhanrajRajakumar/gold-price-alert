const { loadEnv } = require("../config/loadEnv");
loadEnv();

const prisma = require("../lib/prisma");
const { validateEnv } = require("../config/env");
const { generateMarketDataAuditReport } = require("../services/marketDataService");

async function main() {
  validateEnv();
  await prisma.$connect();

  const report = await generateMarketDataAuditReport();
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch(async (error) => {
    console.error("[gold-price-alert] Market-data audit failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
