(function () {
  const loginScreen = document.getElementById("login-screen");
  const dashboard = document.getElementById("dashboard");
  const passcodeInput = document.getElementById("passcode-input");
  const btnLogin = document.getElementById("btn-login");
  const loginError = document.getElementById("login-error");
  const btnLogout = document.getElementById("btn-logout");

  let adminToken = sessionStorage.getItem("adminToken");
  let refreshInterval = null;
  let currentFunnelPeriod = "day";
  let latestFunnelData = null;

  // If we have a stored token, try loading dashboard directly
  if (adminToken) {
    loginScreen.classList.add("hidden");
    dashboard.classList.remove("hidden");
    loadStats();
    startAutoRefresh();
  }

  // Login
  btnLogin.addEventListener("click", login);
  passcodeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });

  async function login() {
    const passcode = passcodeInput.value;
    if (!passcode) return;

    btnLogin.disabled = true;
    loginError.classList.add("hidden");

    try {
      const res = await fetch("/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });

      if (!res.ok) {
        loginError.classList.remove("hidden");
        btnLogin.disabled = false;
        return;
      }

      const data = await res.json();
      adminToken = data.token;
      sessionStorage.setItem("adminToken", adminToken);

      loginScreen.classList.add("hidden");
      dashboard.classList.remove("hidden");
      loadStats();
      startAutoRefresh();
    } catch {
      loginError.textContent = "Network error. Try again.";
      loginError.classList.remove("hidden");
      btnLogin.disabled = false;
    }
  }

  // Logout
  btnLogout.addEventListener("click", () => {
    adminToken = null;
    sessionStorage.removeItem("adminToken");
    clearInterval(refreshInterval);
    dashboard.classList.add("hidden");
    loginScreen.classList.remove("hidden");
    passcodeInput.value = "";
    btnLogin.disabled = false;
  });

  // ---- Tab switching ----
  document.querySelectorAll(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      const target = tab.dataset.tab;
      document.querySelectorAll(".tab-content").forEach((tc) => tc.classList.add("hidden"));
      document.getElementById("tab-" + target).classList.remove("hidden");
    });
  });

  // ---- Funnel period selector ----
  document.querySelectorAll(".funnel-period-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".funnel-period-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFunnelPeriod = btn.dataset.period;
      if (latestFunnelData) renderFunnel(latestFunnelData);
    });
  });

  // Load stats
  async function loadStats() {
    try {
      const res = await fetch("/api/admin/stats", {
        headers: { "x-admin-token": adminToken },
      });

      if (res.status === 401) {
        adminToken = null;
        sessionStorage.removeItem("adminToken");
        dashboard.classList.add("hidden");
        loginScreen.classList.remove("hidden");
        return;
      }

      if (!res.ok) return;

      const data = await res.json();
      renderStats(data);

      if (data.funnel) {
        latestFunnelData = data.funnel;
        renderFunnel(data.funnel);
      }

      if (data.sessions) {
        renderSessions(data.sessions);
      }
    } catch {
      // silently fail, will retry on next interval
    }
  }

  function renderStats(data) {
    // Visitors
    setText("visits-day-total", data.visitors.day.totalVisits);
    setText("visits-day-unique", data.visitors.day.uniqueVisitors);
    setText("visits-week-total", data.visitors.week.totalVisits);
    setText("visits-week-unique", data.visitors.week.uniqueVisitors);
    setText("visits-month-total", data.visitors.month.totalVisits);
    setText("visits-month-unique", data.visitors.month.uniqueVisitors);

    // Rooms
    setText("rooms-day", data.rooms.day.roomsCreated);
    setText("rooms-week", data.rooms.week.roomsCreated);
    setText("rooms-month", data.rooms.month.roomsCreated);

    // Rooms per user
    setText("avg-rooms", data.roomsPerUser.avgRoomsPerUser);

    // Top creators
    const tbody = document.getElementById("top-creators");
    if (data.roomsPerUser.topCreators.length === 0) {
      tbody.innerHTML = '<tr><td colspan="2" class="table-empty">No data yet</td></tr>';
    } else {
      tbody.innerHTML = data.roomsPerUser.topCreators
        .map((c) => `<tr><td>${maskIp(c.ip)}</td><td>${c.rooms}</td></tr>`)
        .join("");
    }

    // Retention
    setText("retention-day-count", `${data.retention.day.returning} / ${data.retention.day.total}`);
    setText("retention-day-rate", `${data.retention.day.rate}%`);
    setText("retention-week-count", `${data.retention.week.returning} / ${data.retention.week.total}`);
    setText("retention-week-rate", `${data.retention.week.rate}%`);
    setText("retention-month-count", `${data.retention.month.returning} / ${data.retention.month.total}`);
    setText("retention-month-rate", `${data.retention.month.rate}%`);

    // Avg time on room
    setText("avg-time", data.avgTimeOnRoom.formatted);

    // Link shares
    setText("shares-day-total", data.linkShares.day.totalShares);
    setText("shares-day-rooms", data.linkShares.day.uniqueRooms);
    setText("shares-week-total", data.linkShares.week.totalShares);
    setText("shares-week-rooms", data.linkShares.week.uniqueRooms);
    setText("shares-month-total", data.linkShares.month.totalShares);
    setText("shares-month-rooms", data.linkShares.month.uniqueRooms);

    // Permanent rooms
    const permTbody = document.getElementById("permanent-rooms");
    if (!data.permanentRooms || data.permanentRooms.length === 0) {
      permTbody.innerHTML = '<tr><td colspan="3" class="table-empty">No data yet</td></tr>';
    } else {
      permTbody.innerHTML = data.permanentRooms
        .map((r) => `<tr><td>/p/${escHtml(r.slug)}</td><td>${formatDate(r.createdAt)}</td><td>${r.sessionCount}</td></tr>`)
        .join("");
    }
  }

  // ---- Funnel rendering ----
  function renderFunnel(funnelData) {
    const d = funnelData[currentFunnelPeriod];
    if (!d) return;

    const steps = [
      { label: "Unique Visitors", value: d.uniqueVisitors },
      { label: "Created a Room", value: d.roomCreators },
      { label: "Shared the Link", value: d.linkSharers },
      { label: "Conversation Started (2+ people)", value: d.conversationsStarted },
    ];

    const container = document.getElementById("funnel-steps");
    const topValue = steps[0].value || 1;

    container.innerHTML = steps
      .map((step, i) => {
        const barWidth = Math.max(((step.value / topValue) * 100), 2);
        let convRate = "";
        if (i > 0) {
          const prev = steps[i - 1].value;
          const rate = prev > 0 ? Math.round((step.value / prev) * 100) : 0;
          convRate = `<span class="funnel-rate">${rate}% from previous</span>`;
        }

        return `
          <div class="funnel-step">
            <div class="funnel-step-header">
              <span class="funnel-step-label">${step.label}</span>
              <span class="funnel-step-value">${step.value.toLocaleString()}</span>
            </div>
            <div class="funnel-bar-track">
              <div class="funnel-bar" style="width: ${barWidth}%"></div>
            </div>
            ${convRate}
          </div>
          ${i < steps.length - 1 ? '<div class="funnel-arrow">&#9660;</div>' : ""}
        `;
      })
      .join("");

    // Additional metrics
    setText("funnel-avg-duration", d.avgSessionDuration.formatted);
    setText("funnel-rooms-at-destruction", d.roomsWithMultipleAtDestruction);
    setText("funnel-time-to-second", d.avgTimeToSecondJoiner.formatted);
    setText("funnel-avg-messages", d.avgMessagesPerRoom);
  }

  // ---- Sessions rendering ----
  function renderSessions(sessions) {
    const tbody = document.getElementById("session-list");
    if (!sessions || sessions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No data yet</td></tr>';
      return;
    }

    tbody.innerHTML = sessions
      .map((s) => {
        const url = `/room/${escHtml(s.roomId)}`;
        const created = formatDateTime(s.createdAt);
        return `<tr>
          <td><a href="${url}" class="session-link" target="_blank">${url}</a></td>
          <td>${created}</td>
          <td>${s.duration.formatted}</td>
          <td>${s.people}</td>
          <td>${s.messages}</td>
        </tr>`;
      })
      .join("");
  }

  function setText(id, value) {
    document.getElementById(id).textContent = value;
  }

  function maskIp(ip) {
    if (!ip) return "—";
    const parts = ip.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.***.***`;
    }
    return ip.slice(0, Math.ceil(ip.length / 2)) + "***";
  }

  function escHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDate(isoStr) {
    const d = new Date(isoStr);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  function formatDateTime(isoStr) {
    const d = new Date(isoStr);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function startAutoRefresh() {
    refreshInterval = setInterval(loadStats, 60_000);
  }
})();
