const state = {
  pollTimer: null,
};

const formatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
});

const moneyFromLowestUnit = value => {
  if (!Number.isFinite(value)) return "-";
  return `GBP ${(Math.abs(value) / 100).toFixed(2)}`;
};

const formatDateTime = value => {
  if (!value) return "-";
  return formatter.format(new Date(value));
};

const text = (id, value) => {
  document.getElementById(id).textContent = value;
};

const classForSupplier = supplier => {
  if (supplier === "Omio/HBX") return "chip chip-omio";
  if (supplier === "Booking.com") return "chip chip-booking";
  if (supplier === "Tie") return "chip chip-tie";
  return "chip chip-na";
};

const renderStatus = row => {
  if (row.warnings) {
    return `<span class="chip chip-warning">${escapeHtml(row.warnings)}</span>`;
  }
  return `<span class="chip chip-ok">ok</span>`;
};

const deltaClass = row => {
  if (!Number.isFinite(row.deltaLowestUnitValue) || row.deltaLowestUnitValue === 0) {
    return "delta delta-neutral";
  }
  return row.deltaLowestUnitValue < 0 ? "delta delta-negative" : "delta delta-positive";
};

const deltaBar = row => {
  if (!Number.isFinite(row.deltaLowestUnitValue)) return "";

  const width = Math.min(Math.abs(row.deltaLowestUnitValue) / 5000, 1) * 50;
  const isNegative = row.deltaLowestUnitValue < 0;
  const color = isNegative
    ? "#168262"
    : row.deltaLowestUnitValue > 0
      ? "#df1b0a"
      : "#9f6f2b";
  const offset = isNegative ? "-100%" : "0";

  return `
    <span
      style="--bar-width: ${width}%; --bar-color: ${color}; --bar-offset: ${offset}"
    ></span>
  `;
};

const escapeHtml = value =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const renderRows = rows => {
  const body = document.getElementById("resultsBody");

  if (!rows.length) {
    body.innerHTML = `<tr><td class="empty" colspan="6">No hotels found.</td></tr>`;
    return;
  }

  const maxDelta = rows.reduce(
    (maximum, row) =>
      Number.isFinite(row.deltaLowestUnitValue)
        ? Math.max(maximum, Math.abs(row.deltaLowestUnitValue))
        : maximum,
    0,
  );

  body.innerHTML = rows
    .map(row => {
      const percent = maxDelta
        ? Math.round((Math.abs(row.deltaLowestUnitValue || 0) / maxDelta) * 100)
        : 0;
      const deltaLabel =
        Number.isFinite(row.deltaLowestUnitValue) && row.deltaLowestUnitValue < 0
          ? `${moneyFromLowestUnit(row.deltaLowestUnitValue)} cheaper on Omio`
          : Number.isFinite(row.deltaLowestUnitValue) && row.deltaLowestUnitValue > 0
            ? `${moneyFromLowestUnit(row.deltaLowestUnitValue)} cheaper on Booking.com`
            : "No spread";

      return `
        <tr>
          <td>
            <span class="hotel-name">${escapeHtml(row.hotel)}</span>
            <span class="hotel-meta">${escapeHtml(row.city)}${
              row.location ? `, ${escapeHtml(row.location)}` : ""
            }</span>
          </td>
          <td>
            <span class="price">${escapeHtml(row.bookingPrice || "-")}</span>
            <span class="room-meta">${escapeHtml(row.bookingRoomName || "Lowest displayed price")}</span>
          </td>
          <td>
            <span class="price">${escapeHtml(row.omioPrice || "-")}</span>
            <span class="room-meta">${escapeHtml(row.omioRoomName || row.omioAccommodationName || "Exact hotel match")}</span>
          </td>
          <td>
            <div class="${deltaClass(row)}">
              <span class="delta-value">${escapeHtml(row.delta || "-")}</span>
              <div class="delta-bar" aria-label="${percent}% spread">${deltaBar(row)}</div>
              <span class="room-meta">${deltaLabel}</span>
            </div>
          </td>
          <td><span class="${classForSupplier(row.cheaperSupplier)}">${escapeHtml(row.cheaperSupplier || "n/a")}</span></td>
          <td>${renderStatus(row)}</td>
        </tr>
      `;
    })
    .join("");
};

const renderJob = job => {
  const panel = document.getElementById("jobPanel");
  const button = document.getElementById("refreshButton");
  const status = document.getElementById("runStatus");

  status.className = "status-pill";

  if (!job) {
    panel.hidden = true;
    button.disabled = false;
    status.textContent = "Idle";
    return;
  }

  status.classList.add(job.status);
  status.textContent =
    job.status === "running"
      ? "Refreshing"
      : job.status === "publishing"
        ? "Publishing"
      : job.status === "completed"
        ? "Complete"
        : "Failed";

  if (job.status === "running" || job.status === "publishing") {
    panel.hidden = false;
    button.disabled = true;
    text(
      "activeHotel",
      job.activeHotel ||
        (job.status === "publishing"
          ? "Publishing GitHub Pages snapshot"
          : "Opening Booking.com"),
    );
    const totalCount = job.totalCount || 10;
    text("jobCount", `${job.checkedCount || 0} / ${totalCount}`);
    document.getElementById("progressBar").style.width = `${Math.min(
      ((job.checkedCount || 0) / totalCount) * 100,
      100,
    )}%`;
    return;
  }

  panel.hidden = true;
  button.disabled = false;
};

const renderState = dashboardState => {
  text("configLabel", dashboardState.config.label);
  text("hotelCount", dashboardState.summary.hotelCount);
  text("omioWins", dashboardState.summary.omioWins);
  text("bookingWins", dashboardState.summary.bookingWins);
  text("ties", dashboardState.summary.ties);
  text(
    "bestSaving",
    dashboardState.summary.bestOmioSaving
      ? moneyFromLowestUnit(dashboardState.summary.bestOmioSaving.value)
      : "-",
  );
  text(
    "stayDates",
    dashboardState.latestRun
      ? `${dashboardState.latestRun.checkInIso} to ${dashboardState.latestRun.checkOutIso}`
      : "Pending first run",
  );
  text(
    "latestRun",
    dashboardState.latestRun ? formatDateTime(dashboardState.latestRun.updatedAtIso) : "-",
  );
  text(
    "sourceLabel",
    dashboardState.latestRun ? dashboardState.latestRun.directory : "hotels.md",
  );
  text(
    "tableSubtitle",
    `${dashboardState.summary.hotelCount} hotels, ${dashboardState.summary.warnings} warnings`,
  );

  renderJob(dashboardState.job);
  renderRows(dashboardState.rows);
};

const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }

  return payload;
};

const loadState = async () => {
  const dashboardState = await fetchJson("/api/state");
  renderState(dashboardState);
};

const pollJob = async () => {
  const payload = await fetchJson("/api/job");
  renderJob(payload.job);

  if (payload.job?.status === "running" || payload.job?.status === "publishing") {
    return;
  }

  window.clearInterval(state.pollTimer);
  state.pollTimer = null;
  await loadState();
};

const startPolling = () => {
  if (state.pollTimer) window.clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(pollJob, 1500);
};

document.getElementById("refreshButton").addEventListener("click", async () => {
  const button = document.getElementById("refreshButton");

  try {
    button.disabled = true;
    const payload = await fetchJson("/api/refresh", { method: "POST" });
    renderJob(payload.job);
    startPolling();
  } catch (error) {
    button.disabled = false;
    text("runStatus", error.message);
    document.getElementById("runStatus").className = "status-pill failed";
  }
});

loadState().catch(error => {
  text("runStatus", error.message);
  document.getElementById("runStatus").className = "status-pill failed";
});
