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
const ACCOMMODATIONS_BASE_URL =
  "https://www.omio.com/accommodations-service";
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

const omioHeaders = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-GB,en;q=0.9",
  "Cache-Control": "no-cache",
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

const geoUrlFor = hotel => {
  const url = new URL(`${ACCOMMODATIONS_BASE_URL}/accommodations/geo`);
  url.searchParams.set("lat", String(hotel.latitude));
  url.searchParams.set("lng", String(hotel.longitude));
  url.searchParams.set("radius", "20");
  url.searchParams.set("radiusUnit", "km");
  url.searchParams.set("limit", PAGE_SIZE);
  url.searchParams.set("sort", "distance");
  url.searchParams.set("hasImages", "true");
  url.searchParams.set("locale", "en");

  return url.toString();
};

const availabilityUrl = `${ACCOMMODATIONS_BASE_URL}/accommodations/availability`;

const buildOccupancies = () => {
  const requestedAdults = Number.parseInt(ADULTS, 10) || 1;
  const requestedChildren = Number.parseInt(CHILDREN, 10) || 0;
  const requestedRooms = Number.parseInt(ROOMS, 10) || 1;
  const roomCount = Math.max(1, Math.min(requestedRooms, requestedAdults || 1));
  const adultsPerRoom = Math.floor(requestedAdults / roomCount);
  const extraAdults = requestedAdults % roomCount;
  const childrenPerRoom = Math.floor(requestedChildren / roomCount);
  const extraChildren = requestedChildren % roomCount;

  return Array.from({ length: roomCount }, (_, index) => ({
    adults: adultsPerRoom + (index < extraAdults ? 1 : 0),
    childrenAges: Array.from(
      {
        length: childrenPerRoom + (index < extraChildren ? 1 : 0),
      },
      () => 0,
    ),
  }));
};

const AVAILABILITY_OCCUPANCIES = buildOccupancies();

const hotelNameTokens = value =>
  normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => !["a", "an", "by", "hotel", "the"].includes(token));

const canonicalHotelName = value =>
  [...new Set(hotelNameTokens(value))].sort().join(" ");

const hotelNameSimilarity = (leftName, rightName) => {
  const leftTokens = hotelNameTokens(leftName);
  const rightTokens = hotelNameTokens(rightName);

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const rightTokenSet = new Set(rightTokens);
  const overlap = leftTokens.filter(token => rightTokenSet.has(token)).length;

  return overlap / Math.max(leftTokens.length, rightTokens.length);
};

const findAccommodationByName = (accommodations, hotel) => {
  const expectedName = normalizeText(hotel.hotel).toLowerCase();
  const exactMatch = accommodations.find(
    accommodation => normalizeText(accommodation.name).toLowerCase() === expectedName,
  );

  if (exactMatch) return exactMatch;

  const expectedCanonicalName = canonicalHotelName(hotel.hotel);
  const canonicalMatch = accommodations.find(
    accommodation => canonicalHotelName(accommodation.name) === expectedCanonicalName,
  );

  if (canonicalMatch) return canonicalMatch;

  const rankedCandidates = accommodations
    .map(accommodation => ({
      accommodation,
      similarity: hotelNameSimilarity(hotel.hotel, accommodation.name),
    }))
    .filter(candidate => candidate.similarity >= 0.8)
    .sort((left, right) => right.similarity - left.similarity);

  if (
    rankedCandidates[0] &&
    (!rankedCandidates[1] ||
      rankedCandidates[0].similarity > rankedCandidates[1].similarity)
  ) {
    return rankedCandidates[0].accommodation;
  }

  return null;
};

const findGeoHotel = (geoHotels, hotel) => {
  const expectedHotelId = String(hotel.providerHotelIdentifier || "").trim();

  if (expectedHotelId) {
    const idMatch = geoHotels.find(
      geoHotel => String(geoHotel.hotelId || "").trim() === expectedHotelId,
    );

    if (idMatch) return idMatch;
  }

  return findAccommodationByName(geoHotels, hotel);
};

const fetchGeoHotels = async hotel => {
  const url = geoUrlFor(hotel);
  const response = await fetch(url, {
    headers: omioHeaders,
  });

  if (!response.ok) {
    return {
      hotels: [],
      url,
      warning: `omio_geo_http_${response.status}`,
    };
  }

  const hotels = await response.json();

  return {
    hotels: Array.isArray(hotels) ? hotels : [],
    url,
  };
};

const fetchAvailability = async hotelId => {
  const response = await fetch(availabilityUrl, {
    method: "POST",
    headers: omioHeaders,
    body: JSON.stringify({
      hotelIds: [hotelId],
      checkIn: CHECK_IN_API,
      checkOut: CHECK_OUT_API,
      occupancies: AVAILABILITY_OCCUPANCIES,
      currency: CURRENCY,
      locale: "en",
      userCountryCode: USER_COUNTRY_CODE,
    }),
  });

  if (!response.ok) {
    return {
      warning: `omio_http_${response.status}`,
      entries: [],
    };
  }

  const entries = await response.json();
  return {
    entries: Array.isArray(entries) ? entries : [],
  };
};

const parseAvailabilityEntry = (entry, fallbackHotel) => {
  const price =
    entry.minRatePrice?.displayPrice ||
    entry.minRatePrice?.providerPrice ||
    entry.minRatePrice?.paymentPrice;

  if (!entry.available) {
    return {
      value: undefined,
      display: undefined,
      warning: "omio_price_unavailable",
      accommodationId: entry.accommodationId,
      accommodationName: fallbackHotel?.name || "",
      providerHotelIdentifier: String(entry.hotelId || ""),
    };
  }

  if (
    !price ||
    price.currency !== CURRENCY ||
    !Number.isFinite(price.lowestUnitValue) ||
    price.lowestUnitValue <= 0
  ) {
    return {
      value: undefined,
      display: undefined,
      warning: "omio_price_unavailable",
      accommodationId: entry.accommodationId,
      accommodationName: fallbackHotel?.name || "",
      providerHotelIdentifier: String(entry.hotelId || ""),
    };
  }

  return {
    value: price.lowestUnitValue,
    display: formatMoney(price.lowestUnitValue),
    roomName: entry.cheapestOffer?.roomName || "",
    rateKey: entry.cheapestOffer?.rateKey || "",
    boardCode: entry.cheapestOffer?.boardCode || "",
    boardName: entry.cheapestOffer?.boardName || "",
    accommodationId: entry.accommodationId || "",
    accommodationName: fallbackHotel?.name || "",
    providerHotelIdentifier: String(entry.hotelId || ""),
  };
};

const fetchAccommodationPrice = async hotel => {
  const configuredHotelId = Number.parseInt(
    String(hotel.providerHotelIdentifier || "").trim(),
    10,
  );
  const candidateHotelIds = [];
  if (Number.isFinite(configuredHotelId)) {
    candidateHotelIds.push(configuredHotelId);
  }
  let geoHotel = null;
  let geoUrl = "";
  let mustResolveViaGeo = candidateHotelIds.length === 0;

  if (mustResolveViaGeo) {
    const geoResult = await fetchGeoHotels(hotel);
    geoUrl = geoResult.url;

    if (geoResult.warning) {
      return {
        value: undefined,
        display: undefined,
        warning: geoResult.warning,
        url: geoUrl,
      };
    }

    geoHotel = findGeoHotel(geoResult.hotels, hotel);

    if (!geoHotel) {
      return {
        value: undefined,
        display: undefined,
        warning: "omio_exact_hotel_not_found",
        url: geoUrl,
        resultCount: geoResult.hotels.length,
      };
    }

    candidateHotelIds.push(geoHotel.hotelId);
  } else {
    geoHotel = { hotelId: configuredHotelId, name: hotel.hotel };
  }

  let availabilityResult = await fetchAvailability(candidateHotelIds[0]);
  let selectedHotelId = candidateHotelIds[0];

  if (
    !availabilityResult.warning &&
    !availabilityResult.entries.some(
      item => Number(item.hotelId) === Number(selectedHotelId),
    )
  ) {
    mustResolveViaGeo = true;
  }

  if (mustResolveViaGeo && !geoUrl) {
    const geoResult = await fetchGeoHotels(hotel);
    geoUrl = geoResult.url;

    if (geoResult.warning) {
      return {
        value: undefined,
        display: undefined,
        warning: geoResult.warning,
        url: geoUrl,
      };
    }

    geoHotel = findGeoHotel(geoResult.hotels, hotel);

    if (!geoHotel) {
      return {
        value: undefined,
        display: undefined,
        warning: "omio_exact_hotel_not_found",
        url: geoUrl,
        resultCount: geoResult.hotels.length,
      };
    }

    selectedHotelId = geoHotel.hotelId;
    if (selectedHotelId !== candidateHotelIds[0]) {
      availabilityResult = await fetchAvailability(selectedHotelId);
    }
  }

  const url =
    `${availabilityUrl}?hotelId=${selectedHotelId}` +
    (geoUrl ? `&source=geo` : "");

  if (availabilityResult.warning) {
    return {
      value: undefined,
      display: undefined,
      warning: availabilityResult.warning,
      url,
    };
  }

  const entry = availabilityResult.entries.find(
    item => Number(item.hotelId) === Number(selectedHotelId),
  );

  if (!entry) {
    return {
      value: undefined,
      display: undefined,
      warning: "omio_exact_hotel_not_found",
      url,
      resultCount: availabilityResult.entries.length,
    };
  }

  return {
    ...parseAvailabilityEntry(entry, geoHotel),
    url,
    resultCount: availabilityResult.entries.length,
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
