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

After a successful dashboard refresh, the server automatically exports the static GitHub Pages snapshot, commits `docs/` and `runs/`, and pushes the update to `main`.

To disable automatic publishing for a local run:

```bash
AUTO_PUBLISH_ON_REFRESH=0 npm start
```

## Run A Refresh From The CLI

```bash
npm run refresh
```

The script writes:

```text
runs/booking-omio-<check-in>-<check-out>/comparison.csv
runs/booking-omio-<check-in>-<check-out>/comparison.json
```

## Publish The Static Management Page

GitHub Pages serves the read-only dashboard from `docs/`.

```bash
npm run export
git add docs runs
git commit -m "Update benchmark snapshot"
git push
```

After GitHub Pages is enabled, the shareable link is:

```text
https://shikhabansal-sketch.github.io/hotel-price-benchmark/
```

The URL stays the same. It shows new data after you refresh prices in the local dashboard and the automatic publish step finishes.

For a full local refresh and publish in one command:

```bash
npm run publish
```

## Date Configuration

The run dates come from the `_Config:_` line in `hotels.md`.

The current config uses a rolling search: 1 night, 7 days in advance. If you run it tomorrow, the check-in and check-out dates move forward automatically.

## Notes

- Booking.com prices are collected with Playwright.
- Omio/HBX prices are collected directly from the accommodations service API.
- Exact Omio/HBX hotel matching uses the provider hotel identifier first, then exact normalized hotel name.
