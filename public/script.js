let dashboardState = null;
let chartInstance = null;
let selectedRange = "1M";
let onboardingIndex = 0;

function formatCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }

  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDateLabel(isoDate) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(isoDate));
}

function formatTimestamp(isoDate) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(isoDate));
}

function setFlashMessage(message, type = "", targetId = "flashMessage") {
  const flash = document.getElementById(targetId);
  if (!flash) {
    return;
  }

  flash.textContent = message || "";
  flash.className = `flash-message ${type}`.trim();
}

function hideAllViews() {
  document.getElementById("authView").classList.add("hidden");
  document.getElementById("onboardingView").classList.add("hidden");
  document.getElementById("appView").classList.add("hidden");
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

function showAuthView() {
  hideAllViews();
  document.getElementById("authView").classList.remove("hidden");
}

function showOnboardingView() {
  hideAllViews();
  document.getElementById("onboardingView").classList.remove("hidden");
}

function showAppView() {
  hideAllViews();
  document.getElementById("appView").classList.remove("hidden");
}

function renderAlertHistory(items) {
  const list = document.getElementById("activityList");

  if (!items.length) {
    list.innerHTML = "<li>No alerts sent yet.</li>";
    return;
  }

  list.innerHTML = items
    .map(
      (item) =>
        `<li>${formatTimestamp(item.sent_at)} | ${item.type} | ${item.message}</li>`,
    )
    .join("");
}

function renderTelegramStatus(user) {
  const status = document.getElementById("telegramStatus");
  const button = document.getElementById("telegramConnectButton");

  if (user.telegram_verified) {
    status.textContent = "Connected";
    button.textContent = "Reconnect Telegram";
  } else if (user.telegram_chat_id) {
    status.textContent = "Not connected - Reconnect Telegram";
    button.textContent = "Reconnect Telegram";
  } else {
    status.textContent = "Not connected";
    button.textContent = "Connect Telegram";
  }
}

function renderOnboarding(onboarding) {
  const screens = onboarding?.screens || [];
  if (!screens.length) {
    showAppView();
    return;
  }

  document.getElementById("onboardingStep").textContent = `Screen ${
    onboardingIndex + 1
  } of ${screens.length}`;
  document.getElementById("onboardingMessage").textContent =
    screens[onboardingIndex];

  const isLast = onboardingIndex === screens.length - 1;
  document.getElementById("onboardingBackBtn").disabled = onboardingIndex === 0;
  document.getElementById("onboardingNextBtn").classList.toggle("hidden", isLast);
  document.getElementById("startBtn").classList.toggle("hidden", !isLast);
}

function destroyChart() {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
}

function renderChart(chartData) {
  const canvas = document.getElementById("goldChart");
  const context = canvas.getContext("2d");
  const points = chartData?.points || [];
  const chartMeta = document.getElementById("chartMeta");

  destroyChart();

  if (!points.length) {
    chartMeta.textContent = "No historical data yet.";
    return;
  }

  chartInstance = new Chart(context, {
    type: "line",
    data: {
      labels: points.map((point) => formatDateLabel(point.date)),
      datasets: [
        {
          data: points.map((point) => point.price_per_gram),
          borderColor: "#6C4DD9",
          tension: 0.4,
          fill: true,
          backgroundColor: "rgba(108,77,217,0.1)",
          pointRadius: 0,
          borderWidth: 3,
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
          callbacks: {
            label(context) {
              return `₹ ${context.parsed.y}`;
            },
          },
        },
      },
    },
  });

  chartMeta.textContent = `Range ${chartData.range} | ${points.length} points | Lowest ${formatCurrency(
    chartData.lowest?.price_per_gram,
  )} | Highest ${formatCurrency(chartData.highest?.price_per_gram)}`;
}

function setActiveRange(range) {
  selectedRange = range;
  document.querySelectorAll(".range-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === range);
  });
}

function renderLivePrice(live) {
  document.getElementById("todayPrice").textContent = live.is_live_available
    ? formatCurrency(live.price_per_gram)
    : "LIVE DATA UNAVAILABLE";
  document.getElementById("sourceList").textContent = live.is_live_available
    ? `Source: ${live.source}`
    : "Historical data remains available";
  document.getElementById("priceFreshnessBadge").textContent =
    live.freshness_label || "";
  document.getElementById("priceWarningBadge").textContent =
    live.live_error || live.delayed_message || "";
  document.getElementById("priceWarningBadge").className = `flash-message ${
    live.live_error ? "error" : live.delayed_message ? "success" : ""
  }`.trim();
}

function renderDashboard(data, nextTrigger) {
  dashboardState = data;

  const decisionHero = document.getElementById("decisionHero");
  const isPayToday = data.decision.label === "PAY TODAY";
  decisionHero.classList.toggle("pay", isPayToday);

  document.getElementById("userMeta").textContent = `${data.user.email} | ${data.user.city} history | national live rate`;
  document.getElementById("nextAlertMeta").textContent =
    nextTrigger?.label || data.user.next_trigger_label || "";
  document.getElementById("decisionLabel").textContent = data.decision.label;
  document.getElementById("decisionMessage").textContent = `${data.decision.message}. ${data.message}`;
  document.getElementById("decisionScore").textContent =
    data.decision.score === null || data.decision.score === undefined
      ? "N/A"
      : `${data.decision.score}/10`;

  renderLivePrice(data.live_price);

  document.getElementById("lowestPrice").textContent = formatCurrency(
    data.chart.lowest?.price_per_gram,
  );
  document.getElementById("lowestDate").textContent = data.chart.lowest
    ? `Recorded on ${formatDateLabel(data.chart.lowest.date)}`
    : "No low available";

  document.getElementById("highestPrice").textContent = formatCurrency(
    data.chart.highest?.price_per_gram,
  );
  document.getElementById("highestDate").textContent = data.chart.highest
    ? `Recorded on ${formatDateLabel(data.chart.highest.date)}`
    : "No high available";

  if (data.paymentWindow) {
    document.getElementById("daysRemaining").textContent = data.paymentWindow.isOverdue
      ? "Payment overdue"
      : `Days left: ${data.paymentWindow.daysLeft}`;
    document.getElementById("paymentMeta").textContent = `Next payment due: ${formatDateLabel(
      data.paymentWindow.nextDueDate,
    )} | Last payment: ${formatDateLabel(data.paymentWindow.lastPaymentDate)}`;
    document.getElementById("paymentDateInput").value =
      data.paymentWindow.lastPaymentDate;
  } else {
    document.getElementById("daysRemaining").textContent = "Not set";
    document.getElementById("paymentMeta").textContent =
      data.paymentWarning || "Add your last payment date below";
    document.getElementById("paymentDateInput").value =
      data.user.last_payment_date || "";
  }

  document.getElementById("telegramChatIdInput").value =
    data.user.telegram_chat_id || "";
  document.getElementById("cityInput").value = data.user.city || "Chennai";
  document.getElementById("telegramNextTrigger").textContent =
    nextTrigger?.label || data.user.next_trigger_label || "";

  renderTelegramStatus(data.user);
  setActiveRange(data.chart.range || selectedRange);
  renderChart(data.chart);
}

async function loadTrend(range) {
  const trend = await requestJson(`/api/me/trends?range=${encodeURIComponent(range)}`);
  if (!dashboardState) {
    return;
  }

  dashboardState.chart = trend;
  setActiveRange(trend.range);
  renderChart(trend);
}

async function loadDashboard(range = selectedRange) {
  const [dashboard, alerts, nextTrigger] = await Promise.all([
    requestJson(`/api/me/dashboard?range=${encodeURIComponent(range)}`),
    requestJson("/api/alerts"),
    requestJson("/api/next-trigger"),
  ]);

  renderDashboard(dashboard, nextTrigger);
  renderAlertHistory(alerts);
  showAppView();
}

async function bootstrapApp() {
  try {
    const auth = await requestJson("/api/auth/me");

    if (!auth.user.onboardingCompleted) {
      dashboardState = {
        onboarding: {
          screens: [
            "You are overpaying gold every month",
            "Gold price changes daily - you miss the lowest",
            "We track and tell you when to pay",
            "Start saving money",
          ],
        },
      };
      onboardingIndex = 0;
      renderOnboarding(dashboardState.onboarding);
      showOnboardingView();
      return;
    }

    await loadDashboard();
  } catch (error) {
    if (error.statusCode === 401) {
      showAuthView();
      return;
    }

    setFlashMessage(error.message, "error", "authMessage");
  }
}

async function refreshPrice() {
  const button = document.getElementById("refreshPriceBtn");
  const originalText = button.innerText;

  button.disabled = true;
  button.innerText = "Refreshing...";

  try {
    const data = await requestJson("/api/refresh-price", {
      method: "POST",
    });

    if (!data.success) {
      setFlashMessage(data.error || "Failed to refresh price", "error");
      return;
    }

    renderLivePrice({
      is_live_available: true,
      price_per_gram: data.price,
      source: data.source,
      fetched_at: data.fetched_at,
      freshness_label: data.freshness_label,
      delayed_message: data.delayed_message || null,
      live_error: null,
    });
    setFlashMessage(`Gold price refreshed in ${data.response_time_ms} ms.`, "success");
    await loadDashboard(selectedRange);
  } catch (error) {
    if (dashboardState?.live_price) {
      renderLivePrice({
        ...dashboardState.live_price,
        is_live_available: false,
        live_error: error.message || "Live data unavailable",
      });
    }
    setFlashMessage(error.message || "Error refreshing price", "error");
  } finally {
    button.disabled = false;
    button.innerText = originalText;
  }
}

document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await requestJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("loginEmail").value,
      }),
    });
    document.getElementById("loginEmail").value = "";
    setFlashMessage("", "", "authMessage");
    await bootstrapApp();
  } catch (error) {
    setFlashMessage(error.message, "error", "authMessage");
  }
});

document
  .getElementById("manualPriceForm")
  .addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await requestJson("/api/me/manual-price", {
        method: "POST",
        body: JSON.stringify({
          price_per_gram: Number(
            document.getElementById("manualPriceInput").value,
          ),
        }),
      });
      document.getElementById("manualPriceInput").value = "";
      setFlashMessage("Manual price saved.", "success");
      await loadDashboard(selectedRange);
    } catch (error) {
      setFlashMessage(error.message, "error");
    }
  });

document
  .getElementById("paymentDateForm")
  .addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await requestJson("/api/me/payment-date", {
        method: "POST",
        body: JSON.stringify({
          last_payment_date: document.getElementById("paymentDateInput").value,
        }),
      });
      setFlashMessage("Payment date saved.", "success");
      await loadDashboard(selectedRange);
    } catch (error) {
      setFlashMessage(error.message, "error");
    }
  });

document.getElementById("cityForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await requestJson("/api/me/city", {
      method: "POST",
      body: JSON.stringify({
        city: document.getElementById("cityInput").value,
      }),
    });
    setFlashMessage("City saved.", "success");
    await loadDashboard(selectedRange);
  } catch (error) {
    setFlashMessage(error.message, "error");
  }
});

document.getElementById("telegramForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await requestJson("/api/telegram/connect", {
      method: "POST",
      body: JSON.stringify({
        telegram_chat_id: document.getElementById("telegramChatIdInput").value,
      }),
    });
    setFlashMessage("Telegram connected successfully.", "success");
    await loadDashboard(selectedRange);
  } catch (error) {
    setFlashMessage(error.message, "error");
    document.getElementById("telegramStatus").textContent =
      "Not connected - Reconnect Telegram";
    document.getElementById("telegramConnectButton").textContent =
      "Reconnect Telegram";
  }
});

document.getElementById("refreshPriceBtn").addEventListener("click", refreshPrice);

document.querySelectorAll(".range-button").forEach((button) => {
  button.addEventListener("click", async () => {
    const range = button.dataset.range;
    setActiveRange(range);
    await loadTrend(range);
  });
});

document.getElementById("onboardingBackBtn").addEventListener("click", () => {
  const screens = dashboardState?.onboarding?.screens || [];
  if (!screens.length || onboardingIndex === 0) {
    return;
  }

  onboardingIndex -= 1;
  renderOnboarding(dashboardState.onboarding);
});

document.getElementById("onboardingNextBtn").addEventListener("click", () => {
  const screens = dashboardState?.onboarding?.screens || [];
  if (!screens.length || onboardingIndex >= screens.length - 1) {
    return;
  }

  onboardingIndex += 1;
  renderOnboarding(dashboardState.onboarding);
});

document.getElementById("startBtn").onclick = async () => {
  try {
    await requestJson("/api/onboarding/complete", {
      method: "POST",
    });
    window.location.reload();
  } catch (error) {
    setFlashMessage(error.message, "error", "authMessage");
  }
};

document.getElementById("logoutButton").addEventListener("click", async () => {
  await requestJson("/api/auth/logout", {
    method: "POST",
  });
  destroyChart();
  showAuthView();
});

bootstrapApp();
