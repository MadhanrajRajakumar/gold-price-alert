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

function getPriceChangeMetrics(dashboard) {
  const livePrice = dashboard?.live_price?.price_per_gram;
  const points = dashboard?.chart?.points || [];
  if (!livePrice || !points.length) {
    return {
      delta: null,
      label: "Historical chart available",
      className: "",
    };
  }

  const average =
    points.reduce((sum, point) => sum + Number(point.price_per_gram || 0), 0) / points.length;
  const delta = Number(livePrice) - average;
  const className = delta < 0 ? "positive" : delta > 0 ? "negative" : "";
  const label =
    delta < 0
      ? "Below 30-day average"
      : delta > 0
        ? "Above 30-day average"
        : "At 30-day average";

  return { delta, label, className };
}

function getDecisionPresentation(dashboard) {
  const label = dashboard?.decision?.decision || dashboard?.decision?.label || "WAIT";
  const confidence = dashboard?.decision?.confidence ?? 50;
  const lower = label.toLowerCase();

  let headline = "WAIT";
  let tone = "wait";
  if (lower.includes("pay")) {
    headline = "BUY";
    tone = "buy";
  } else if (lower.includes("overdue")) {
    headline = "ACT NOW";
    tone = "overdue";
  }

  return {
    headline,
    tone,
    confidence,
  };
}

function getDecisionSupport(dashboard) {
  const live = dashboard?.live_price;
  const hasLivePrice = Boolean(live?.price_per_gram);
  const { delta, label } = getPriceChangeMetrics(dashboard);

  if (!hasLivePrice) {
    return live?.live_error || "Live data unavailable";
  }

  if (delta === null) {
    return "Price trend unavailable";
  }

  return `${label} by ${formatSignedCurrency(delta)}.`;
}

function getDaysLeftCard(paymentWindow, paymentWarning) {
  if (!paymentWindow) {
    return {
      value: "Not set",
      meta: paymentWarning || "Add your last payment date in settings",
    };
  }

  if (paymentWindow.isOverdue) {
    return {
      value: "Overdue",
      meta: `Due ${formatDateLabel(paymentWindow.nextDueDate)}`,
    };
  }

  return {
    value: String(paymentWindow.daysLeft),
    meta: `Due ${formatDateLabel(paymentWindow.nextDueDate)}`,
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

function renderDashboard() {
  const dashboard = state.dashboard;
  const live = dashboard.live_price || {};
  const priceMetrics = getPriceChangeMetrics(dashboard);
  const decision = getDecisionPresentation(dashboard);
  const daysLeft = getDaysLeftCard(dashboard.paymentWindow, dashboard.paymentWarning);
  const liveAvailable = live?.is_live_available === true;

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
                  ? formatCurrency(live.price_per_gram)
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
                live.freshness_label
                  ? `<span class="meta">${escapeHtml(live.freshness_label)}</span>`
                  : '<span class="meta">Last updated unavailable</span>'
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
          <p class="eyebrow">Decision</p>
          <h2>${escapeHtml(decision.headline)}</h2>
          <div class="decision-support">
            <strong>Confidence: ${decision.confidence}%</strong>
            <p class="subtitle">${escapeHtml(getDecisionSupport(dashboard))}</p>
            <p class="meta">${escapeHtml(dashboard.decision.message || dashboard.message || "")}</p>
          </div>
        </section>

        <section class="card chart-card">
          <div class="chart-header">
            <div>
              <p class="eyebrow">Trend</p>
              <h3>30-day price context</h3>
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
            <canvas id="goldChart" aria-label="Gold price chart"></canvas>
          </div>
          <p class="meta" id="chartMeta"></p>
        </section>

        <section class="stats-grid">
          <article class="card stat-card panel">
            <p class="stat-label">30-day low</p>
            <div class="stat-value">${escapeHtml(formatCurrency(dashboard.chart.lowest?.price_per_gram))}</div>
            <p class="meta">${escapeHtml(
              dashboard.chart.lowest ? formatDateLabel(dashboard.chart.lowest.date) : "No data",
            )}</p>
          </article>

          <article class="card stat-card panel">
            <p class="stat-label">30-day high</p>
            <div class="stat-value">${escapeHtml(formatCurrency(dashboard.chart.highest?.price_per_gram))}</div>
            <p class="meta">${escapeHtml(
              dashboard.chart.highest ? formatDateLabel(dashboard.chart.highest.date) : "No data",
            )}</p>
          </article>

          <article class="card stat-card panel">
            <p class="stat-label">Days left</p>
            <div class="stat-value">${escapeHtml(daysLeft.value)}</div>
            <p class="meta">${escapeHtml(daysLeft.meta)}</p>
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

  state.chart = new Chart(context, {
    type: "line",
    data: {
      labels: points.map((point) => formatDateLabel(point.date)),
      datasets: [
        {
          data: points.map((point) => Number(point.price_per_gram)),
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

            if (point.date === lowestDate || point.date === highestDate || point.date === todayDate) {
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
      state.dashboard.chart.lowest?.price_per_gram,
    )} • High ${formatCurrency(state.dashboard.chart.highest?.price_per_gram)}`;
  }
}

function attachDashboardEvents() {
  const refresh = document.getElementById("refreshPriceBtn");
  if (refresh) {
    refresh.addEventListener("click", refreshPrice);
  }

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
    state.selectedRange = trend.range || range;
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
  state.selectedRange = dashboard.chart?.range || range;
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
