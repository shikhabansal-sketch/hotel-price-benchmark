const formatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
});

const moneyFromLowestUnit = value => {
  if (!Number.isFinite(value)) return "-";
  return `GBP ${(Math.abs(value) / 100).toFixed(2)}`;
};

const formatSignedPercent = value => {
  if (!Number.isFinite(value)) return "-";
  if (value === 0) return "0.0%";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
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
    body.innerHTML = `<tr><td class="empty" colspan="7">No hotels found.</td></tr>`;
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
          ? `${Math.abs(row.deltaPercentValue || 0).toFixed(1)}% cheaper on Omio`
          : Number.isFinite(row.deltaLowestUnitValue) && row.deltaLowestUnitValue > 0
            ? `${Math.abs(row.deltaPercentValue || 0).toFixed(1)}% cheaper on Booking.com`
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
          <td><span class="${deltaClass(row)}"><span class="delta-percent">${escapeHtml(formatSignedPercent(row.deltaPercentValue))}</span></span></td>
          <td><span class="${classForSupplier(row.cheaperSupplier)}">${escapeHtml(row.cheaperSupplier || "n/a")}</span></td>
          <td>${renderStatus(row)}</td>
        </tr>
      `;
    })
    .join("");
};

const renderState = dashboardState => {
  text("configLabel", dashboardState.config.label);
  text("hotelCount", dashboardState.summary.hotelCount);
  text("competitiveness", `${dashboardState.summary.competitiveness}%`);
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
  text("publishedAt", formatDateTime(dashboardState.publishedAtIso));

  renderRows(dashboardState.rows);
};

fetch(`data.json?v=${Date.now()}`, { cache: "no-store" })
  .then(response => response.json())
  .then(renderState)
  .catch(error => {
    text("snapshotStatus", error.message);
    document.getElementById("snapshotStatus").className = "status-pill failed";
  });
