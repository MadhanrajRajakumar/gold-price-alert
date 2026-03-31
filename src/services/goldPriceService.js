const prisma = require("../lib/prisma");
const { logActivity, sendDecisionAlert } = require("./notificationService");
const { serializeUser, toLocalDateString } = require("./authService");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS = 30;
const PROVIDER_URL = "https://upstox.com/gold-rates/";
const PROVIDER_SOURCE = "upstox-scrape";
const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function startOfDay(date = new Date()) {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function parsePriceValue(text) {
  return Number(text.replace(/[^0-9.]/g, ""));
}

function parseHistoryDate(label, referenceDate = new Date()) {
  const normalized = label.trim();
  const dayFirstMatch = normalized.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);

  if (dayFirstMatch) {
    const day = Number(dayFirstMatch[1]);
    const month = MONTHS[dayFirstMatch[2].toLowerCase()];
    const year = Number(dayFirstMatch[3]);

    if (month === undefined || Number.isNaN(day) || Number.isNaN(year)) {
      return null;
    }

    return startOfDay(new Date(year, month, day));
  }

  return null;
}

function parseInputDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return startOfDay(parsed);
}

function serializePrice(entry) {
  return {
    id: entry.id,
    date: entry.date.toISOString(),
    price_per_gram: entry.price_per_gram,
    source: entry.source,
    manual_override: entry.manual_override,
  };
}

async function fetchProviderSnapshot(referenceDate = new Date()) {
  const response = await fetch(PROVIDER_URL, {
    headers: {
      "accept-language": "en-IN,en;q=0.9",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) gold-price-alert/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Provider request failed with status ${response.status}`);
  }

  const html = await response.text();
  const todayMatch = html.match(
    /22K Gold Rate in India[\s\S]{0,1600}?1 Gram<\/td>[\s\S]{0,220}?\u20B9\s*([\d,]+(?:\.\d+)?)/i,
  );

  if (!todayMatch) {
    throw new Error("Unable to parse today's 22K gold price");
  }

  const historySectionIndex = html.indexOf("Gold Rates Over Last 10 Days");
  const historySection =
    historySectionIndex === -1
      ? ""
      : html.slice(historySectionIndex, historySectionIndex + 9000);
  const history = [];
  const rowRegex =
    /<tr[^>]*>[\s\S]*?<td[^>]*>\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s*<\/td>[\s\S]*?<td[^>]*>\s*\u20B9\s*[\d,]+(?:\.\d+)?[\s\S]*?<\/td>[\s\S]*?<td[^>]*>\s*\u20B9\s*([\d,]+(?:\.\d+)?)[\s\S]*?<\/td>[\s\S]*?<\/tr>/gi;

  let match = rowRegex.exec(historySection);
  while (match) {
    const parsedDate = parseHistoryDate(match[1], referenceDate);

    if (parsedDate) {
      history.push({
        date: parsedDate,
        pricePerGram: Number((parsePriceValue(match[2]) / 10).toFixed(2)),
        source: PROVIDER_SOURCE,
        manualOverride: false,
      });
    }

    match = rowRegex.exec(historySection);
  }

  return {
    source: PROVIDER_SOURCE,
    sourceDetail: PROVIDER_URL,
    todayPricePerGram: parsePriceValue(todayMatch[1]),
    history,
  };
}

async function findLatestStoredPrice(userId, beforeDate) {
  return prisma.goldPrice.findFirst({
    where: {
      user_id: userId,
      ...(beforeDate
        ? {
            date: {
              lt: startOfDay(beforeDate),
            },
          }
        : {}),
    },
    orderBy: {
      date: "desc",
    },
  });
}

async function fetchLatestGoldPrice(userId, referenceDate = new Date()) {
  const date = startOfDay(referenceDate);

  try {
    const snapshot = await fetchProviderSnapshot(referenceDate);

    return {
      date,
      pricePerGram: snapshot.todayPricePerGram,
      source: snapshot.source,
      sourceDetail: snapshot.sourceDetail,
      history: snapshot.history,
      usedFallback: false,
    };
  } catch (providerError) {
    const lastKnown = await findLatestStoredPrice(userId, date);

    if (lastKnown) {
      return {
        date,
        pricePerGram: lastKnown.price_per_gram,
        source: `fallback:${lastKnown.source}`,
        sourceDetail: "database-last-known",
        history: [],
        usedFallback: true,
        fallbackReason: providerError.message,
      };
    }

    const envFallback = Number(process.env.FALLBACK_PRICE_PER_GRAM || 0);
    if (envFallback > 0) {
      return {
        date,
        pricePerGram: Number(envFallback.toFixed(2)),
        source: "fallback:env",
        sourceDetail: "FALLBACK_PRICE_PER_GRAM",
        history: [],
        usedFallback: true,
        fallbackReason: providerError.message,
      };
    }

    throw providerError;
  }
}

async function upsertGoldPrice({
  userId,
  date,
  pricePerGram,
  source,
  manualOverride = false,
}) {
  const normalizedDate = startOfDay(date);
  const existing = await prisma.goldPrice.findUnique({
    where: {
      user_id_date: {
        user_id: userId,
        date: normalizedDate,
      },
    },
  });

  if (existing?.manual_override && !manualOverride) {
    return existing;
  }

  return prisma.goldPrice.upsert({
    where: {
      user_id_date: {
        user_id: userId,
        date: normalizedDate,
      },
    },
    update: {
      price_per_gram: pricePerGram,
      source,
      manual_override: manualOverride,
    },
    create: {
      user_id: userId,
      date: normalizedDate,
      price_per_gram: pricePerGram,
      source,
      manual_override: manualOverride,
    },
  });
}

async function storeHistoricalPrices(userId, history = []) {
  for (const entry of history) {
    await upsertGoldPrice({
      userId,
      ...entry,
    });
  }
}

async function storeDailyGoldPrice(userId, referenceDate = new Date()) {
  const latest = await fetchLatestGoldPrice(userId, referenceDate);
  await storeHistoricalPrices(userId, latest.history);

  return upsertGoldPrice({
    userId,
    date: latest.date,
    pricePerGram: latest.pricePerGram,
    source: latest.source,
  });
}

async function getLast30DaysPrices(userId, referenceDate = new Date()) {
  const today = startOfDay(referenceDate);
  const startDate = new Date(today.getTime() - (THIRTY_DAYS - 1) * DAY_IN_MS);

  return prisma.goldPrice.findMany({
    where: {
      user_id: userId,
      date: {
        gte: startDate,
        lte: today,
      },
    },
    orderBy: {
      date: "asc",
    },
  });
}

async function getLowestPriceInLast30Days(userId, referenceDate = new Date()) {
  const prices = await getLast30DaysPrices(userId, referenceDate);

  if (!prices.length) {
    return null;
  }

  return prices.reduce((lowest, entry) =>
    entry.price_per_gram < lowest.price_per_gram ? entry : lowest,
  );
}

async function checkIfLowestToday(userId, referenceDate = new Date()) {
  const today = startOfDay(referenceDate);
  const prices = await getLast30DaysPrices(userId, today);
  const todayRecord = prices.find(
    (entry) => entry.date.getTime() === today.getTime(),
  );

  if (!todayRecord) {
    return false;
  }

  const lowestPrice = Math.min(...prices.map((entry) => entry.price_per_gram));
  return todayRecord.price_per_gram <= lowestPrice;
}

function calculateDecisionScore(todayPrice, lowestPrice) {
  if (!Number.isFinite(todayPrice) || !Number.isFinite(lowestPrice) || lowestPrice <= 0) {
    return 1;
  }

  const diffPercent = ((todayPrice - lowestPrice) / lowestPrice) * 100;
  const normalized = Math.min(Math.max(diffPercent, 0), 10) / 10;
  return Math.max(1, Math.min(10, Math.round(10 - normalized * 9)));
}

function getDecisionLabel({ score, paymentWindow }) {
  if (paymentWindow && paymentWindow.daysRemaining < 5) {
    return "PAY TODAY";
  }

  return score >= 8 ? "PAY TODAY" : "WAIT";
}

function getDecisionMessage(score) {
  return score >= 8 ? "Good time to pay" : "Wait";
}

function getPaymentWindow(lastPaymentDate, referenceDate = new Date()) {
  if (!lastPaymentDate) {
    return null;
  }

  const parsedDate = startOfDay(lastPaymentDate);
  const today = startOfDay(referenceDate);
  const daysElapsed = Math.max(
    0,
    Math.floor((today.getTime() - parsedDate.getTime()) / DAY_IN_MS),
  );
  const daysRemaining = Math.max(0, THIRTY_DAYS - daysElapsed);

  return {
    lastPaymentDate: toLocalDateString(parsedDate),
    daysElapsed,
    daysRemaining,
  };
}

async function updateUserPaymentDate(userId, value) {
  const parsedDate = parseInputDate(value);

  if (!parsedDate) {
    throw new Error("Last payment date must be in YYYY-MM-DD format");
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      last_payment_date: parsedDate,
    },
  });

  await logActivity(userId, "payment_date_updated", {
    last_payment_date: value,
  });

  return user;
}

async function updateTelegramChatId(userId, telegramChatId) {
  const normalizedChatId = String(telegramChatId || "").trim();

  if (!normalizedChatId) {
    throw new Error("Telegram chat ID is required");
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      telegram_chat_id: normalizedChatId,
    },
  });

  await logActivity(userId, "telegram_connected", {
    telegram_chat_id: normalizedChatId,
  });

  return user;
}

async function saveManualPrice(userId, pricePerGram, referenceDate = new Date()) {
  const normalizedPrice = Number(Number(pricePerGram).toFixed(2));

  if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) {
    throw new Error("Manual price must be a positive number");
  }

  const saved = await upsertGoldPrice({
    userId,
    date: referenceDate,
    pricePerGram: normalizedPrice,
    source: "manual",
    manualOverride: true,
  });

  await logActivity(userId, "manual_override_saved", {
    date: startOfDay(referenceDate).toISOString(),
    price_per_gram: normalizedPrice,
  });

  return saved;
}

async function getRecentActivity(userId, limit = 10) {
  return prisma.activityLog.findMany({
    where: { user_id: userId },
    orderBy: { created_at: "desc" },
    take: limit,
  });
}

async function getDashboardSummary(userId, referenceDate = new Date()) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  const todayRecord = await storeDailyGoldPrice(userId, referenceDate);
  const prices = await getLast30DaysPrices(userId, referenceDate);
  const isLowestToday = await checkIfLowestToday(userId, referenceDate);
  const lowestRecord =
    (await getLowestPriceInLast30Days(userId, referenceDate)) || todayRecord;
  const differenceAmount = Number(
    (todayRecord.price_per_gram - lowestRecord.price_per_gram).toFixed(2),
  );
  const differencePercent =
    lowestRecord.price_per_gram > 0
      ? Number(
          ((differenceAmount / lowestRecord.price_per_gram) * 100).toFixed(2),
        )
      : 0;
  const paymentWindow = getPaymentWindow(user.last_payment_date, referenceDate);
  const decisionScore = calculateDecisionScore(
    todayRecord.price_per_gram,
    lowestRecord.price_per_gram,
  );
  const decisionLabel = getDecisionLabel({
    score: decisionScore,
    paymentWindow,
  });
  const decisionMessage = getDecisionMessage(decisionScore);

  return {
    user: serializeUser(user),
    today: serializePrice(todayRecord),
    lowest: serializePrice(lowestRecord),
    difference: {
      amount: differenceAmount,
      percent: differencePercent,
    },
    missedOpportunity: {
      savingsAmount: Math.max(0, differenceAmount),
      message: `You could have saved INR ${Math.max(0, differenceAmount).toFixed(2)}`,
    },
    decision: {
      score: decisionScore,
      label: decisionLabel,
      message: decisionMessage,
    },
    prices: prices.map(serializePrice),
    isLowestToday,
    paymentWindow,
    message:
      decisionLabel === "PAY TODAY"
        ? "Pay now based on current price and your timeline"
        : "Wait for a better entry if your payment window allows",
  };
}

async function processAlerts(userId, referenceDate = new Date()) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  const summary = await getDashboardSummary(userId, referenceDate);
  const alertDate = startOfDay(referenceDate);
  const results = [];

  if (summary.isLowestToday) {
    results.push(
      await sendDecisionAlert({
        user,
        alertDate,
        condition: "lowest-price",
        subject: "Gold Price Alert: Today is the 30-day low",
        text: `Today's gold price is INR ${summary.today.price_per_gram} per gram, the lowest in the last 30 days. Decision: ${summary.decision.label}.`,
        details: {
          todayPrice: summary.today.price_per_gram,
          lowestPrice: summary.lowest.price_per_gram,
        },
      }),
    );
  }

  if (summary.paymentWindow && summary.paymentWindow.daysRemaining < 5) {
    results.push(
      await sendDecisionAlert({
        user,
        alertDate,
        condition: "payment-deadline",
        subject: "Gold Price Alert: Less than 5 days left to pay",
        text: `You have ${summary.paymentWindow.daysRemaining} day(s) remaining in your 30-day payment window. Current price is INR ${summary.today.price_per_gram} per gram. Decision: ${summary.decision.label}.`,
        details: {
          daysRemaining: summary.paymentWindow.daysRemaining,
          todayPrice: summary.today.price_per_gram,
        },
      }),
    );
  }

  return {
    summary,
    results,
  };
}

async function processAlertsForAllUsers(referenceDate = new Date()) {
  const users = await prisma.user.findMany({
    select: { id: true },
  });

  const results = [];
  for (const user of users) {
    results.push(await processAlerts(user.id, referenceDate));
  }

  return results;
}

module.exports = {
  calculateDecisionScore,
  fetchLatestGoldPrice,
  getDashboardSummary,
  getLast30DaysPrices,
  getRecentActivity,
  processAlerts,
  processAlertsForAllUsers,
  saveManualPrice,
  serializePrice,
  startOfDay,
  storeDailyGoldPrice,
  updateTelegramChatId,
  updateUserPaymentDate,
};
