import type { Kline, Timeframe } from "./types";

// Binance USDT-M futures public REST. No API key required for these endpoints.
// Base URL must be fapi.binance.com (NOT api.binance.com, which is spot).
const FAPI_BASE = "https://fapi.binance.com";

// Rate-limit budget for the futures market endpoints:
//   - 2400 request weight per minute per IP
//   - klines endpoint: weight 1 for ≤100 bars, 2 for 100–500, 5 for 500–1000, 10 for 1000+
// We fetch 200 bars per call (weight 2). 150 symbols × 3 timeframes = 450 calls × 2 = 900 weight.
// Comfortably under 2400/min, but we'll throttle with a concurrency limit to avoid bursts.

const TIMEFRAME_TO_INTERVAL: Record<Timeframe, string> = {
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "4h": "4h",
};

// We need enough history to:
//   - cover the current UTC day (up to 96 × 15m = 96 bars)
//   - cover the previous UTC day (another 96 bars)
//   - have at least Z_LENGTH=24 bars for the Z-score baseline before the trigger bar
// 200 bars is comfortably enough for 15m (50 hours), 30m (100 hours), and 1H (8+ days).
const BARS_PER_FETCH = 200;

export interface FetchKlinesError extends Error {
  symbol: string;
  timeframe: Timeframe;
  status?: number;
}

export async function fetchKlines(
  symbol: string,
  timeframe: Timeframe,
  signal?: AbortSignal,
  opts?: { endTime?: number; limit?: number }
): Promise<Kline[]> {
  const interval = TIMEFRAME_TO_INTERVAL[timeframe];
  const limit = opts?.limit ?? BARS_PER_FETCH;
  const endTime = opts?.endTime !== undefined ? `&endTime=${opts.endTime}` : "";
  const url = `${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}${endTime}`;

  let res: Response;
  try {
    res = await fetch(url, { signal, cache: "no-store" });
  } catch (e) {
    const err = new Error(`Network error: ${(e as Error).message}`) as FetchKlinesError;
    err.symbol = symbol;
    err.timeframe = timeframe;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`Binance ${res.status}: ${await res.text().catch(() => "")}`) as FetchKlinesError;
    err.symbol = symbol;
    err.timeframe = timeframe;
    err.status = res.status;
    throw err;
  }

  const raw = (await res.json()) as unknown[][];
  // Binance kline tuple format:
  // [openTime, open, high, low, close, volume, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, ignore]
  const klines: Kline[] = raw.map((r) => ({
    openTime: r[0] as number,
    open: parseFloat(r[1] as string),
    high: parseFloat(r[2] as string),
    low: parseFloat(r[3] as string),
    close: parseFloat(r[4] as string),
    volume: parseFloat(r[5] as string),
    closeTime: r[6] as number,
    takerBuyVolume: parseFloat(r[9] as string),
  }));

  // IMPORTANT: drop the last bar if it's still in progress (closeTime > now).
  // We only signal on closed bars — Pine evaluates on bar close too.
  const now = Date.now();
  if (klines.length > 0 && klines[klines.length - 1].closeTime > now) {
    klines.pop();
  }
  return klines;
}

interface TickerStats {
  symbol: string;
  quoteVolume: number;
}

// Fetch 24h ticker stats for all symbols, used to pick the top-N by quote volume.
// quoteVolume is in USDT — directly comparable across symbols. Weight: 40 (single
// call), so this is cheap.
export async function fetchTopSymbolsByVolume(
  limit: number,
  signal?: AbortSignal
): Promise<string[]> {
  const url = `${FAPI_BASE}/fapi/v1/ticker/24hr`;
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) {
    throw new Error(`ticker/24hr failed: ${res.status}`);
  }
  const data = (await res.json()) as Array<{
    symbol: string;
    quoteVolume: string;
    status?: string;
  }>;
  // Filter to perpetuals quoted in USDT and trading (PERPETUAL contracts, not delivery).
  const usdtPairs: TickerStats[] = data
    .filter((d) => d.symbol.endsWith("USDT"))
    .map((d) => ({ symbol: d.symbol, quoteVolume: parseFloat(d.quoteVolume) }))
    .filter((d) => isFinite(d.quoteVolume) && d.quoteVolume > 0);

  usdtPairs.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return usdtPairs.slice(0, limit).map((d) => d.symbol);
}

export interface LongShortRatioInfo {
  longShortRatio: number; // longAccount / shortAccount; >1 = more longs, <1 = more shorts
  longAccount: number;    // fraction of accounts holding longs (0–1)
  shortAccount: number;   // fraction of accounts holding shorts (0–1)
}

// Global long/short account ratio for a single symbol. Weight: 1.
// Called only for symbols that already have a confirmed signal.
export async function fetchLongShortRatio(
  symbol: string,
  signal?: AbortSignal
): Promise<LongShortRatioInfo | null> {
  const url = `${FAPI_BASE}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`;
  let res: Response;
  try {
    res = await fetch(url, { signal, cache: "no-store" });
  } catch { return null; }
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{
    longShortRatio: string;
    longAccount: string;
    shortAccount: string;
  }>;
  if (!data.length) return null;
  const d = data[0];
  return {
    longShortRatio: parseFloat(d.longShortRatio),
    longAccount:    parseFloat(d.longAccount),
    shortAccount:   parseFloat(d.shortAccount),
  };
}

export interface OISnapshot {
  openInterest: number; // sumOpenInterest in base asset
  timestamp: number;
}

// Fetch recent OI history for a single symbol. Period matches the entry timeframe
// so each data point corresponds to one candle. Weight: 1 per call.
// Note: endpoint lives under /futures/data/, not /fapi/v1/.
export async function fetchOIHistory(
  symbol: string,
  limit = 4,
  signal?: AbortSignal
): Promise<OISnapshot[]> {
  const url = `${FAPI_BASE}/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=${limit}`;
  let res: Response;
  try {
    res = await fetch(url, { signal, cache: "no-store" });
  } catch (e) {
    throw new Error(`Network error fetching OI history for ${symbol}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`OI history failed for ${symbol}: ${res.status}`);
  const data = (await res.json()) as Array<{
    symbol: string;
    sumOpenInterest: string;
    sumOpenInterestValue: string;
    timestamp: number;
  }>;
  return data.map((d) => ({
    openInterest: parseFloat(d.sumOpenInterest),
    timestamp: d.timestamp,
  }));
}

export interface FundingRateInfo {
  lastFundingRate: number; // decimal, e.g. 0.0001 = +0.01% per 8h; positive = longs pay
  markPrice: number;
  nextFundingTime: number;
}

// Single call (weight 10) that returns current funding rate + mark price for every
// USDT-M perpetual. Much cheaper than per-symbol calls.
export async function fetchFundingRates(signal?: AbortSignal): Promise<Map<string, FundingRateInfo>> {
  const url = `${FAPI_BASE}/fapi/v1/premiumIndex`;
  let res: Response;
  try {
    res = await fetch(url, { signal, cache: "no-store" });
  } catch (e) {
    throw new Error(`Network error fetching premiumIndex: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`premiumIndex failed: ${res.status}`);
  const data = (await res.json()) as Array<{
    symbol: string;
    markPrice: string;
    lastFundingRate: string;
    nextFundingTime: number;
  }>;
  const map = new Map<string, FundingRateInfo>();
  for (const d of data) {
    if (!d.symbol.endsWith("USDT")) continue;
    const fr = parseFloat(d.lastFundingRate);
    if (!isFinite(fr)) continue;
    map.set(d.symbol, {
      lastFundingRate: fr,
      markPrice: parseFloat(d.markPrice),
      nextFundingTime: d.nextFundingTime,
    });
  }
  return map;
}

// Fetch current mark prices for all USDT-M perpetuals (reuses premiumIndex, weight 10).
// Returns a map of symbol → mark price.
export async function fetchMarkPrices(): Promise<Map<string, number>> {
  const url = `${FAPI_BASE}/fapi/v1/premiumIndex`;
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (e) {
    throw new Error(`Network error fetching mark prices: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`premiumIndex failed: ${res.status}`);
  const data = (await res.json()) as Array<{ symbol: string; markPrice: string }>;
  const map = new Map<string, number>();
  for (const d of data) {
    if (!d.symbol.endsWith("USDT")) continue;
    const price = parseFloat(d.markPrice);
    if (isFinite(price) && price > 0) map.set(d.symbol, price);
  }
  return map;
}

// ─── Historical lookups (backfill) ───────────────────────────────────────────
// These mirror the live-scan data sources but accept a point in time, so rows
// logged before an enrichment column existed can be filled retroactively.

// Settled funding rate closest before `atMs` (events every 8h, full history).
// Approximates the predicted rate the scan would have seen at that moment.
export async function fetchFundingRateAt(symbol: string, atMs: number): Promise<number | null> {
  const start = atMs - 9 * 60 * 60 * 1000; // covers at least one 8h funding event
  const url = `${FAPI_BASE}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${start}&endTime=${atMs}&limit=5`;
  let res: Response;
  try { res = await fetch(url, { cache: "no-store" }); } catch { return null; }
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ fundingRate: string; fundingTime: number }>;
  if (!data.length) return null;
  const fr = parseFloat(data[data.length - 1].fundingRate);
  return isFinite(fr) ? fr : null;
}

// Global long/short account ratio at `atMs` (5m granularity). Binance only
// retains ~30 days of history — older lookups return null.
export async function fetchLongShortRatioAt(symbol: string, atMs: number): Promise<number | null> {
  const url = `${FAPI_BASE}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&startTime=${atMs}&endTime=${atMs + 10 * 60 * 1000}&limit=2`;
  let res: Response;
  try { res = await fetch(url, { cache: "no-store" }); } catch { return null; }
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ longShortRatio: string }>;
  if (!data.length) return null;
  const ratio = parseFloat(data[0].longShortRatio);
  return isFinite(ratio) ? ratio : null;
}

// OI history window ending at the signal bar's close (15m granularity, ~30 days
// retention). Matches the live scan's 4-point lookback.
export async function fetchOIHistoryAt(symbol: string, barTimeMs: number, points = 4): Promise<OISnapshot[]> {
  const start = barTimeMs - (points - 1) * 15 * 60 * 1000;
  const end = barTimeMs + 15 * 60 * 1000;
  const url = `${FAPI_BASE}/futures/data/openInterestHist?symbol=${symbol}&period=15m&startTime=${start}&endTime=${end}&limit=${points + 2}`;
  let res: Response;
  try { res = await fetch(url, { cache: "no-store" }); } catch { return []; }
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{ sumOpenInterest: string; timestamp: number }>;
  return data
    .map((d) => ({ openInterest: parseFloat(d.sumOpenInterest), timestamp: d.timestamp }))
    .filter((d) => isFinite(d.openInterest))
    .slice(-points);
}

// Run a list of async tasks with bounded concurrency.
// under Binance's burst limit and Vercel's function timeout.
//
// We use 20 concurrent fetches: at ~150ms latency per fetch, that's ~7.5
// batches/sec, well below Binance's 6000 weight/min IP limit for klines.
export async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<Array<{ item: T; result: R } | { item: T; error: Error }>> {
  const results: Array<{ item: T; result: R } | { item: T; error: Error }> = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        const result = await fn(items[i]);
        results[i] = { item: items[i], result };
      } catch (e) {
        results[i] = { item: items[i], error: e as Error };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
