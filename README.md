# MP+Z screener

Scans Binance USDT-M futures (top 150 by 24h volume) every 15 minutes for setups matching the market-profile + volume Z-score logic from your Pine indicator. Dashboard shows the latest signals; click through to TradingView to confirm before any trade.

## What it detects

A bar qualifies as a signal when **all** are true:

1. The bar's volume is at least Large (Z ≥ 1.5) vs the trailing 24-bar window.
2. The bar is directional: bullish bar (close > open) for a long, bearish for a short.
3. The bar's wick comes within 2 profile-ticks of one of: current day's POC / VAL (long) or POC / VAH (short), OR the previous day's same levels.
4. The bar closed in the direction of the rejection (i.e., bullish bar that wicked into VAL and closed back above it = long candidate).

Signals are then enriched with confluence flags: near day VWAP, near previous-day high/low. Ranking is by Z-level descending, then confluence count, then raw Z.

This mirrors the `long_signal` / `short_signal` lines of `market_profile_tpo_v6_vwap_cloud_bands.pine` faithfully — same half-open TPO interval logic, same CBOT value-area builder, same Z thresholds.

## How to read the dashboard

- **TF**: candle timeframe that produced the signal.
- **Side**: long means a bullish rejection from support-like levels; short means a bearish rejection from resistance-like levels.
- **Z**: volume abnormality on the trigger candle. `LG` is large volume, `EX` is extreme volume.
- **Trigger**: the market-profile level touched by the trigger candle wick. `PREV_` means the level comes from the previous UTC day.
- **Level touched**: the exact price of that trigger level.
- **Bar close**: the close price of the trigger candle. For a long, the candle should reject upward from the touched level; for a short, it should reject downward.
- **Confluence**: optional extra context such as VWAP, previous-day high, or previous-day low.

Signals are only treated as actionable for one candle after the trigger candle closes. The dashboard keeps the latest scan in storage, but hides expired signals automatically on refresh so old setups do not look fresh.

## What it does not do

- **No backtest.** The screener tells you "this setup exists right now" not "this setup has worked historically." That's the next thing to add. Until then, paper-trade or size very small.
- **No execution.** Manual entry through your exchange or broker after eyeballing the chart.
- **No weekly VWAP or full session-VWAP (Asian/London/US).** The Pine version has these as confluence; the screener uses 24hr session by default (which matches Pine's `session_option_24hr` for crypto). Easy to extend later.
- **Top 150 only by default.** Illiquid alts have noisy profiles and produce false signals. Bump `SYMBOL_LIMIT` if you want to scan more — be aware of the 60s timeout.

## Deploy

### 1. Provision Upstash Redis (free)

Sign up at upstash.com, create a Redis database, copy the REST URL and REST token.

### 2. Push to GitHub, import into Vercel

Standard Next.js deploy. Vercel auto-detects the framework.

### 3. Set env vars in Vercel

```
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=...
CRON_SECRET=<openssl rand -hex 32>
```

### 4. Cron

`vercel.json` schedules `/api/cron/scan` every 15 minutes. Requires Vercel Pro for sub-daily crons.

**Hobby tier alternative:** delete the `crons` block from `vercel.json`, then set up a free cron at cron-job.org pointing to:

```
GET https://your-app.vercel.app/api/cron/scan
Header: Authorization: Bearer <your CRON_SECRET>
```

### 5. Trigger the first scan manually

After deploy:

```
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/scan
```

The response tells you how many signals were found and how long the scan took. Then load the dashboard.

## Local dev

```bash
npm install
cp .env.example .env.local
# fill in env vars
npm run dev
```

Open http://localhost:3000. Trigger a scan with:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/scan
```

## Architecture

```
Binance fapi  →  Vercel cron (every 15m)  →  Upstash Redis  →  Next.js dashboard
```

The cron endpoint fans out fetches with concurrency 20, runs signal detection in-process, and writes a single `mpz:scan:latest` key to Redis. The dashboard polls `/api/signals` every 60s and reads that key.

## Honest expectations

The Z-volume-bar-at-value-area-edge setup has historically had a hit rate in the 45–55% range on crypto perps (based on similar published studies, not this exact implementation). That's tradeable with discipline (positive expectancy at ~1.5:1 R:R or better) but not a slot machine. Before sizing up:

1. Run the screener for at least 2 weeks. Manually grade signals as win/loss/scratch on paper.
2. Add the backtest harness (planned next).
3. Only after seeing a real expectancy number should real money go on it, and even then small fractional-Kelly sizing.

If you're using this to address debt pressure, please re-read that paragraph.
