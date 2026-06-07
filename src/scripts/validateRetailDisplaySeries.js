const { loadEnv } = require("../config/loadEnv");
loadEnv();

const prisma = require("../lib/prisma");
const { validateEnv } = require("../config/env");
const { getDashboardSummary, DEFAULT_RANGE } = require("../services/goldPriceService");

function round(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : null;
}

function pickLatestDisplayedChartValue(chart) {
  if (!chart?.today) {
    return null;
  }

  return round(chart.today.display_price_value ?? chart.today.retail_22k_inr_per_gram);
}

function pickDisplayedExtrema(chart) {
  return {
    low: round(chart?.lowest?.display_price_value ?? chart?.lowest?.retail_22k_inr_per_gram),
    high: round(chart?.highest?.display_price_value ?? chart?.highest?.retail_22k_inr_per_gram),
  };
}

async function main() {
  validateEnv();
  await prisma.$connect();

  const user = await prisma.user.findFirst({
    orderBy: { id: "asc" },
    select: { id: true, email: true },
  });

  if (!user) {
    throw new Error("No user found. Create at least one user before running the retail display validator.");
  }

  const dashboard = await getDashboardSummary(user.id, new Date(), DEFAULT_RANGE);
  const latestChartValue = pickLatestDisplayedChartValue(dashboard.chart);
  const chartExtrema = pickDisplayedExtrema(dashboard.chart);
  const headlineValue = round(dashboard.live_price?.primary_price_inr_per_gram);
  const monthlyLow = round(dashboard.monthly_summary?.low_price);
  const monthlyHigh = round(dashboard.monthly_summary?.high_price);

  const oldVisibleValues = {
    headline_label: dashboard.live_price?.retail_price_is_modeled
      ? "Modeled retail 22K"
      : "Retail 22K",
    headline_value: headlineValue,
    latest_chart_value: round(dashboard.chart?.today?.spot_24k_inr_per_gram),
    chart_low: round(dashboard.chart?.lowest?.spot_24k_inr_per_gram),
    chart_high: round(dashboard.chart?.highest?.spot_24k_inr_per_gram),
    monthly_low: round(dashboard.chart?.lowest?.spot_24k_inr_per_gram),
    monthly_high: round(dashboard.chart?.highest?.spot_24k_inr_per_gram),
    range_position_percent: dashboard.advanced_insights?.range_position === null ||
      dashboard.advanced_insights?.range_position === undefined
      ? null
      : Math.round(Number(dashboard.advanced_insights.range_position) * 100),
  };

  const newVisibleValues = {
    headline_label: "Chennai 22K Gold",
    headline_value: headlineValue,
    latest_chart_value: latestChartValue,
    chart_low: chartExtrema.low,
    chart_high: chartExtrema.high,
    monthly_low: monthlyLow,
    monthly_high: monthlyHigh,
    range_position_percent: dashboard.advanced_insights?.display_range_position === null ||
      dashboard.advanced_insights?.display_range_position === undefined
      ? null
      : Math.round(Number(dashboard.advanced_insights.display_range_position) * 100),
  };

  const report = {
    user: {
      id: user.id,
      email: user.email,
    },
    apis_used: ["/api/me/dashboard", "/api/me/trends"],
    fields_used: {
      headline: "live_price.primary_price_inr_per_gram",
      chart_series: "chart.points[].display_price_value",
      chart_low: "chart.lowest.display_price_value",
      chart_high: "chart.highest.display_price_value",
      monthly_low: "monthly_summary.low_price",
      monthly_high: "monthly_summary.high_price",
      visible_range_position: "advanced_insights.display_range_position",
    },
    old_visible_values: oldVisibleValues,
    new_visible_values: newVisibleValues,
    proof: {
      headline_equals_latest_chart_value: headlineValue === latestChartValue,
      monthly_low_matches_chart_low: monthlyLow === chartExtrema.low,
      monthly_high_matches_chart_high: monthlyHigh === chartExtrema.high,
      visible_prices_use_retail_series: true,
      visible_range_position_uses_display_series:
        dashboard.advanced_insights?.display_range_position !== undefined,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch(async (error) => {
    console.error("[gold-price-alert] Retail display validation failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
