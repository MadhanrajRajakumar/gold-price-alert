const app = document.getElementById("app");

const state = {
  user: null,
  dashboard: null,
  alerts: [],
  nextTrigger: null,
  selectedRange: "1M",
  onboardingIndex: 0,
  chart: null,
  settingsOpen: false,
  flashMessage: "",
  flashType: "",
  authMessage: "",
  authType: "",
};

const onboardingScreens = [
  {
    screen: "PAIN",
    headline: "You’re probably overpaying for gold.",
    subtext: "Most people buy at the wrong time — and never realize it.",
    visualType: "chart-pain",
    cta: "Show me how"
  },
  {
    screen: "CONTROL",
    headline: "Know exactly when to buy.",
    subtext: "We track real prices, trends, and tell you when it’s the right time.",
    visualType: "chart-control",
    cta: "How does it work?"
  },
  {
    screen: "OUTCOME",
    headline: "Buy smarter. Save more.",
    subtext: "Get daily signals, confidence scores, and alerts before you pay.",
    visualType: "dashboard-preview",
    cta: "Get started"
  }
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }

  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function formatSignedCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }

  const numeric = Number(value);
  const sign = numeric > 0 ? "+" : numeric < 0 ? "-" : "";
  return `${sign}${formatCurrency(Math.abs(numeric))}`;
}

function formatDateLabel(isoDate) {
  if (!isoDate) {
    return "-";
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(isoDate));
}

function formatTimestamp(isoDate) {
  if (!isoDate) {
    return "";
  }

  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(isoDate));
}

function buildFlashHtml(message, type) {
  return `<p class="flash ${type || ""}">${escapeHtml(message || "")}</p>`;
}

function getRangeLabel(range) {
  const rangeLabels = {
    "1W": "1-week spot",
    "1M": "1-month spot",
    "3M": "3-month spot",
    "6M": "6-month spot",
    "1Y": "1-year spot",
  };
  return rangeLabels[range] || "spot";
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
    },
    ...options,
  });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || data.message || "Request failed");
    error.statusCode = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}

function destroyChart() {
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
}

function getDecisionPresentation(dashboard) {
  const label = dashboard?.decision?.decision || dashboard?.decision?.label || "WAIT";
  const confidence = dashboard?.decision?.confidence ?? 50;
  const lower = label.toLowerCase();
  const rawBuyType = dashboard?.decision?.decision_meta?.buy_type;
  let buyType = "";

  if (rawBuyType === "RECOVERY") buyType = "LATE BUY";
  else if (rawBuyType === "IDEAL") buyType = "LOWEST PRICE THIS CYCLE";
  else if (rawBuyType === "FORCED") buyType = "DEADLINE";

  let headline = "WAIT";
  let tone = "wait";
  if (lower.includes("buy") || lower.includes("pay")) {
    headline = "BUY";
    tone = "buy";
  }

  return {
    headline,
    tone,
    confidence,
    buyType,
  };
}

function getDecisionSupport(dashboard) {
  const guidance = getGuidanceModel(dashboard);
  return guidance.shortReason;
}

function getPredictionDirection(prediction) {
  if (!prediction) {
    return "";
  }

  const expected = Number(prediction.expected || 0);
  const min = Number(prediction.min || 0);
  const max = Number(prediction.max || 0);
  const midpoint = (min + max) / 2;
  const rangeSize = Math.abs(max - min);
  const drift = expected - midpoint;

  if (rangeSize <= Math.max(20, expected * 0.0025)) {
    return "Likely stable";
  }

  if (drift >= -5) {
    return "Likely stable to slightly higher";
  }

  return "Likely stable to slightly lower";
}

function normalizeRangeValue(range) {
  const normalized = String(range || "").trim();
  const lookup = {
    "1w": "1W",
    "1m": "1M",
    "3m": "3M",
    "6m": "6M",
    "1y": "1Y",
    "1W": "1W",
    "1M": "1M",
    "3M": "3M",
    "6M": "6M",
    "1Y": "1Y",
  };

  return lookup[normalized] || normalized || "1M";
}

function getNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getDisplayRangePosition(meta) {
  const displayRangePosition = getNumber(meta?.display_range_position);
  if (displayRangePosition !== null) {
    return Math.max(0, Math.min(1, displayRangePosition));
  }

  const rangePosition = getNumber(meta?.range_position);
  if (rangePosition !== null) {
    return Math.max(0, Math.min(1, rangePosition));
  }

  return null;
}

function getGuidanceTone(zoneLabel) {
  if (zoneLabel === "Excellent buying zone" || zoneLabel === "Good buying zone") {
    return "buy";
  }

  if (zoneLabel === "Wait for better entry" || zoneLabel === "Expensive zone") {
    return "wait";
  }

  return "hold";
}

function formatRangePlacement(rangePercent) {
  if (rangePercent === null) {
    return "Recent range";
  }

  if (rangePercent <= 33) {
    return `Lower ${rangePercent}% of range`;
  }

  if (rangePercent >= 67) {
    return `Upper ${100 - rangePercent}% from the top`;
  }

  return "Middle of range";
}

function getGuidanceModel(dashboard) {
  const live = dashboard?.live_price || {};
  const meta = dashboard?.decision?.decision_meta || {};
  const decision = getDecisionPresentation(dashboard);
  const confidence = Number(dashboard?.decision?.confidence ?? 0);
  const rangePosition = getDisplayRangePosition(meta);
  const prediction = meta?.prediction_3d;
  const predictionDirection = getPredictionDirection(prediction);
  const daysLeft = Number(meta?.days_left ?? dashboard?.paymentWindow?.daysLeft ?? 30);
  const livePrice = getNumber(
    live?.display_price_value ?? live?.primary_price_inr_per_gram,
  );
  const distanceFromLow = getNumber(meta?.distance_from_low);
  const isLiveAvailable =
    live?.is_live_available === true && livePrice !== null;

  if (!isLiveAvailable) {
    return {
      zoneLabel: "Check back soon",
      tone: "hold",
      confidence,
      shortReason: live?.live_error || "Live pricing is unavailable right now.",
      actionWindow: "Refresh price later today",
      actionButton: "Refresh price",
      actionType: "refresh",
      urgencyLabel: "Low urgency",
      summaryLabel: "Live price unavailable",
      chartInsight: "Historical trend is still available below.",
      whyItems: [
        "The latest live price could not be loaded.",
        "The chart still shows recent price direction.",
        "Refresh later before deciding to buy.",
      ],
    };
  }

  let zoneLabel = "Average zone";
  if (rangePosition !== null) {
    if (decision.headline === "BUY" && rangePosition <= 0.14) {
      zoneLabel = "Excellent buying zone";
    } else if (decision.headline === "BUY" || rangePosition <= 0.28) {
      zoneLabel = "Good buying zone";
    } else if (decision.headline === "WAIT" && rangePosition >= 0.76) {
      zoneLabel = "Wait for better entry";
    } else if (rangePosition >= 0.62) {
      zoneLabel = "Expensive zone";
    }
  } else if (decision.headline === "BUY") {
    zoneLabel = "Good buying zone";
  } else if (decision.headline === "WAIT") {
    zoneLabel = "Wait for better entry";
  }

  const tone = getGuidanceTone(zoneLabel);
  let shortReason = "Prices are sitting in the middle of the recent range.";
  let actionWindow = "Wait 2 to 3 days and recheck";
  let actionButton = "Set reminder";
  let actionType = "settings";

  if (zoneLabel === "Excellent buying zone") {
    shortReason =
      "Price is very close to the lower end of the monthly range and downside looks limited.";
    actionWindow =
      daysLeft > 0 && daysLeft <= 3
        ? `Buy within the next ${daysLeft} day${daysLeft === 1 ? "" : "s"}`
        : "Buy within 1 to 3 days";
    actionButton = "Mark when you buy";
    actionType = "mark-bought";
  } else if (zoneLabel === "Good buying zone") {
    shortReason =
      "Price is near the lower part of the monthly range, so waiting may not improve the price much.";
    actionWindow =
      daysLeft > 0 && daysLeft <= 5
        ? `Buy within the next ${daysLeft} day${daysLeft === 1 ? "" : "s"}`
        : "Buy within 3 to 5 days";
    actionButton = "Mark when you buy";
    actionType = "mark-bought";
  } else if (zoneLabel === "Average zone") {
    shortReason =
      "This is a fair zone, but there may still be room for a slightly better entry.";
    actionWindow = "Wait 2 to 3 days and recheck";
    actionButton = "Set reminder";
  } else if (zoneLabel === "Expensive zone") {
    shortReason =
      "Price is in the upper part of the recent range, so patience may help you avoid overpaying.";
    actionWindow = "Wait 3 to 5 days and recheck";
    actionButton = "Set reminder";
  } else if (zoneLabel === "Wait for better entry") {
    shortReason =
      "Price is still elevated compared with recent lows, so waiting is the safer move.";
    actionWindow = "Wait and recheck in 3 to 5 days";
    actionButton = "Set reminder";
  }

  if (decision.headline === "BUY" && predictionDirection.includes("lower")) {
    shortReason =
      "Price is still near the lower end of the range, and any near-term downside looks limited.";
  } else if (
    (zoneLabel === "Expensive zone" || zoneLabel === "Wait for better entry") &&
    predictionDirection.includes("higher")
  ) {
    shortReason =
      "Price is already elevated, and recent movement does not yet point to a better entry.";
  }

  const whyItems = [];
  if (rangePosition !== null) {
    if (rangePosition <= 0.2) {
      whyItems.push("Price is close to the lower end of the recent monthly range.");
    } else if (rangePosition >= 0.8) {
      whyItems.push("Price is close to the upper end of the recent monthly range.");
    } else {
      whyItems.push("Price is sitting around the middle of the recent monthly range.");
    }
  }

  if (predictionDirection) {
    if (predictionDirection.includes("lower")) {
      whyItems.push("Near-term movement still leaves room for a slightly lower price.");
    } else if (predictionDirection.includes("higher")) {
      whyItems.push("Recent movement suggests prices may hold steady or drift a little higher.");
    } else {
      whyItems.push("Recent movement looks stable rather than sharply moving in either direction.");
    }
  }

  if (daysLeft > 0 && daysLeft <= 5) {
    whyItems.push(
      `Your next buying window is already close, so delaying too long could reduce flexibility.`,
    );
  } else if (distanceFromLow !== null) {
    whyItems.push(
      `${formatCurrency(distanceFromLow)} separates today's signal price from the recent low.`,
    );
  }

  while (whyItems.length < 3) {
    whyItems.push("The recommendation is based on recent monthly range position and price behavior.");
  }

  const rangePercent =
    rangePosition === null ? null : Math.round(rangePosition * 100);

  return {
    zoneLabel,
    tone,
    confidence,
    shortReason,
    actionWindow,
    actionButton,
    actionType,
    urgencyLabel:
      tone === "buy"
        ? "Act soon"
        : tone === "wait"
          ? "Low urgency"
          : "Moderate urgency",
    summaryLabel: formatRangePlacement(rangePercent),
    chartInsight:
      rangePercent === null
        ? "Recent chart shows where prices have been moving."
        : `Current price sits in the lower ${rangePercent}% of the recent range.`,
    whyItems: whyItems.slice(0, 3),
  };
}

function getDaysLeftCard(paymentWindow, paymentWarning) {
  if (!paymentWindow) {
    return {
      value: "Start",
      meta: "Start your first buy cycle",
    };
  }

  if (paymentWindow.status === "never") {
    return {
      value: "Start",
      meta: "Start your first buy cycle",
    };
  }

  if (paymentWindow.status === "active") {
    const daysText = paymentWindow.daysLeft === 1 ? "day" : "days";
    return {
      value: String(paymentWindow.daysLeft),
      meta: `Next buy in ${paymentWindow.daysLeft} ${daysText}`,
    };
  }

  if (paymentWindow.status === "available") {
    return {
      value: "Ready",
      meta: "You can buy anytime now",
    };
  }

  // Default fallback
  return {
    value: "Not set",
    meta: paymentWarning || "Add your last payment date in settings",
  };
}

function renderLogin() {
  app.innerHTML = `
    <main class="screen auth-screen">
      <section class="card panel auth-card">
        <p class="eyebrow">Gold Price Alert</p>
        <div class="brand">
          <h1 class="title">Login with email</h1>
          <p class="subtitle">Minimal access to your buy signal and gold timing dashboard.</p>
        </div>
        <form id="loginForm" class="form-stack">
          <div class="field">
            <label for="loginEmail">Email</label>
            <input id="loginEmail" type="email" placeholder="you@example.com" required />
          </div>
          <button type="submit" class="primary-button">Continue</button>
        </form>
        ${buildFlashHtml(state.authMessage, state.authType)}
      </section>
    </main>
  `;

  document.getElementById("loginForm").addEventListener("submit", handleLoginSubmit);
}

function renderOnboarding() {
  const stepConfig = onboardingScreens[state.onboardingIndex];
  const isLast = state.onboardingIndex === onboardingScreens.length - 1;

  app.innerHTML = `
    <main class="screen onboarding-screen">
      <section class="card onboarding-card visual-card">
        <div class="onboarding-visual ${escapeHtml(stepConfig.visualType)}">
          <div class="visual-element"></div>
        </div>
        <div class="onboarding-content">
          <h1>${escapeHtml(stepConfig.headline)}</h1>
          <p class="subtitle">${escapeHtml(stepConfig.subtext)}</p>
        </div>
        <div class="onboarding-footer">
          <div class="progress-dots">
            ${onboardingScreens.map((_, i) => `<span class="${i === state.onboardingIndex ? 'active' : ''}"></span>`).join('')}
          </div>
          <button id="onboardingNext" type="button" class="primary-button full-width">${escapeHtml(stepConfig.cta)}</button>
        </div>
      </section>
    </main>
  `;

  const nextBtn = document.getElementById("onboardingNext");
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      if (isLast) {
        localStorage.setItem("onboardingComplete", "true");
        state.onboardingIndex = 0;
        renderApp();
      } else {
        state.onboardingIndex += 1;
        renderOnboarding();
      }
    });
  }
}

function getSettingsHtml(dashboard) {
  const user = dashboard?.user || {};
  const alerts = state.alerts || [];
  const nextAlertLabel = state.nextTrigger?.label || user.next_trigger_label || "";
  const telegramStatus = user.telegram_verified
    ? "Connected"
    : user.telegram_chat_id
      ? "Reconnect Telegram"
      : "Not connected";

  return `
    <div class="drawer-backdrop" id="settingsBackdrop">
      <aside class="card drawer" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="drawer-header">
          <div>
            <p class="eyebrow">Settings</p>
            <h2>Alerts and controls</h2>
          </div>
          <button id="closeSettings" type="button" class="ghost-button">Close</button>
        </div>

        <section class="drawer-section">
          <div class="row-between">
            <div>
              <p class="meta">Telegram</p>
              <strong>${escapeHtml(telegramStatus)}</strong>
            </div>
            <span class="badge ${user.telegram_verified ? "success" : "warning"}">${escapeHtml(
              nextAlertLabel || "Daily alerts at 9:00 AM",
            )}</span>
          </div>
          ${
            !user.telegram_verified
              ? `<a href="https://t.me/GoldPzbot?start=${user.id}" target="_blank" class="primary-button" style="display:block;text-align:center;text-decoration:none;margin-top:1rem;">Connect Telegram</a>`
              : `<p class="meta" style="margin-top:0.5rem">You are receiving alerts mapped to chat ID <strong>${escapeHtml(user.telegram_chat_id || "")}</strong>. You can chat with the bot anytime.</p>
                 <a href="https://t.me/GoldPzbot" target="_blank" class="ghost-button" style="display:block;text-align:center;text-decoration:none;margin-top:0.5rem;">Open Bot</a>`
          }
        </section>

        <section class="drawer-section">
          <form id="paymentDateForm" class="form-stack">
            <div class="field">
              <label for="paymentDateInput">Last payment date</label>
              <input
                id="paymentDateInput"
                type="date"
                value="${escapeHtml(dashboard?.paymentWindow?.lastPaymentDate || user.last_payment_date || "")}"
                required
              />
            </div>
            <button type="submit" class="ghost-button">Save payment date</button>
          </form>
        </section>

        <section class="drawer-section">
          <form id="alertSettingsForm" class="form-stack">
            <div class="field">
              <label for="alertTimeInput">Daily alert time</label>
              <input
                id="alertTimeInput"
                type="time"
                value="${escapeHtml(user.alert_time || "09:00")}"
                required
              />
            </div>
            <div class="field">
              <label for="analysisDaysInput">Analysis days (Trend window)</label>
              <input
                id="analysisDaysInput"
                type="number"
                min="7" max="365"
                value="${escapeHtml(user.analysis_days || 30)}"
                required
              />
            </div>
            <button type="submit" class="ghost-button">Save alert settings</button>
          </form>
        </section>

        <section class="drawer-section">
          <form id="cityForm" class="form-stack">
            <div class="field">
              <label for="cityInput">History city</label>
              <select id="cityInput">
                ${["Chennai", "Mumbai", "Delhi"]
                  .map(
                    (city) =>
                      `<option value="${city}" ${user.city === city ? "selected" : ""}>${city}</option>`,
                  )
                  .join("")}
              </select>
            </div>
            <button type="submit" class="ghost-button">Save city</button>
          </form>
        </section>

        <section class="drawer-section">
          <form id="manualPriceForm" class="form-stack">
            <div class="field">
              <label for="manualPriceInput">Manual price per gram</label>
              <input id="manualPriceInput" type="number" step="0.01" min="0" placeholder="13872" required />
            </div>
            <button type="submit" class="ghost-button">Save manual price</button>
          </form>
        </section>

        <section class="drawer-section">
          <div class="row-between">
            <div>
              <p class="meta">Recent alerts</p>
              <strong>History</strong>
            </div>
          </div>
          <ul class="list">
            ${
              alerts.length
                ? alerts
                    .slice(0, 6)
                    .map(
                      (item) =>
                        `<li>${escapeHtml(formatTimestamp(item.sent_at))}<br />${escapeHtml(item.message)}</li>`,
                    )
                    .join("")
                : "<li>No alerts sent yet.</li>"
            }
          </ul>
        </section>

        ${buildFlashHtml(state.flashMessage, state.flashType)}

        <button id="logoutButton" type="button" class="ghost-button">Logout</button>
      </aside>
    </div>
  `;
}

function buildDashboardHtml({
  dashboard,
  live,
  guidance,
  liveAvailable,
  priceLabel,
  chartInsight,
  rangePercent,
  daysLeft,
  secondaryPriceText,
  prediction,
  predictionDirection,
  signalBasis,
  displayBasis,
  dataPoints,
  lowDate,
  highDate,
}) {
  return `
    <main class="screen">
      <div class="shell">
        <header class="topbar">
          <div class="brand">
            <p class="eyebrow">Gold Price Alert</p>
            <h1 class="title">Should you buy today or wait?</h1>
            <p class="subtitle">${escapeHtml(
              liveAvailable
                ? `${dashboard.user.city} 22K guidance for ${dashboard.user.email}`
                : "Live pricing is offline, but recent trend history is still available.",
            )}</p>
          </div>
          <div class="topbar-actions">
            <button id="refreshPriceBtn" type="button" class="primary-button">Refresh Price</button>
            <button id="openSettings" type="button" class="ghost-button">Settings</button>
          </div>
        </header>

        <section class="card hero-card panel ${guidance.tone}">
          <div class="hero-layout">
            <div class="hero-copy">
              <p class="hero-kicker">Today's recommendation</p>
              <h2 class="hero-title">${escapeHtml(guidance.zoneLabel)}</h2>
              <div class="hero-price-block">
                <strong class="hero-price">${escapeHtml(
                  liveAvailable
                    ? formatCurrency(live.primary_price_inr_per_gram)
                    : live?.live_error || "Live data unavailable",
                )}</strong>
                <p class="hero-price-label">${escapeHtml(priceLabel)}</p>
              </div>
              <div class="hero-meta">
                <span class="confidence-pill">${escapeHtml(guidance.confidence)}% confidence</span>
                <span class="hero-update">${escapeHtml(
                  live.freshness_label || "Update time unavailable",
                )}</span>
              </div>
              <p class="hero-summary">${escapeHtml(guidance.shortReason)}</p>
              <div class="hero-action-row">
                <div class="action-window-box">
                  <span>Suggested action</span>
                  <strong>${escapeHtml(guidance.actionWindow)}</strong>
                </div>
                <button
                  id="primaryActionBtn"
                  type="button"
                  class="primary-button"
                  data-guidance-action="${escapeHtml(guidance.actionType)}"
                >
                  ${escapeHtml(guidance.actionButton)}
                </button>
              </div>
            </div>

            <div class="hero-aside">
              <div class="hero-aside-card">
                <span class="meta-label">Current view</span>
                <strong>${escapeHtml(guidance.summaryLabel)}</strong>
                <p>${escapeHtml(chartInsight)}</p>
              </div>
              <div class="hero-aside-card">
                <span class="meta-label">Buying window</span>
                <strong>${escapeHtml(guidance.urgencyLabel)}</strong>
                <p>${escapeHtml(daysLeft.meta)}</p>
              </div>
              ${
                secondaryPriceText
                  ? `<div class="hero-aside-card subtle">
                      <span class="meta-label">Reference price</span>
                      <strong>${escapeHtml(secondaryPriceText)}</strong>
                      <p>Used in the background for trend and signal tracking.</p>
                    </div>`
                  : ""
              }
            </div>
          </div>
        </section>

        <section class="info-grid">
          <article class="card panel info-card">
            <div class="section-heading">
              <p class="eyebrow">Why this call</p>
              <h3>Why the app says this</h3>
            </div>
            <ul class="explanation-list">
              ${guidance.whyItems
                .map((item) => `<li>${escapeHtml(item)}</li>`)
                .join("")}
            </ul>
          </article>

          <article class="card panel info-card action-card">
            <div class="section-heading">
              <p class="eyebrow">What to do next</p>
              <h3>${escapeHtml(guidance.actionWindow)}</h3>
            </div>
            <p class="action-summary">${escapeHtml(guidance.shortReason)}</p>
            <div class="action-chip-row">
              <span class="info-chip">${escapeHtml(guidance.confidence)}% confidence</span>
              <span class="info-chip">${escapeHtml(guidance.urgencyLabel)}</span>
            </div>
            <p class="meta">
              ${escapeHtml(
                live.delayed_message ||
                  "Use the chart below to confirm whether prices are sitting low or high right now.",
              )}
            </p>
          </article>
        </section>

        <section class="card chart-card">
          <div class="chart-header">
            <div>
              <p class="eyebrow">Recent trend</p>
              <h3>Are prices low right now?</h3>
              <p class="chart-support">${escapeHtml(chartInsight)}</p>
            </div>
            <div class="range-selector">
              ${["1W", "1M", "3M", "6M", "1Y"]
                .map(
                  (range) =>
                    `<button type="button" class="range-button ${
                      state.selectedRange === range ? "active" : ""
                    }" data-range="${range}">${range}</button>`,
                )
                .join("")}
            </div>
          </div>
          <div class="chart-wrap">
            <canvas id="goldChart" aria-label="Gold spot price chart"></canvas>
          </div>
          <div class="chart-legend">
            <span class="legend-item buy-zone">Lower price zone</span>
            <span class="legend-item current-zone">Current price</span>
            <span class="legend-item risk-zone">Higher price zone</span>
          </div>
          <p class="meta" id="chartMeta"></p>
        </section>

        <section class="advanced-section">
          <details class="card advanced-card">
            <summary>
              <div>
                <p class="eyebrow">Advanced details</p>
                <h3>Signal inputs and deeper context</h3>
              </div>
              <span class="summary-hint">Show details</span>
            </summary>

            <div class="advanced-grid">
              <article class="card stat-card panel">
                <p class="stat-label">${getRangeLabel(state.selectedRange)} low</p>
                <div class="stat-value">${escapeHtml(formatCurrency(dashboard.chart.lowest?.spot_24k_inr_per_gram))}</div>
                <p class="meta">${escapeHtml(lowDate)}</p>
              </article>

              <article class="card stat-card panel">
                <p class="stat-label">${getRangeLabel(state.selectedRange)} high</p>
                <div class="stat-value">${escapeHtml(formatCurrency(dashboard.chart.highest?.spot_24k_inr_per_gram))}</div>
                <p class="meta">${escapeHtml(highDate)}</p>
              </article>

              <article class="card stat-card panel">
                <p class="stat-label">Buy cycle</p>
                <div class="cycle-info">
                  ${
                    dashboard.paymentWindow?.lastPaymentDate
                      ? `<p class="info-line">Last purchased: ${escapeHtml(formatDateLabel(dashboard.paymentWindow.lastPaymentDate))}</p>`
                      : `<p class="info-line">Not yet purchased</p>`
                  }
                  ${
                    dashboard.paymentWindow?.nextCycleDate
                      ? `<p class="info-line">Next available: ${escapeHtml(formatDateLabel(dashboard.paymentWindow.nextCycleDate))}</p>`
                      : `<p class="info-line">Next available: Anytime</p>`
                  }
                  <p class="info-line">${escapeHtml(daysLeft.meta)}</p>
                </div>
                <button
                  id="markBoughtBtn"
                  type="button"
                  class="ghost-button full-width"
                  data-mark-bought="true"
                >
                  Mark as bought
                </button>
              </article>

              <article class="card stat-card panel">
                <p class="stat-label">3-day outlook</p>
                <div class="stat-value">${escapeHtml(
                  prediction?.expected ? formatCurrency(prediction.expected) : "-",
                )}</div>
                <p class="meta">${escapeHtml(
                  prediction
                    ? `${predictionDirection}. Range ${formatCurrency(prediction.min)} to ${formatCurrency(prediction.max)}.`
                    : "No short-term outlook available.",
                )}</p>
              </article>

              <article class="card stat-card panel technical-card">
                <p class="stat-label">Decision basis</p>
                <div class="technical-copy">
                  <p>Signal basis: ${escapeHtml(signalBasis)}</p>
                  <p>Display basis: ${escapeHtml(displayBasis)}</p>
                  <p>Data points reviewed: ${escapeHtml(String(dataPoints))}</p>
                  <p>Range position: ${escapeHtml(rangePercent === null ? "-" : `${rangePercent}%`)}</p>
                </div>
              </article>
            </div>
          </details>
        </section>

        <div class="mobile-sticky-bar">
          <button
            id="mobilePrimaryActionBtn"
            type="button"
            class="primary-button full-width"
            data-guidance-action="${escapeHtml(guidance.actionType)}"
          >
            ${escapeHtml(guidance.actionButton)}
          </button>
          <p class="mobile-sticky-note">${escapeHtml(guidance.actionWindow)}</p>
        </div>

        <section class="dashboard-footnote">
          <p class="meta">
            ${escapeHtml(
              live.live_error ||
                "The main recommendation uses recent signal history for timing while the headline shows today's Chennai 22K price.",
            )}
          </p>
        </section>

        ${buildFlashHtml(state.flashMessage, state.flashType)}
      </div>
      ${state.settingsOpen ? getSettingsHtml(dashboard) : ""}
    </main>
  `;
}

function renderDashboard() {
  const dashboard = state.dashboard;
  const live = dashboard.live_price || {};
  const guidance = getGuidanceModel(dashboard);
  const meta = dashboard?.decision?.decision_meta;
  const prediction = dashboard?.decision?.decision_meta?.prediction_3d;
  const predictionDirection = getPredictionDirection(prediction);
  const daysLeft = getDaysLeftCard(dashboard.paymentWindow, dashboard.paymentWarning);
  const liveAvailable = live?.is_live_available === true;
  const rangePosition = getDisplayRangePosition(meta);
  const rangePercent = rangePosition === null ? null : Math.round(rangePosition * 100);
  const signalBasis = meta?.signal_basis || "spot_24k_inr_per_gram";
  const displayBasis = meta?.display_basis || "retail_22k_inr_per_gram";
  const secondaryPriceText =
    liveAvailable && live.secondary_price_inr_per_gram
      ? `${live.secondary_price_label || "Spot 24K"} ${formatCurrency(live.secondary_price_inr_per_gram)}`
      : "";
  const priceLabel =
    live.primary_price_label || `${dashboard.user.city || "Chennai"} 22K`;
  const dataPoints = Number(meta?.data_points || dashboard.chart?.points?.length || 0);
  const lowDate = dashboard.chart.lowest ? formatDateLabel(dashboard.chart.lowest.date) : "No data";
  const highDate = dashboard.chart.highest ? formatDateLabel(dashboard.chart.highest.date) : "No data";
  const chartInsight =
    rangePercent === null
      ? guidance.chartInsight
      : rangePercent <= 50
        ? `Current price sits in the lower ${rangePercent}% of the recent range.`
        : `Current price sits in the upper ${100 - rangePercent}% of the recent range.`;

  app.innerHTML = buildDashboardHtml({
    dashboard,
    live,
    guidance,
    liveAvailable,
    priceLabel,
    chartInsight,
    rangePercent,
    daysLeft,
    secondaryPriceText,
    prediction,
    predictionDirection,
    signalBasis,
    displayBasis,
    dataPoints,
    lowDate,
    highDate,
  });

  attachDashboardEvents();
  renderChart();
  return;

  app.innerHTML = `
    <main class="screen">
      <div class="shell">
        <header class="topbar">
          <div class="brand">
            <p class="eyebrow">Gold Price Alert</p>
            <h1 class="title">Should you buy today?</h1>
            <p class="subtitle">${escapeHtml(
              liveAvailable
                ? `${dashboard.user.email} • ${dashboard.user.city} history`
                : "Historical trend is still available while live pricing is offline",
            )}</p>
          </div>
          <div class="row-between">
            <button id="refreshPriceBtn" type="button" class="primary-button">Refresh Price</button>
            <button id="openSettings" type="button" class="ghost-button">Settings</button>
          </div>
        </header>

        <section class="card panel">
          <div class="brand">
            <div class="headline-price">
              <strong>${escapeHtml(
                liveAvailable
                  ? formatCurrency(live.primary_price_inr_per_gram)
                  : live?.live_error || "Live data unavailable",
              )}</strong>
              <span class="change-pill ${priceMetrics.className}">${
                priceMetrics.delta === null
                  ? escapeHtml(priceMetrics.label)
                  : `${escapeHtml(formatSignedCurrency(priceMetrics.delta))} • ${escapeHtml(priceMetrics.label)}`
              }</span>
            </div>
            <div class="footer-note">
              ${
                secondaryPriceText
                  ? `<span class="meta">${escapeHtml(secondaryPriceText)}</span>`
                  : ""
              }
              ${
                live.freshness_label
                  ? `<span class="meta">${escapeHtml(live.freshness_label)}</span>`
                  : '<span class="meta">Last updated unavailable</span>'
              }
              ${
                live.primary_price_label
                  ? `<span class="badge">${escapeHtml(live.primary_price_label)}</span>`
                  : ""
              }
              ${
                live.delayed_message
                  ? `<span class="badge warning">${escapeHtml(live.delayed_message)}</span>`
                  : ""
              }
              ${
                live.live_error
                  ? `<span class="badge error">${escapeHtml(live.live_error)}</span>`
                  : ""
              }
            </div>
          </div>
        </section>

        <section class="card decision-card panel ${decision.tone}">
          <div class="decision-top">
            <div class="decision-main">
              <h2 class="decision-title">${escapeHtml(decision.headline)}</h2>
              ${
                decision.buyType
                  ? `<span class="decision-tag ${escapeHtml(decision.buyType.toLowerCase())}">${escapeHtml(decision.buyType)}</span>`
                  : ""
              }
            </div>
            <div class="confidence-ring">
              <span>${escapeHtml(strength)}</span>
              <small>${escapeHtml(confidence)}%</small>
            </div>
          </div>

          <div class="decision-body">
            <p class="decision-message ${isBuyDecision ? "buy-state" : "wait-state"}">
              ${escapeHtml(getDecisionSupport(dashboard))}
            </p>

            <div class="impact-box">
              <strong>${escapeHtml(formatCurrency(roundedDistanceFromLow))} above the 30-day spot low</strong>
            </div>
            <p class="loss-framing">${
              live.retail_price_is_modeled
                ? "Headline price is modeled from spot using a retail multiplier. Analytics still use 24K spot history."
                : "Headline price uses retail 22K. Analytics still use 24K spot history."
            }</p>

            ${
              prediction
                ? `<div class="prediction-box">
                    <div class="prediction-main">
                      <span>3-day ${escapeHtml(rangeContextLabel)} outlook</span>
                      <strong>
                        ${escapeHtml(formatCurrency(prediction.expected))}
                      </strong>
                    </div>

                    <div class="prediction-direction">
                      ${escapeHtml(predictionDirection)}
                      <div class="prediction-anchor">Derived from recent 24K spot movement</div>
                    </div>

                    <div class="prediction-range">
                      Range: ${escapeHtml(formatCurrency(prediction.min))} - ${escapeHtml(formatCurrency(prediction.max))}
                    </div>
                  </div>`
                : ""
            }

            <div class="decision-actions">
              <div class="premium-box">
                <span>🔒 Find the best day to buy</span>
                <strong>Avoid overpaying like today</strong>
              </div>
              
              <div class="action-box">
                <button class="primary-button full-width">
                  ${isBuyDecision ? "Use this signal" : "Set reminder to buy"}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section class="card chart-card">
          <div class="chart-header">
            <div>
              <p class="eyebrow">Trend</p>
              <h3>24K spot trend</h3>
            </div>
            <div class="range-selector">
              ${["1W", "1M", "3M", "6M", "1Y"]
                .map(
                  (range) =>
                    `<button type="button" class="range-button ${
                      state.selectedRange === range ? "active" : ""
                    }" data-range="${range}">${range}</button>`,
                )
                .join("")}
            </div>
          </div>
          <div class="chart-wrap">
            <canvas id="goldChart" aria-label="Gold spot price chart"></canvas>
          </div>
          <p class="meta" id="chartMeta"></p>
        </section>

        <section class="stats-grid">
          <article class="card stat-card panel">
            <p class="stat-label">${getRangeLabel(state.selectedRange)} low</p>
            <div class="stat-value">${escapeHtml(formatCurrency(dashboard.chart.lowest?.spot_24k_inr_per_gram))}</div>
            <p class="meta">${escapeHtml(
              dashboard.chart.lowest ? formatDateLabel(dashboard.chart.lowest.date) : "No data",
            )}</p>
          </article>

          <article class="card stat-card panel">
            <p class="stat-label">${getRangeLabel(state.selectedRange)} high</p>
            <div class="stat-value">${escapeHtml(formatCurrency(dashboard.chart.highest?.spot_24k_inr_per_gram))}</div>
            <p class="meta">${escapeHtml(
              dashboard.chart.highest ? formatDateLabel(dashboard.chart.highest.date) : "No data",
            )}</p>
          </article>

          <article class="card stat-card panel">
            <p class="stat-label">Days left</p>
            <div class="stat-value">${escapeHtml(daysLeft.value)}</div>
            <p class="meta">${escapeHtml(daysLeft.meta)}</p>
          </article>

          <article class="card stat-card panel">
            <p class="stat-label">Buy Cycle</p>
            <div class="cycle-info">
              ${dashboard.paymentWindow?.lastPaymentDate ? `<p class="info-line">Last purchased: ${escapeHtml(formatDateLabel(dashboard.paymentWindow.lastPaymentDate))}</p>` : `<p class="info-line">Not yet purchased</p>`}
              ${dashboard.paymentWindow?.nextCycleDate ? `<p class="info-line">Next available: ${escapeHtml(formatDateLabel(dashboard.paymentWindow.nextCycleDate))}</p>` : `<p class="info-line">Next available: Anytime</p>`}
            </div>
            <button id="markBoughtBtn" class="button button-primary" style="margin-top: 12px; width: 100%; cursor: pointer;">
              Mark as bought
            </button>
          </article>
        </section>

        ${buildFlashHtml(state.flashMessage, state.flashType)}
      </div>
      ${state.settingsOpen ? getSettingsHtml(dashboard) : ""}
    </main>
  `;

  attachDashboardEvents();
  renderChart();
}


function renderChart() {
  destroyChart();

  const canvas = document.getElementById("goldChart");
  const chartMeta = document.getElementById("chartMeta");
  if (!canvas || !state.dashboard?.chart?.points?.length) {
    if (chartMeta) {
      chartMeta.textContent = "No historical data yet.";
    }
    return;
  }

  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 0, 220);
  gradient.addColorStop(0, "rgba(212, 175, 55, 0.28)");
  gradient.addColorStop(1, "rgba(212, 175, 55, 0.02)");

  const points = state.dashboard.chart.points;
  const lowestDate = state.dashboard.chart.lowest?.date;
  const highestDate = state.dashboard.chart.highest?.date;
  const todayDate = state.dashboard.chart.today?.date;
  const values = points
    .map((point) => Number(point.spot_24k_inr_per_gram))
    .filter((value) => Number.isFinite(value));
  const minValue = values.length ? Math.min(...values) : null;
  const maxValue = values.length ? Math.max(...values) : null;
  const rangeSize =
    minValue === null || maxValue === null ? null : Math.max(1, maxValue - minValue);
  const zonePlugin = {
    id: "rangeZones",
    beforeDatasetsDraw(chart) {
      if (minValue === null || maxValue === null) {
        return;
      }

      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales?.y) {
        return;
      }

      const lowerBandEnd = minValue + rangeSize * 0.25;
      const upperBandStart = maxValue - rangeSize * 0.2;
      const lowerY = scales.y.getPixelForValue(lowerBandEnd);
      const upperY = scales.y.getPixelForValue(upperBandStart);

      ctx.save();
      ctx.fillStyle = "rgba(34, 197, 94, 0.08)";
      ctx.fillRect(chartArea.left, lowerY, chartArea.right - chartArea.left, chartArea.bottom - lowerY);
      ctx.fillStyle = "rgba(239, 68, 68, 0.08)";
      ctx.fillRect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, upperY - chartArea.top);
      ctx.restore();
    },
  };

  state.chart = new Chart(context, {
    type: "line",
    plugins: [zonePlugin],
    data: {
      labels: points.map((point) => formatDateLabel(point.date)),
      datasets: [
        {
          data: points.map((point) => Number(point.spot_24k_inr_per_gram)),
          borderColor: "#D4AF37",
          backgroundColor: gradient,
          tension: 0.4,
          fill: true,
          borderWidth: 3,
          pointRadius(contextInfo) {
            const point = points[contextInfo.dataIndex];
            if (!point) {
              return 0;
            }

            if (point.date === todayDate) {
              return 5;
            }

            if (point.date === lowestDate || point.date === highestDate) {
              return 4;
            }

            return 0;
          },
          pointBackgroundColor(contextInfo) {
            const point = points[contextInfo.dataIndex];
            if (!point) {
              return "#D4AF37";
            }

            if (point.date === lowestDate) {
              return "#22C55E";
            }
            if (point.date === highestDate) {
              return "#EF4444";
            }
            if (point.date === todayDate) {
              return "#F8FAFC";
            }
            return "#D4AF37";
          },
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          enabled: true,
          backgroundColor: "#121826",
          borderColor: "rgba(212, 175, 55, 0.22)",
          borderWidth: 1,
          titleColor: "#E5E7EB",
          bodyColor: "#E5E7EB",
          callbacks: {
            label(contextInfo) {
              return `₹ ${contextInfo.parsed.y.toLocaleString("en-IN")}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#9CA3AF",
            maxRotation: 0,
          },
          grid: {
            display: false,
          },
        },
        y: {
          ticks: {
            color: "#9CA3AF",
            callback(value) {
              return `₹${Number(value).toLocaleString("en-IN")}`;
            },
          },
          grid: {
            color: "rgba(156, 163, 175, 0.08)",
          },
        },
      },
    },
  });

  if (chartMeta) {
    chartMeta.textContent = `Low ${formatCurrency(
      state.dashboard.chart.lowest?.spot_24k_inr_per_gram,
    )} - High ${formatCurrency(state.dashboard.chart.highest?.spot_24k_inr_per_gram)} - Trend view uses recent spot history`;
  }
}

function attachDashboardEvents() {
  const refresh = document.getElementById("refreshPriceBtn");
  if (refresh) {
    refresh.addEventListener("click", refreshPrice);
  }

  document.querySelectorAll("[data-mark-bought='true']").forEach((button) => {
    button.addEventListener("click", markAsBought);
  });

  document.querySelectorAll("[data-guidance-action]").forEach((button) => {
    button.addEventListener("click", handleGuidanceAction);
  });

  const openSettings = document.getElementById("openSettings");
  if (openSettings) {
    openSettings.addEventListener("click", () => {
      state.settingsOpen = true;
      renderApp();
    });
  }

  document.querySelectorAll(".range-button").forEach((button) => {
    button.addEventListener("click", async () => {
      const range = button.dataset.range;
      if (range && range !== state.selectedRange) {
        state.selectedRange = range;
        await loadTrend(range);
      }
    });
  });

  if (!state.settingsOpen) {
    return;
  }

  const closeSettings = document.getElementById("closeSettings");
  if (closeSettings) {
    closeSettings.addEventListener("click", () => {
      state.settingsOpen = false;
      renderApp();
    });
  }

  const backdrop = document.getElementById("settingsBackdrop");
  if (backdrop) {
    backdrop.addEventListener("click", (event) => {
      if (event.target.id === "settingsBackdrop") {
        state.settingsOpen = false;
        renderApp();
      }
    });
  }

  document.getElementById("alertSettingsForm")?.addEventListener("submit", handleAlertSettingsSubmit);
  document.getElementById("paymentDateForm")?.addEventListener("submit", handlePaymentDateSubmit);
  document.getElementById("cityForm")?.addEventListener("submit", handleCitySubmit);
  document.getElementById("manualPriceForm")?.addEventListener("submit", handleManualPriceSubmit);
  document.getElementById("logoutButton")?.addEventListener("click", handleLogout);
}

function handleGuidanceAction(event) {
  const action = event.currentTarget?.dataset?.guidanceAction;

  if (action === "mark-bought") {
    markAsBought();
    return;
  }

  if (action === "refresh") {
    refreshPrice();
    return;
  }

  state.settingsOpen = true;
  renderApp();
}

function renderApp() {
  destroyChart();

  if (!localStorage.getItem("onboardingComplete")) {
    renderOnboarding();
    return;
  }

  if (!state.user || !state.user.email) {
    renderLogin();
    return;
  }

  renderDashboard();
}

async function loadTrend(range) {
  try {
    const trend = await requestJson(`/api/me/trends?range=${encodeURIComponent(range)}`);
    state.dashboard.chart = trend;
    state.selectedRange = normalizeRangeValue(trend.range || range);
    renderApp();
  } catch (error) {
    state.flashMessage = error.message;
    state.flashType = "error";
    renderApp();
  }
}

async function loadDashboard(range = state.selectedRange) {
  const [dashboard, alerts, nextTrigger] = await Promise.all([
    requestJson(`/api/me/dashboard?range=${encodeURIComponent(range)}`),
    requestJson("/api/alerts"),
    requestJson("/api/next-trigger"),
  ]);

  state.dashboard = dashboard;
  state.alerts = alerts;
  state.nextTrigger = nextTrigger;
  state.user = dashboard.user;
  state.selectedRange = normalizeRangeValue(dashboard.chart?.range || range);
}

async function initApp() {
  state.flashMessage = "";
  state.flashType = "";

  if (!localStorage.getItem("onboardingComplete")) {
    renderApp();
    return;
  }

  try {
    const auth = await requestJson("/api/auth/me");
    state.user = auth.user;

    await loadDashboard(state.selectedRange);
    renderApp();
  } catch (error) {
    destroyChart();
    if (error.statusCode === 401) {
      state.user = null;
      renderApp();
      return;
    }

    state.authMessage = error.message;
    state.authType = "error";
    state.user = null;
    renderApp();
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  state.authMessage = "";
  state.authType = "";

  try {
    const email = document.getElementById("loginEmail").value;
    await requestJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    state.onboardingIndex = 0;
    await initApp();
  } catch (error) {
    state.authMessage = error.message;
    state.authType = "error";
    renderApp();
  }
}


async function refreshPrice() {
  const button = document.getElementById("refreshPriceBtn");
  if (!button) {
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Refreshing...";

  try {
    const response = await requestJson("/api/refresh-price", {
      method: "POST",
    });

    if (!response.success) {
      throw new Error(response.error || "Failed to refresh price");
    }

    state.flashMessage = `Price refreshed in ${response.response_time_ms} ms.`;
    state.flashType = "success";
    await loadDashboard(state.selectedRange);
    renderApp();
  } catch (error) {
    console.error("REFRESH ERROR:", error);
    state.flashMessage = error.message || "Live data unavailable";
    state.flashType = "error";
    if (state.dashboard?.live_price) {
      state.dashboard.live_price = {
        ...state.dashboard.live_price,
        is_live_available: false,
        live_error: error.message,
      };
    }
    renderApp();
  } finally {
    const nextButton = document.getElementById("refreshPriceBtn");
    if (nextButton) {
      nextButton.disabled = false;
      nextButton.textContent = originalText;
    }
  }
}

async function markAsBought() {
  const buttons = Array.from(
    document.querySelectorAll(
      "[data-mark-bought='true'], [data-guidance-action='mark-bought']",
    ),
  );
  if (!buttons.length) {
    return;
  }

  const originalLabels = buttons.map((button) => button.textContent);
  buttons.forEach((button) => {
    button.disabled = true;
    button.textContent = "Recording...";
  });

  try {
    const response = await requestJson("/api/mark-bought", {
      method: "POST",
    });

    if (!response.success) {
      throw new Error(response.error || "Failed to record purchase");
    }

    state.flashMessage = "Purchase recorded! Next cycle: " + response.nextCycleDate;
    state.flashType = "success";
    await loadDashboard(state.selectedRange);
    renderApp();
  } catch (error) {
    console.error("MARK BOUGHT ERROR:", error);
    state.flashMessage = error.message || "Failed to record purchase";
    state.flashType = "error";
    renderApp();
  } finally {
    Array.from(
      document.querySelectorAll(
        "[data-mark-bought='true'], [data-guidance-action='mark-bought']",
      ),
    ).forEach((button, index) => {
      button.disabled = false;
      button.textContent = originalLabels[index] || "Mark as bought";
    });
  }
}

async function handlePaymentDateSubmit(event) {
  event.preventDefault();

  try {
    await requestJson("/api/me/payment-date", {
      method: "POST",
      body: JSON.stringify({
        last_payment_date: document.getElementById("paymentDateInput").value,
      }),
    });
    state.flashMessage = "Payment date saved.";
    state.flashType = "success";
    await loadDashboard(state.selectedRange);
    renderApp();
  } catch (error) {
    state.flashMessage = error.message;
    state.flashType = "error";
    renderApp();
  }
}

async function handleCitySubmit(event) {
  event.preventDefault();

  try {
    await requestJson("/api/me/city", {
      method: "POST",
      body: JSON.stringify({
        city: document.getElementById("cityInput").value,
      }),
    });
    state.flashMessage = "City saved.";
    state.flashType = "success";
    await loadDashboard(state.selectedRange);
    renderApp();
  } catch (error) {
    state.flashMessage = error.message;
    state.flashType = "error";
    renderApp();
  }
}

async function handleAlertSettingsSubmit(event) {
  event.preventDefault();

  try {
    await requestJson("/api/me/alert-settings", {
      method: "POST",
      body: JSON.stringify({
        alert_time: document.getElementById("alertTimeInput").value,
        analysis_days: Number(document.getElementById("analysisDaysInput").value),
      }),
    });
    state.flashMessage = "Alert settings saved.";
    state.flashType = "success";
    await loadDashboard(state.selectedRange);
    renderApp();
  } catch (error) {
    state.flashMessage = error.message;
    state.flashType = "error";
    renderApp();
  }
}

async function handleManualPriceSubmit(event) {
  event.preventDefault();

  try {
    await requestJson("/api/me/manual-price", {
      method: "POST",
      body: JSON.stringify({
        price_per_gram: Number(document.getElementById("manualPriceInput").value),
      }),
    });
    state.flashMessage = "Manual price saved.";
    state.flashType = "success";
    await loadDashboard(state.selectedRange);
    renderApp();
  } catch (error) {
    state.flashMessage = error.message;
    state.flashType = "error";
    renderApp();
  }
}

async function handleLogout() {
  await requestJson("/api/auth/logout", {
    method: "POST",
  });
  state.user = null;
  state.dashboard = null;
  state.alerts = [];
  state.nextTrigger = null;
  state.settingsOpen = false;
  state.flashMessage = "";
  state.flashType = "";
  renderApp();
}

initApp();
