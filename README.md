# Hotel Price Benchmark

Compares Booking.com displayed hotel prices with the lowest exact-hotel offer returned by Omio's accommodations service.

## What's Included

- `hotels.md` is the benchmark config and hotel list.
- `scripts/booking-omio-compare.js` refreshes Booking.com and Omio/HBX prices.
- `dashboard/` serves a local dashboard with a refresh CTA.
- `runs/booking-omio-2026-05-14-2026-05-15/` contains the latest generated comparison included at repo creation time.

## Setup

```bash
npm install
npm run install:browsers
```

## Run The Dashboard

```bash
npm start
```

Open the printed local URL, usually:

```text
http://127.0.0.1:4317
```

Use **Refresh prices** in the dashboard to run a new comparison.

## Run A Refresh From The CLI

```bash
npm run refresh
```

The script writes:

```text
runs/booking-omio-<check-in>-<check-out>/comparison.csv
runs/booking-omio-<check-in>-<check-out>/comparison.json
```

## Date Configuration

The run dates come from the `_Config:_` line in `hotels.md`.

The current config uses a rolling search: 1 night, 7 days in advance. If you run it tomorrow, the check-in and check-out dates move forward automatically.

## Notes

- Booking.com prices are collected with Playwright.
- Omio/HBX prices are collected directly from the accommodations service API.
- Exact Omio/HBX hotel matching uses the provider hotel identifier first, then exact normalized hotel name.
