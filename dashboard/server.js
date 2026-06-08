const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.resolve(__dirname, "public");
const HOTELS_FILE = path.join(REPO_ROOT, "hotels.md");
const RUNS_ROOT = path.join(REPO_ROOT, "runs");
const RUNNER_FILE = path.join(REPO_ROOT, "scripts", "booking-omio-compare.js");
const EXPORT_FILE = path.join(REPO_ROOT, "scripts", "export-static.js");
const DEFAULT_PORT = Number.parseInt(process.env.PORT || "4317", 10);
const PAGES_URL =
  "https://shikhabansal-sketch.github.io/hotel-price-benchmark/";
const AUTO_PUBLISH_ON_REFRESH = process.env.AUTO_PUBLISH_ON_REFRESH !== "0";

let activeJob = null;

const normalizeHeader = value =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

const normalizeText = value => (value || "").replace(/\s+/g, " ").trim();

const splitMarkdownRow = line => {
  const trimmed = line.trim();
  const withoutLeadingPipe = trimmed.startsWith("|")
    ? trimmed.slice(1)
    : trimmed;
  const withoutEdgePipes = withoutLeadingPipe.endsWith("|")
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;

  return withoutEdgePipes.split("|").map(cell => cell.trim());
};

const parseLowestUnitValue = value => {
  const match = /([+-]?)\s*(?:[A-Z]{3})?\s*([0-9][0-9,.]*)/.exec(value || "");
  if (!match) return undefined;

  const sign = match[1] === "-" ? -1 : 1;
  const normalized = match[2].includes(",") && !match[2].includes(".")
    ? match[2].replace(/\./g, "").replace(",", ".")
    : match[2].replace(/,/g, "");
  const amount = Number.parseFloat(normalized);

  if (!Number.isFinite(amount)) return undefined;

  return sign * Math.round(amount * 100);
};

const formatMoney = (lowestUnitValue, currency = "GBP", includeSign = false) => {
  if (!Number.isFinite(lowestUnitValue)) return "";

  const sign = includeSign && lowestUnitValue > 0 ? "+" : "";
  return `${sign}${currency} ${(lowestUnitValue / 100).toFixed(2)}`;
};

const getDeltaPercentValue = (deltaLowestUnitValue, bookingLowestUnitValue) => {
  if (
    !Number.isFinite(deltaLowestUnitValue) ||
    !Number.isFinite(bookingLowestUnitValue) ||
    bookingLowestUnitValue === 0
  ) {
    return undefined;
  }

  return (deltaLowestUnitValue / bookingLowestUnitValue) * 100;
};

const parseConfig = markdown => {
  const line = markdown.split(/\r?\n/).find(entry => /_?Config:/i.test(entry));
  if (!line) return { label: "Config unavailable", currency: "GBP" };

  const label = line
    .replace(/^_?\s*Config:\s*/i, "")
    .replace(/_+$/g, "")
    .trim();
  const currency = /\b([A-Z]{3})\b/.exec(label)?.[1] || "GBP";

  return { label, currency };
};

const parseHotelsMarkdown = markdown => {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex(line => {
    if (!line.includes("|")) return false;
    const headers = splitMarkdownRow(line).map(normalizeHeader);

    return (
      headers.includes("hotel") &&
      headers.includes("latitude") &&
      headers.includes("longitude") &&
      headers.includes("bookingcomurl")
    );
  });

  if (headerIndex < 0) {
    throw new Error("Could not find the hotel table in hotels.md");
  }

  const headers = splitMarkdownRow(lines[headerIndex]);
  const indexByHeader = new Map();
  headers.forEach((header, index) => {
    indexByHeader.set(normalizeHeader(header), index);
  });

  const getCell = (row, header) => {
    const index = indexByHeader.get(normalizeHeader(header));
    return index === undefined ? "" : row[index] || "";
  };

  const hotels = [];

  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !line.trim()) continue;
    if (!line.trim().startsWith("|")) break;

    const row = splitMarkdownRow(line);
    const bookingLowestUnitValue = parseLowestUnitValue(
      getCell(row, "Booking.com Price (GBP)"),
    );
    const omioLowestUnitValue = parseLowestUnitValue(
      getCell(row, "Omio/HBX Price (GBP)"),
    );
    const deltaLowestUnitValue =
      Number.isFinite(bookingLowestUnitValue) && Number.isFinite(omioLowestUnitValue)
        ? omioLowestUnitValue - bookingLowestUnitValue
        : parseLowestUnitValue(getCell(row, "Delta Omio - Booking (GBP)"));

    hotels.push({
      rowNumber: Number.parseInt(getCell(row, "#"), 10) || hotels.length + 1,
      hotel: getCell(row, "Hotel"),
      location: getCell(row, "Location"),
      city: getCell(row, "City"),
      latitude: Number.parseFloat(getCell(row, "Latitude")),
      longitude: Number.parseFloat(getCell(row, "Longitude")),
      bookingUrl: getCell(row, "Booking.com URL"),
      accommodationServiceId: getCell(row, "Accommodation Service ID"),
      providerHotelIdentifier: getCell(row, "Provider Hotel Identifier"),
      bookingPrice: getCell(row, "Booking.com Price (GBP)"),
      bookingLowestUnitValue,
      omioPrice: getCell(row, "Omio/HBX Price (GBP)"),
      omioLowestUnitValue,
      cheaperSupplier: getCell(row, "Cheaper Supplier"),
      deltaLowestUnitValue,
      delta: Number.isFinite(deltaLowestUnitValue)
        ? formatMoney(deltaLowestUnitValue, "GBP", true)
        : getCell(row, "Delta Omio - Booking (GBP)"),
      warnings: getCell(row, "Status") === "ok" ? "" : getCell(row, "Status"),
    });
  }

  return hotels;
};

const getLatestResult = () => {
  if (!fs.existsSync(RUNS_ROOT)) return null;

  const candidates = fs
    .readdirSync(RUNS_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith("booking-omio-"))
    .map(entry => {
      const jsonPath = path.join(RUNS_ROOT, entry.name, "comparison.json");
      if (!fs.existsSync(jsonPath)) return null;

      const stats = fs.statSync(jsonPath);
      const match = /^booking-omio-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$/.exec(
        entry.name,
      );

      return {
        path: jsonPath,
        directory: entry.name,
        mtimeMs: stats.mtimeMs,
        updatedAtIso: stats.mtime.toISOString(),
        checkInIso: match?.[1] || "",
        checkOutIso: match?.[2] || "",
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  if (!candidates[0]) return null;

  return {
    ...candidates[0],
    rows: JSON.parse(fs.readFileSync(candidates[0].path, "utf8")),
  };
};

const getResultRow = (resultsByNumber, hotel) =>
  resultsByNumber.get(hotel.rowNumber) ||
  [...resultsByNumber.values()].find(row => row.hotel === hotel.hotel) ||
  {};

const getCheaperSupplier = (bookingValue, omioValue, fallback) => {
  if (!Number.isFinite(bookingValue) || !Number.isFinite(omioValue)) {
    return fallback || "n/a";
  }
  if (bookingValue === omioValue) return "Tie";
  return bookingValue < omioValue ? "Booking.com" : "Omio/HBX";
};

const buildRows = (hotels, latestResult, currency) => {
  const resultsByNumber = new Map(
    (latestResult?.rows || []).map(row => [row.rowNumber, row]),
  );

  return hotels.map(hotel => {
    const result = getResultRow(resultsByNumber, hotel);
    const hasLatestResult = Boolean(result.rowNumber);
    const bookingLowestUnitValue = hasLatestResult
      ? result.bookingLowestUnitValue
      : result.bookingLowestUnitValue ?? hotel.bookingLowestUnitValue;
    const omioLowestUnitValue = hasLatestResult
      ? result.omioLowestUnitValue
      : result.omioLowestUnitValue ?? hotel.omioLowestUnitValue;
    const deltaLowestUnitValue =
      Number.isFinite(bookingLowestUnitValue) && Number.isFinite(omioLowestUnitValue)
        ? omioLowestUnitValue - bookingLowestUnitValue
        : hasLatestResult
          ? result.deltaLowestUnitValue
          : result.deltaLowestUnitValue ?? hotel.deltaLowestUnitValue;
    const deltaPercentValue = getDeltaPercentValue(
      deltaLowestUnitValue,
      bookingLowestUnitValue,
    );
    const warnings = normalizeText(result.warnings);
    const hasFallbackOmio = !hasLatestResult && !result.omioPrice && hotel.omioPrice;
    const hasFallbackBooking =
      !hasLatestResult && !result.bookingPrice && hotel.bookingPrice;

    return {
      rowNumber: hotel.rowNumber,
      hotel: hotel.hotel,
      location: hotel.location,
      city: hotel.city,
      latitude: hotel.latitude,
      longitude: hotel.longitude,
      bookingUrl: result.bookingUrl || hotel.bookingUrl,
      bookingPrice:
        result.bookingPrice ||
        (!hasLatestResult ? hotel.bookingPrice : "") ||
        formatMoney(bookingLowestUnitValue, currency),
      bookingLowestUnitValue,
      bookingRoomName: result.bookingRoomName || "",
      omioUrl: result.omioUrl || "",
      omioPrice:
        result.omioPrice ||
        (!hasLatestResult ? hotel.omioPrice : "") ||
        formatMoney(omioLowestUnitValue, currency),
      omioLowestUnitValue,
      omioAccommodationName: result.omioAccommodationName || "",
      omioRoomName: result.omioRoomName || "",
      cheaperSupplier: getCheaperSupplier(
        bookingLowestUnitValue,
        omioLowestUnitValue,
        result.cheaperSupplier || hotel.cheaperSupplier,
      ),
      delta: Number.isFinite(deltaLowestUnitValue)
        ? formatMoney(deltaLowestUnitValue, currency, true)
        : result.delta || (!hasLatestResult ? hotel.delta : "") || "",
      deltaLowestUnitValue,
      deltaPercentValue,
      warnings:
        warnings && !hasFallbackOmio && !hasFallbackBooking
          ? warnings
          : hotel.warnings || "",
      source:
        hasFallbackOmio || hasFallbackBooking
          ? "hotels.md"
          : hasLatestResult
            ? "latest run"
            : "hotels.md",
    };
  });
};

const buildSummary = rows => {
  const summary = rows.reduce(
    (accumulator, row) => {
      if (row.cheaperSupplier === "Omio/HBX") accumulator.omioWins += 1;
      if (row.cheaperSupplier === "Booking.com") accumulator.bookingWins += 1;
      if (row.cheaperSupplier === "Tie") accumulator.ties += 1;
      if (row.warnings) accumulator.warnings += 1;
      if (Number.isFinite(row.deltaLowestUnitValue)) {
        if (Number.isFinite(row.bookingLowestUnitValue) && row.bookingLowestUnitValue > 0) {
          accumulator.weightedDeltaTotal += row.deltaLowestUnitValue;
          accumulator.weightedBookingTotal += row.bookingLowestUnitValue;
        }
        if (
          !accumulator.bestOmioSaving ||
          row.deltaLowestUnitValue < accumulator.bestOmioSaving.deltaLowestUnitValue
        ) {
          accumulator.bestOmioSaving = row;
        }
      }
      return accumulator;
    },
    {
      hotelCount: rows.length,
      omioWins: 0,
      bookingWins: 0,
      ties: 0,
      warnings: 0,
      bestOmioSaving: null,
      weightedDeltaTotal: 0,
      weightedBookingTotal: 0,
    },
  );

  return {
    ...summary,
    competitiveness:
      summary.weightedBookingTotal > 0
        ? Number(
            (
              100 -
              (summary.weightedDeltaTotal / summary.weightedBookingTotal) * 100
            ).toFixed(1),
          )
        : 100,
    bestOmioSaving:
      summary.bestOmioSaving && summary.bestOmioSaving.deltaLowestUnitValue < 0
        ? {
            hotel: summary.bestOmioSaving.hotel,
            value: Math.abs(summary.bestOmioSaving.deltaLowestUnitValue),
          }
        : null,
  };
};

const buildDashboardState = () => {
  const markdown = fs.readFileSync(HOTELS_FILE, "utf8");
  const hotelsStats = fs.statSync(HOTELS_FILE);
  const config = parseConfig(markdown);
  const hotels = parseHotelsMarkdown(markdown);
  const latestResult = getLatestResult();
  const rows = buildRows(hotels, latestResult, config.currency);

  return {
    generatedAtIso: new Date().toISOString(),
    config,
    hotelsUpdatedAtIso: hotelsStats.mtime.toISOString(),
    latestRun: latestResult
      ? {
          directory: latestResult.directory,
          updatedAtIso: latestResult.updatedAtIso,
          checkInIso: latestResult.checkInIso,
          checkOutIso: latestResult.checkOutIso,
        }
      : null,
    job: activeJob ? getPublicJob() : null,
    summary: buildSummary(rows),
    rows,
  };
};

const getPublicJob = () =>
  activeJob
    ? {
        id: activeJob.id,
        status: activeJob.status,
        startedAtIso: activeJob.startedAtIso,
        finishedAtIso: activeJob.finishedAtIso,
        totalCount: activeJob.totalCount,
        checkedCount: activeJob.checkedCount,
        activeHotel: activeJob.activeHotel,
        exitCode: activeJob.exitCode,
        error: activeJob.error,
        pagesUrl: activeJob.pagesUrl,
        logs: activeJob.logs.slice(-80),
      }
    : null;

const appendLogLine = line => {
  if (!activeJob || !line) return;
  activeJob.logs.push(line);
};

const appendJobLog = chunk => {
  if (!activeJob) return;

  const text = chunk.toString();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    appendLogLine(line);

    const match = /^Checking\s+(\d+)\.\s+(.+)$/.exec(line);
    if (match) {
      activeJob.checkedCount = Math.max(
        activeJob.checkedCount,
        Number.parseInt(match[1], 10) - 1,
      );
      activeJob.activeHotel = match[2];
    }
  }
};

const runPublishCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    appendLogLine(`$ ${[command, ...args].join(" ")}`);

    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let output = "";
    const handleOutput = chunk => {
      output += chunk.toString();
      appendJobLog(chunk);
    };

    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);
    child.on("error", reject);
    child.on("close", code => {
      const allowedCodes = options.allowedCodes || [0];

      if (allowedCodes.includes(code)) {
        resolve({ code, output });
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });

const publishSnapshot = async () => {
  if (!activeJob) return;

  activeJob.status = "publishing";
  activeJob.checkedCount = activeJob.totalCount;
  activeJob.activeHotel = "Exporting static dashboard";
  appendLogLine("Publishing GitHub Pages snapshot");

  await runPublishCommand(process.execPath, [EXPORT_FILE]);
  activeJob.activeHotel = "Committing dashboard snapshot";
  await runPublishCommand("git", ["add", "docs", "runs"]);

  const diff = await runPublishCommand("git", ["diff", "--cached", "--quiet"], {
    allowedCodes: [0, 1],
  });

  if (diff.code === 0) {
    appendLogLine("No static snapshot changes to commit");
  } else {
    const latestResult = getLatestResult();
    const suffix = latestResult
      ? `${latestResult.checkInIso} to ${latestResult.checkOutIso}`
      : new Date().toISOString().slice(0, 10);

    await runPublishCommand("git", [
      "commit",
      "-m",
      `Update benchmark snapshot ${suffix}`,
    ]);
  }

  activeJob.activeHotel = "Pushing GitHub Pages snapshot";
  await runPublishCommand("git", ["push"]);
  activeJob.pagesUrl = PAGES_URL;
  appendLogLine(`Published ${PAGES_URL}`);
};

const startRefreshJob = () => {
  if (["running", "publishing"].includes(activeJob?.status)) return activeJob;

  const hotels = parseHotelsMarkdown(fs.readFileSync(HOTELS_FILE, "utf8"));

  activeJob = {
    id: `refresh-${Date.now()}`,
    status: "running",
    startedAtIso: new Date().toISOString(),
    finishedAtIso: null,
    totalCount: hotels.length,
    checkedCount: 0,
    activeHotel: "",
    exitCode: null,
    error: "",
    logs: [],
  };

  const child = spawn(process.execPath, [RUNNER_FILE], {
    cwd: REPO_ROOT,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  child.stdout.on("data", appendJobLog);
  child.stderr.on("data", appendJobLog);
  child.on("error", error => {
    activeJob.status = "failed";
    activeJob.error = error.message;
    activeJob.finishedAtIso = new Date().toISOString();
  });
  child.on("close", code => {
    if (!activeJob) return;

    activeJob.exitCode = code;

    if (code !== 0) {
      activeJob.status = "failed";
      activeJob.finishedAtIso = new Date().toISOString();
      return;
    }

    activeJob.checkedCount = activeJob.totalCount;

    if (!AUTO_PUBLISH_ON_REFRESH) {
      activeJob.status = "completed";
      activeJob.finishedAtIso = new Date().toISOString();
      return;
    }

    publishSnapshot()
      .then(() => {
        if (!activeJob) return;
        activeJob.status = "completed";
        activeJob.finishedAtIso = new Date().toISOString();
      })
      .catch(error => {
        if (!activeJob) return;
        activeJob.status = "failed";
        activeJob.error = error.message;
        activeJob.finishedAtIso = new Date().toISOString();
      });
  });

  return activeJob;
};

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
};

const sendError = (response, statusCode, error) => {
  sendJson(response, statusCode, { error: error.message || String(error) });
};

const serveStatic = (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const assetName = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const assetPath = path.resolve(PUBLIC_DIR, assetName);

  if (!assetPath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(assetPath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const ext = path.extname(assetPath);
    const type =
      ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : "text/html; charset=utf-8";

    response.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
    });
    response.end(content);
  });
};

const handleRequest = (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/api/state") {
    try {
      sendJson(response, 200, buildDashboardState());
    } catch (error) {
      sendError(response, 500, error);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/job") {
    sendJson(response, 200, { job: getPublicJob() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/refresh") {
    try {
      if (!["running", "publishing"].includes(activeJob?.status)) {
        startRefreshJob();
      }
      sendJson(response, 202, { job: getPublicJob() });
    } catch (error) {
      sendError(response, 500, error);
    }
    return;
  }

  if (request.method === "GET") {
    serveStatic(request, response);
    return;
  }

  response.writeHead(405);
  response.end("Method not allowed");
};

const listen = port => {
  const server = http.createServer(handleRequest);

  server.on("error", error => {
    if (error.code === "EADDRINUSE" && port < DEFAULT_PORT + 20) {
      listen(port + 1);
      return;
    }

    throw error;
  });

  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Hotel benchmark dashboard: http://127.0.0.1:${port}\n`);
  });
};

if (require.main === module) {
  listen(DEFAULT_PORT);
} else {
  module.exports = {
    buildDashboardState,
  };
}
