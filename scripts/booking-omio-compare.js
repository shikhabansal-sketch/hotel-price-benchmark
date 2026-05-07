const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const REPO_ROOT = path.resolve(__dirname, "..");
const HOTELS_FILE = path.join(REPO_ROOT, "hotels.md");
const HOTELS_MARKDOWN = fs.readFileSync(HOTELS_FILE, "utf8");
const CONFIG = parseBenchmarkConfig(HOTELS_MARKDOWN);
const CHECK_IN_ISO = CONFIG.checkInIso;
const CHECK_OUT_ISO = CONFIG.checkOutIso;
const CHECK_IN_API = formatIsoToApiDate(CHECK_IN_ISO);
const CHECK_OUT_API = formatIsoToApiDate(CHECK_OUT_ISO);
const CURRENCY = CONFIG.currency;
const CURRENCY_SYMBOL = currencySymbolFor(CURRENCY);
const USER_COUNTRY_CODE = CONFIG.userCountryCode;
const ADULTS = CONFIG.adults;
const CHILDREN = CONFIG.children;
const ROOMS = CONFIG.rooms;
const PAGE_SIZE = "1000";
const OUTPUT_DIR = path.resolve(
  REPO_ROOT,
  "runs",
  `booking-omio-${CHECK_IN_ISO}-${CHECK_OUT_ISO}`,
);

const normalizeText = value => (value || "").replace(/\s+/g, " ").trim();

function parseBenchmarkConfig(markdown) {
  const configLine = markdown
    .split(/\r?\n/)
    .find(line => /_?Config:/i.test(line));

  if (!configLine) {
    throw new Error("hotels.md is missing a _Config:_ line");
  }

  const configText = configLine
    .replace(/^_?\s*Config:\s*/i, "")
    .replace(/_+$/g, "")
    .trim();
  const explicitDateRange = /(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/.exec(
    configText,
  );
  const nights =
    Number.parseInt(/(\d+)\s+nights?/i.exec(configText)?.[1] || "1", 10) || 1;
  let checkInIso = explicitDateRange?.[1];
  let checkOutIso = explicitDateRange?.[2];

  if (!checkInIso || !checkOutIso) {
    const leadDays =
      Number.parseInt(
        /(\d+)\s+days?\s+(?:from\s+today|in\s+advance)/i.exec(configText)?.[1] ||
          "7",
        10,
      ) || 7;
    const today = new Date();
    const checkIn = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + leadDays,
      12,
    );
    const checkOut = new Date(
      checkIn.getFullYear(),
      checkIn.getMonth(),
      checkIn.getDate() + nights,
      12,
    );
    checkInIso = formatDateIso(checkIn);
    checkOutIso = formatDateIso(checkOut);
  }

  const userCountryCodeMatch =
    /userCountryCode\s*=\s*([A-Z]{2})/i.exec(configText) ||
    /,\s*([A-Z]{2})\s*$/i.exec(configText);

  return {
    adults: /(\d+)\s+adults?/i.exec(configText)?.[1] || "1",
    rooms: /(\d+)\s+rooms?/i.exec(configText)?.[1] || "1",
    children: /(\d+)\s+children?/i.exec(configText)?.[1] || "0",
    checkInIso,
    checkOutIso,
    currency: /\b([A-Z]{3})\b/.exec(configText)?.[1] || "EUR",
    userCountryCode: userCountryCodeMatch?.[1]?.toUpperCase() || "GB",
  };
}

function padTwo(value) {
  return String(value).padStart(2, "0");
}

function formatDateIso(date) {
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(
    date.getDate(),
  )}`;
}

function formatIsoToApiDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${day}-${month}-${year}`;
}

function currencySymbolFor(currency) {
  const symbols = {
    EUR: "€",
    GBP: "£",
    USD: "$",
  };

  return symbols[currency] || currency;
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createPricePatterns(currency, currencySymbol) {
  const amountPattern = "([0-9][0-9,.]*(?:[,.][0-9]{1,2})?)";
  const symbolPattern = regexEscape(currencySymbol);
  const codePattern = regexEscape(currency);

  return {
    prioritized: [
      new RegExp(
        `\\bPrice\\s*${symbolPattern}\\s*${amountPattern}\\s*Includes taxes`,
        "gi",
      ),
      new RegExp(`\\bCurrent price\\s*${symbolPattern}\\s*${amountPattern}`, "gi"),
      new RegExp(
        `\\bTotal\\s*${symbolPattern}\\s*${amountPattern}\\s*Includes taxes`,
        "gi",
      ),
    ],
    fallback: [
      new RegExp(`${symbolPattern}\\s*${amountPattern}`, "g"),
      new RegExp(`\\b${codePattern}\\s*${amountPattern}`, "gi"),
      new RegExp(`${amountPattern}\\s*${codePattern}\\b`, "gi"),
    ],
  };
}

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

const parseHotelsMarkdown = markdown => {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex(line => {
    if (!line.includes("|")) return false;
    const headers = splitMarkdownRow(line).map(header =>
      header.toLowerCase().replace(/[^a-z0-9]/g, ""),
    );

    return (
      headers.includes("hotel") &&
      headers.includes("latitude") &&
      headers.includes("longitude") &&
      headers.includes("bookingcomurl")
    );
  });

  if (headerIndex < 0) {
    throw new Error("Could not find hotel table in hotels.md");
  }

  const headers = splitMarkdownRow(lines[headerIndex]);
  const indexByHeader = new Map();
  headers.forEach((header, index) => {
    indexByHeader.set(header.toLowerCase().replace(/[^a-z0-9]/g, ""), index);
  });

  const getCell = (row, header) => {
    const index = indexByHeader.get(header);
    return index === undefined ? "" : row[index] || "";
  };

  const hotels = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !line.trim()) continue;
    if (!line.trim().startsWith("|")) break;

    const row = splitMarkdownRow(line);
    hotels.push({
      rowNumber: Number.parseInt(getCell(row, ""), 10) || hotels.length + 1,
      hotel: getCell(row, "hotel"),
      location: getCell(row, "location"),
      city: getCell(row, "city"),
      latitude: Number.parseFloat(getCell(row, "latitude")),
      longitude: Number.parseFloat(getCell(row, "longitude")),
      bookingUrl: getCell(row, "bookingcomurl"),
      accommodationServiceId: getCell(row, "accommodationserviceid"),
      providerHotelIdentifier: getCell(row, "providerhotelidentifier"),
    });
  }

  return hotels;
};

const bookingUrlFor = hotel => {
  const url = new URL(hotel.bookingUrl);
  url.searchParams.set("checkin", CHECK_IN_ISO);
  url.searchParams.set("checkout", CHECK_OUT_ISO);
  url.searchParams.set("group_adults", ADULTS);
  url.searchParams.set("no_rooms", ROOMS);
  url.searchParams.set("group_children", CHILDREN);
  url.searchParams.set("selected_currency", CURRENCY);

  return url.toString();
};

const parsePriceTexts = text => {
  const { prioritized, fallback } = createPricePatterns(
    CURRENCY,
    CURRENCY_SYMBOL,
  );
  const prices = [];

  for (const pattern of prioritized) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);

    while (match) {
      const price = parseAmountMatch(match);
      if (price) prices.push(price);
      match = pattern.exec(text);
    }
  }

  if (prices.length > 0) {
    return prices;
  }

  for (const pattern of fallback) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);

    while (match) {
      const price = parseAmountMatch(match);
      if (price) prices.push(price);

      match = pattern.exec(text);
    }
  }

  return prices;
};

const parseAmountMatch = match => {
  const rawAmount = match[1] || "";
  const normalizedAmount =
    rawAmount.includes(",") && !rawAmount.includes(".")
      ? rawAmount.replace(/\./g, "").replace(",", ".")
      : rawAmount.replace(/,/g, "");
  const amount = Number.parseFloat(normalizedAmount);
  const lowestUnitValue = Math.round(amount * 100);

  if (!Number.isFinite(amount) || lowestUnitValue < 5000) {
    return null;
  }

  return {
    display: `${CURRENCY} ${amount.toFixed(2)}`,
    lowestUnitValue,
    match: match[0],
  };
};

const scrapeBookingPrice = async (context, hotel) => {
  const page = await context.newPage();
  const url = bookingUrlFor(hotel);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    for (const name of [
      "Accept",
      "Accept all",
      "Accept cookies",
      "I agree",
      "OK",
    ]) {
      try {
        await page
          .getByRole("button", { name: new RegExp(name, "i") })
          .click({ timeout: 1200 });
        break;
      } catch {
        // Keep trying common consent labels.
      }
    }

    await page.waitForTimeout(10_000);

    const result = await page.evaluate(
      ({ currency, currencySymbol }) => {
        const norm = value => (value || "").replace(/\s+/g, " ").trim();
        const regexEscape = value =>
          value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const visible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();

          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const parsePrices = text => {
          const parseAmountMatch = match => {
            const rawAmount = match[1] || "";
            const normalizedAmount =
              rawAmount.includes(",") && !rawAmount.includes(".")
                ? rawAmount.replace(/\./g, "").replace(",", ".")
                : rawAmount.replace(/,/g, "");
            const amount = Number.parseFloat(normalizedAmount);
            const lowestUnitValue = Math.round(amount * 100);

            if (!Number.isFinite(amount) || lowestUnitValue < 5000) {
              return null;
            }

            return {
              display: `${currency} ${amount.toFixed(2)}`,
              lowestUnitValue,
              match: match[0],
            };
          };
          const amountPattern = "([0-9][0-9,.]*(?:[,.][0-9]{1,2})?)";
          const symbolPattern = regexEscape(currencySymbol);
          const codePattern = regexEscape(currency);
          const prioritizedPatterns = [
            new RegExp(
              `\\bPrice\\s*${symbolPattern}\\s*${amountPattern}\\s*Includes taxes`,
              "gi",
            ),
            new RegExp(
              `\\bCurrent price\\s*${symbolPattern}\\s*${amountPattern}`,
              "gi",
            ),
            new RegExp(
              `\\bTotal\\s*${symbolPattern}\\s*${amountPattern}\\s*Includes taxes`,
              "gi",
            ),
          ];
          const prices = [];

          for (const pattern of prioritizedPatterns) {
            pattern.lastIndex = 0;
            let match = pattern.exec(text);
            while (match) {
              const price = parseAmountMatch(match);
              if (price) prices.push(price);
              match = pattern.exec(text);
            }
          }

          if (prices.length > 0) {
            return prices;
          }

          const patterns = [
            new RegExp(`${symbolPattern}\\s*${amountPattern}`, "g"),
            new RegExp(`\\b${codePattern}\\s*${amountPattern}`, "gi"),
            new RegExp(`${amountPattern}\\s*${codePattern}\\b`, "gi"),
          ];

          for (const pattern of patterns) {
            let match = pattern.exec(text);
            while (match) {
              const price = parseAmountMatch(match);
              if (price) prices.push(price);

              match = pattern.exec(text);
            }
          }

          return prices;
        };
        const roots = [
          document.querySelector("#hprt-table"),
          document.querySelector('[data-testid="availability-table"]'),
          document.querySelector("#availability_target"),
          ...[...document.querySelectorAll("table, div")]
            .filter(element => {
              const text = norm(element.textContent);
              return (
                /Room type/i.test(text) &&
                /(Today.s price|Your choices|Select rooms|Price)/i.test(text)
              );
            })
            .slice(0, 2),
        ].filter(Boolean);
        const root = roots[0];

        if (!root) {
          return {
            price: null,
            reason: "availability_table_not_found",
            url: location.href,
            title: document.title,
          };
        }

        const selectors = [
          ".hprt-price-price-standard",
          ".prco-valign-middle-helper",
          "td.hprt-table-cell-price",
          '[data-testid="price-and-discounted-price"]',
          '[data-testid="availability-rate-wrapper"]',
        ];
        let nodes = [...root.querySelectorAll(selectors.join(","))].filter(
          visible,
        );

        if (nodes.length === 0) {
          const currencyPattern = new RegExp(
            `${regexEscape(currencySymbol)}|\\b${regexEscape(currency)}\\b`,
            "i",
          );
          nodes = [...root.querySelectorAll("tr, td, div, span")].filter(
            element => visible(element) && currencyPattern.test(norm(element.textContent)),
          );
        }

        const roomNameFor = element => {
          const row = element.closest("tr");
          const room = row?.querySelector(
            '.hprt-roomtype-icon-link,.hprt-roomtype-link,[data-testid="room-name"],a[href*="RD"]',
          );

          return norm(room?.textContent) || undefined;
        };
        const candidates = [];

        for (const node of nodes) {
          const text = norm(node.textContent);
          for (const price of parsePrices(text)) {
            candidates.push({
              ...price,
              sourceText: text.slice(0, 300),
              roomName: roomNameFor(node),
            });
          }
        }

        if (candidates.length === 0) {
          const currencyPattern = new RegExp(
            `${regexEscape(currencySymbol)}|\\b${regexEscape(currency)}\\b`,
            "i",
          );
          const lines = (root.innerText || "")
            .split(/\n+/)
            .map(norm)
            .filter(line => currencyPattern.test(line));

          for (const line of lines) {
            for (const price of parsePrices(line)) {
              candidates.push({
                ...price,
                sourceText: line.slice(0, 300),
              });
            }
          }
        }

        candidates.sort((left, right) => left.lowestUnitValue - right.lowestUnitValue);

        return {
          price: candidates[0] || null,
          candidateCount: candidates.length,
          url: location.href,
          title: document.title,
          reason: null,
        };
      },
      { currency: CURRENCY, currencySymbol: CURRENCY_SYMBOL },
    );

    return {
      value: result.price?.lowestUnitValue,
      display: result.price?.display,
      roomName: result.price?.roomName,
      sourceText: result.price?.sourceText,
      candidateCount: result.candidateCount || 0,
      url: result.url,
      warning: result.reason || (result.price ? undefined : "booking_price_unavailable"),
    };
  } catch (error) {
    return {
      value: undefined,
      display: undefined,
      warning: `booking_failed:${error.message}`,
      url,
    };
  } finally {
    await page.close();
  }
};

const accommodationUrlFor = hotel => {
  const url = new URL(
    "https://www.omio.com/accommodations-service/accommodations/search/stream",
  );
  url.searchParams.set("adults", ADULTS);
  url.searchParams.set("checkIn", CHECK_IN_API);
  url.searchParams.set("checkOut", CHECK_OUT_API);
  url.searchParams.set("children", CHILDREN);
  url.searchParams.set("currency", CURRENCY);
  url.searchParams.set("latitude", String(hotel.latitude));
  url.searchParams.set("locale", "en");
  url.searchParams.set("longitude", String(hotel.longitude));
  url.searchParams.set("page", "1");
  url.searchParams.set("pageSize", PAGE_SIZE);
  url.searchParams.set("rooms", ROOMS);
  url.searchParams.set("userCountryCode", USER_COUNTRY_CODE);

  return url.toString();
};

const parseAccommodationStream = streamText => {
  const accommodations = [];
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) return;

    const data = dataLines.join("\n");
    dataLines = [];

    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed.accommodations)) {
        accommodations.push(...parsed.accommodations);
      }
    } catch {
      // Ignore non-accommodation status events.
    }
  };

  for (const line of streamText.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();

  return accommodations;
};

const providerIdFromRateKey = rateKey => {
  const value = (rateKey || "").split("|")[4]?.trim();
  return /^\d+$/.test(value || "") ? value : undefined;
};

const providerIdForAccommodation = accommodation => {
  if (accommodation.providerHotelIdentifier) {
    return String(accommodation.providerHotelIdentifier);
  }

  for (const room of accommodation.rooms || []) {
    for (const offer of room.offers || []) {
      const providerId = providerIdFromRateKey(offer.rateKey);
      if (providerId) return providerId;
    }
  }

  return undefined;
};

const findExactAccommodation = (accommodations, hotel) => {
  const expectedProviderId = String(hotel.providerHotelIdentifier || "").trim();

  if (expectedProviderId) {
    const providerMatch = accommodations.find(
      accommodation => providerIdForAccommodation(accommodation) === expectedProviderId,
    );

    if (providerMatch) return providerMatch;
  }

  const expectedName = normalizeText(hotel.hotel).toLowerCase();
  return (
    accommodations.find(
      accommodation => normalizeText(accommodation.name).toLowerCase() === expectedName,
    ) || null
  );
};

const cheapestOfferFor = accommodation => {
  let cheapest = null;

  for (const room of accommodation.rooms || []) {
    for (const offer of room.offers || []) {
      const price =
        offer.totalPriceBundle?.displayPrice ||
        offer.totalNetPrice?.displayPrice ||
        offer.totalPriceBundle?.providerPrice ||
        offer.totalPriceBundle?.paymentPrice;

      if (
        !price ||
        price.currency !== CURRENCY ||
        !Number.isFinite(price.lowestUnitValue) ||
        price.lowestUnitValue <= 0
      ) {
        continue;
      }

      if (!cheapest || price.lowestUnitValue < cheapest.value) {
        cheapest = {
          value: price.lowestUnitValue,
          display: formatMoney(price.lowestUnitValue),
          roomName: room.name,
          rateKey: offer.rateKey,
          boardCode: offer.boardCode,
          boardName: offer.boardName,
        };
      }
    }
  }

  return cheapest;
};

const fetchAccommodationPrice = async hotel => {
  const url = accommodationUrlFor(hotel);

  const response = await fetch(url, {
    headers: {
      Accept: "text/event-stream",
      "Accept-Language": "en-GB,en;q=0.9",
      "Cache-Control": "no-cache",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    return {
      value: undefined,
      display: undefined,
      warning: `omio_http_${response.status}`,
      url,
    };
  }

  const accommodations = parseAccommodationStream(await response.text());
  const accommodation = findExactAccommodation(accommodations, hotel);

  if (!accommodation) {
    return {
      value: undefined,
      display: undefined,
      warning: "omio_exact_hotel_not_found",
      url,
      resultCount: accommodations.length,
    };
  }

  const offer = cheapestOfferFor(accommodation);

  if (!offer) {
    return {
      value: undefined,
      display: undefined,
      warning: "omio_price_unavailable",
      url,
      resultCount: accommodations.length,
      accommodationId: accommodation.id,
      accommodationName: accommodation.name,
      providerHotelIdentifier: providerIdForAccommodation(accommodation),
    };
  }

  return {
    ...offer,
    url,
    resultCount: accommodations.length,
    accommodationId: accommodation.id,
    accommodationName: accommodation.name,
    providerHotelIdentifier: providerIdForAccommodation(accommodation),
  };
};

const formatMoney = value =>
  value === undefined ? "" : `${CURRENCY} ${(value / 100).toFixed(2)}`;

const formatSignedMoney = value => {
  if (value === undefined) return "";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatMoney(value)}`;
};

const csvCell = value => {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const cheaperSupplier = (bookingValue, omioValue) => {
  if (!bookingValue || !omioValue) return "n/a";
  if (bookingValue === omioValue) return "Tie";
  return bookingValue < omioValue ? "Booking.com" : "Omio/HBX";
};

const main = async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const hotels = parseHotelsMarkdown(HOTELS_MARKDOWN);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-GB",
    timezoneId: "Europe/London",
    viewport: { width: 1440, height: 1200 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  const rows = [];
  console.log(
    `Config: ${CHECK_IN_ISO} to ${CHECK_OUT_ISO}, ${ADULTS} adult(s), ${CHILDREN} child(ren), ${ROOMS} room(s), ${CURRENCY}, userCountryCode=${USER_COUNTRY_CODE}`,
  );

  for (const hotel of hotels) {
    console.log(`Checking ${hotel.rowNumber}. ${hotel.hotel}`);
    const booking = await scrapeBookingPrice(context, hotel);
    const omio = await fetchAccommodationPrice(hotel);
    const delta =
      booking.value !== undefined && omio.value !== undefined
        ? omio.value - booking.value
        : undefined;
    const warnings = [booking.warning, omio.warning].filter(Boolean).join(";");

    rows.push({
      rowNumber: hotel.rowNumber,
      hotel: hotel.hotel,
      location: hotel.location,
      city: hotel.city,
      latitude: hotel.latitude,
      longitude: hotel.longitude,
      bookingUrl: booking.url || bookingUrlFor(hotel),
      bookingPrice: booking.display || "",
      bookingLowestUnitValue: booking.value,
      bookingRoomName: booking.roomName || "",
      bookingSourceText: booking.sourceText || "",
      bookingCandidateCount: booking.candidateCount || 0,
      omioUrl: omio.url,
      omioPrice: omio.display || "",
      omioLowestUnitValue: omio.value,
      omioAccommodationId: omio.accommodationId || "",
      omioProviderHotelIdentifier: omio.providerHotelIdentifier || "",
      omioAccommodationName: omio.accommodationName || "",
      omioRoomName: omio.roomName || "",
      omioRateKey: omio.rateKey || "",
      cheaperSupplier: cheaperSupplier(booking.value, omio.value),
      delta: formatSignedMoney(delta),
      deltaLowestUnitValue: delta,
      warnings,
    });
  }

  await context.close();
  await browser.close();

  const header = [
    "row_number",
    "hotel",
    "location",
    "city",
    "latitude",
    "longitude",
    "check_in",
    "check_out",
    "adults",
    "children",
    "rooms",
    "currency",
    "user_country_code",
    "booking_url",
    "booking_price",
    "booking_lowest_unit_value",
    "booking_room_name",
    "booking_source_text",
    "booking_candidate_count",
    "omio_url",
    "omio_price",
    "omio_lowest_unit_value",
    "omio_accommodation_id",
    "omio_provider_hotel_identifier",
    "omio_accommodation_name",
    "omio_room_name",
    "omio_rate_key",
    "cheaper_supplier",
    "delta_omio_minus_booking",
    "delta_omio_minus_booking_lowest_unit_value",
    "warnings",
  ];
  const csvRows = rows.map(row =>
    [
      row.rowNumber,
      row.hotel,
      row.location,
      row.city,
      row.latitude,
      row.longitude,
      CHECK_IN_ISO,
      CHECK_OUT_ISO,
      ADULTS,
      CHILDREN,
      ROOMS,
      CURRENCY,
      USER_COUNTRY_CODE,
      row.bookingUrl,
      row.bookingPrice,
      row.bookingLowestUnitValue,
      row.bookingRoomName,
      row.bookingSourceText,
      row.bookingCandidateCount,
      row.omioUrl,
      row.omioPrice,
      row.omioLowestUnitValue,
      row.omioAccommodationId,
      row.omioProviderHotelIdentifier,
      row.omioAccommodationName,
      row.omioRoomName,
      row.omioRateKey,
      row.cheaperSupplier,
      row.delta,
      row.deltaLowestUnitValue,
      row.warnings,
    ].map(csvCell).join(","),
  );

  const csv = `${header.join(",")}\n${csvRows.join("\n")}\n`;
  fs.writeFileSync(path.join(OUTPUT_DIR, "comparison.csv"), csv);
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "comparison.json"),
    JSON.stringify(rows, null, 2),
  );

  console.log(`Wrote ${path.join(OUTPUT_DIR, "comparison.csv")}`);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
