function formatCurrency(value) {
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
  }).format(new Date(isoDate));
}

function setFlashMessage(message, type = "", targetId = "flashMessage") {
  const flash = document.getElementById(targetId);
  flash.textContent = message || "";
  flash.className = `flash-message ${type}`.trim();
}

function drawChart(prices) {
  const chart = document.getElementById("priceChart");
  const labels = document.getElementById("chartLabels");
  const width = 760;
  const height = 240;
  const padding = 24;

  if (!prices.length) {
    chart.innerHTML = "";
    labels.textContent = "No recent price data yet.";
    return;
  }

  const values = prices.map((item) => item.price_per_gram);
  const minPrice = Math.min(...values);
  const maxPrice = Math.max(...values);
  const span = maxPrice - minPrice || 1;
  const stepX =
    prices.length === 1 ? 0 : (width - padding * 2) / (prices.length - 1);

  const points = prices.map((item, index) => {
    const x = padding + index * stepX;
    const y =
      height -
      padding -
      ((item.price_per_gram - minPrice) / span) * (height - padding * 2);
    return `${x},${y}`;
  });

  const areaPoints = [
    `${padding},${height - padding}`,
    ...points,
    `${padding + stepX * (prices.length - 1)},${height - padding}`,
  ].join(" ");

  chart.innerHTML = `
    <rect x="0" y="0" width="${width}" height="${height}" rx="14" fill="#fafbf8"></rect>
    <polygon points="${areaPoints}" fill="rgba(205, 163, 73, 0.18)"></polygon>
    <polyline points="${points.join(" ")}" fill="none" stroke="#cda349" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
    ${prices
      .map((item, index) => {
        const [x, y] = points[index].split(",");
        return `<circle cx="${x}" cy="${y}" r="4" fill="${
          item.manual_override ? "#166534" : "#18202a"
        }"></circle>`;
      })
      .join("")}
  `;

  labels.innerHTML = `
    <span>${formatDateLabel(prices[0].date)}</span>
    <span>Low ${formatCurrency(minPrice)}</span>
    <span>High ${formatCurrency(maxPrice)}</span>
    <span>${formatDateLabel(prices[prices.length - 1].date)}</span>
  `;
}

function renderActivity(items) {
  const list = document.getElementById("activityList");

  if (!items.length) {
    list.innerHTML = "<li>No alerts or overrides logged yet.</li>";
    return;
  }

  list.innerHTML = items
    .map((item) => {
      let details = item.event_type;

      if (item.event_type === "manual_override_saved") {
        details = `Manual override saved at ${formatCurrency(
          item.details.price_per_gram,
        )}`;
      } else if (item.event_type === "alert_sent") {
        details = `Alert sent for ${item.details.condition} via ${(
          item.details.channelsSent || []
        ).join(", ")}`;
      } else if (item.event_type === "alert_skipped") {
        details = `Alert skipped for ${item.details.condition}`;
      } else if (item.event_type === "telegram_connected") {
        details = "Telegram chat ID connected";
      } else if (item.event_type === "payment_date_updated") {
        details = `Payment date updated to ${item.details.last_payment_date}`;
      }

      return `<li>${new Date(item.created_at).toLocaleString("en-IN")} | ${details}</li>`;
    })
    .join("");
}

function renderDashboard(data) {
  const decisionHero = document.getElementById("decisionHero");
  const isPayToday = data.decision.label === "PAY TODAY";
  decisionHero.classList.toggle("pay", isPayToday);

  document.getElementById("userMeta").textContent = `${data.user.email} | Telegram ${
    data.user.telegram_connected ? "connected" : "not connected"
  }`;
  document.getElementById("decisionLabel").textContent = data.decision.label;
  document.getElementById(
    "decisionMessage",
  ).textContent = `${data.decision.message}. ${data.message}`;
  document.getElementById("decisionScore").textContent = `${data.decision.score}/10`;

  document.getElementById("todayPrice").textContent = formatCurrency(
    data.today.price_per_gram,
  );
  document.getElementById("todayMeta").textContent = `${new Date(
    data.today.date,
  ).toDateString()} | ${data.today.source}${
    data.today.manual_override ? " | manual override" : ""
  }`;

  document.getElementById("lowestPrice").textContent = formatCurrency(
    data.lowest.price_per_gram,
  );
  document.getElementById("lowestDate").textContent = `Recorded on ${new Date(
    data.lowest.date,
  ).toDateString()}`;

  document.getElementById("missedSavings").textContent = formatCurrency(
    data.missedOpportunity.savingsAmount,
  );
  document.getElementById(
    "differenceMeta",
  ).textContent = `${data.missedOpportunity.message} | ${data.difference.percent.toFixed(
    2,
  )}% above low`;

  if (data.paymentWindow) {
    document.getElementById("daysRemaining").textContent = `${data.paymentWindow.daysRemaining} days left`;
    document.getElementById(
      "paymentMeta",
    ).textContent = `Last payment: ${data.paymentWindow.lastPaymentDate} | ${data.paymentWindow.daysElapsed} days elapsed`;
    document.getElementById("paymentDateInput").value =
      data.paymentWindow.lastPaymentDate;
  } else {
    document.getElementById("daysRemaining").textContent = "Not set";
    document.getElementById("paymentMeta").textContent =
      "Add your last payment date below";
    document.getElementById("paymentDateInput").value = "";
  }

  document.getElementById("telegramChatIdInput").value =
    data.user.telegram_chat_id || "";

  drawChart(data.prices);
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
    const error = new Error(data.error || "Request failed");
    error.statusCode = response.status;
    throw error;
  }

  return data;
}

function showAuthView() {
  document.getElementById("authView").classList.remove("hidden");
  document.getElementById("appView").classList.add("hidden");
}

function showAppView() {
  document.getElementById("authView").classList.add("hidden");
  document.getElementById("appView").classList.remove("hidden");
}

async function loadAuthenticatedDashboard() {
  const [dashboard, activity] = await Promise.all([
    requestJson("/api/me/dashboard"),
    requestJson("/api/me/activity"),
  ]);

  renderDashboard(dashboard);
  renderActivity(activity);
  showAppView();
}

async function bootstrapApp() {
  try {
    await requestJson("/api/auth/me");
    await loadAuthenticatedDashboard();
  } catch (error) {
    if (error.statusCode === 401) {
      showAuthView();
      return;
    }

    setFlashMessage(error.message, "error", "authMessage");
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
    await loadAuthenticatedDashboard();
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
      await loadAuthenticatedDashboard();
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
      await loadAuthenticatedDashboard();
    } catch (error) {
      setFlashMessage(error.message, "error");
    }
  });

document.getElementById("telegramForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await requestJson("/api/me/telegram-connect", {
      method: "POST",
      body: JSON.stringify({
        telegram_chat_id: document.getElementById("telegramChatIdInput").value,
      }),
    });
    setFlashMessage("Telegram chat ID saved.", "success");
    await loadAuthenticatedDashboard();
  } catch (error) {
    setFlashMessage(error.message, "error");
  }
});

document.getElementById("logoutButton").addEventListener("click", async () => {
  await requestJson("/api/auth/logout", {
    method: "POST",
  });
  showAuthView();
});

bootstrapApp();
