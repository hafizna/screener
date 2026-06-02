// BTC market context — snapshotted at signal-fire time. BTC drives the majority of
// alt movement, so tagging each signal with "what was BTC doing?" lets us slice
// performance by the BTC backdrop. All values are point-in-time and never refreshed.
//
// Uses the public Binance USDT-M futures klines endpoint (no auth). 1-minute bars.

const FAPI_BASE = "https://fapi.binance.com";

export interface BtcContext {
  btcReturn15mPct: number | null;       // BTC % return over the 15m before the reference time
  btcReturn1hPct: number | null;        // BTC % return over the 1h before the reference time
  btcRealizedVol24hPct: number | null;  // realized vol of 1m returns over 24h, annualized to a daily figure
}

export const EMPTY_BTC_CONTEXT: BtcContext = {
  btcReturn15mPct: null,
  btcReturn1hPct: null,
  btcRealizedVol24hPct: null,
};

interface MiniKline {
  closeTime: number;
  close: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch BTCUSDT 1m klines with retry + exponential backoff on rate-limit/5xx.
// Optional time window (startTime/endTime in ms) for backfilling historical windows.
export async function fetchBtc1mKlines(opts: {
  startTime?: number;
  endTime?: number;
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<MiniKline[]> {
  const params = new URLSearchParams({
    symbol: "BTCUSDT",
    interval: "1m",
    limit: String(opts.limit ?? 1500), // Binance hard cap is 1500
  });
  if (opts.startTime != null) params.set("startTime", String(opts.startTime));
  if (opts.endTime != null) params.set("endTime", String(opts.endTime));
  const url = `${FAPI_BASE}/fapi/v1/klines?${params.toString()}`;

  const MAX_ATTEMPTS = 5;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: opts.signal, cache: "no-store" });
      // 429 = rate-limited, 418 = IP banned (after repeated 429), 5xx = transient.
      if (res.status === 429 || res.status === 418 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(16000, 1000 * 2 ** attempt);
        lastErr = new Error(`Binance ${res.status} (attempt ${attempt + 1})`);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text().catch(() => "")}`);
      const raw = (await res.json()) as unknown[][];
      return raw.map((r) => ({ closeTime: r[6] as number, close: parseFloat(r[4] as string) }));
    } catch (e) {
      lastErr = e as Error;
      await sleep(Math.min(16000, 1000 * 2 ** attempt));
    }
  }
  throw lastErr ?? new Error("fetchBtc1mKlines failed");
}

// Compute BTC context as of `refTime` (ms). Only bars that have CLOSED at or before
// refTime are considered, so a still-forming bar never leaks into the snapshot.
//   - 15m / 1h return: close_now vs close 15 / 60 closed-bars earlier
//   - realized vol: population stdev of 1m simple returns over the last 1440 bars,
//     scaled by sqrt(1440) and ×100 (a 24h figure in %), matching the spec.
export function computeBtcContext(klines: MiniKline[], refTime: number): BtcContext {
  const closed = klines
    .filter((k) => k.closeTime <= refTime)
    .sort((a, b) => a.closeTime - b.closeTime);
  const closes = closed.map((k) => k.close);
  const n = closes.length;
  if (n === 0) return { ...EMPTY_BTC_CONTEXT };

  const now = closes[n - 1];
  const pctChange = (then: number) => (then > 0 ? (now - then) / then * 100 : null);

  const c15 = n > 15 ? closes[n - 1 - 15] : null;
  const c60 = n > 60 ? closes[n - 1 - 60] : null;
  const btcReturn15mPct = c15 != null ? pctChange(c15) : null;
  const btcReturn1hPct = c60 != null ? pctChange(c60) : null;

  // Need 1441 closes to get 1440 one-minute returns over a 24h window.
  let btcRealizedVol24hPct: number | null = null;
  const window = closes.slice(-1441);
  if (window.length >= 2) {
    const rets: number[] = [];
    for (let i = 1; i < window.length; i++) {
      if (window[i - 1] > 0) rets.push((window[i] - window[i - 1]) / window[i - 1]);
    }
    if (rets.length >= 2) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
      btcRealizedVol24hPct = Math.sqrt(variance) * Math.sqrt(1440) * 100;
    }
  }

  return { btcReturn15mPct, btcReturn1hPct, btcRealizedVol24hPct };
}

// ── Live snapshot with a 60s cache ──────────────────────────────────────────────
// Many signals fire in the same scan/minute; cache the 1m klines so we hit Binance
// at most once per minute regardless of how many signals trigger.
let liveCache: { fetchedAt: number; klines: MiniKline[] } | null = null;
const LIVE_TTL_MS = 60_000;

export async function getBtcContextLive(refTime: number = Date.now()): Promise<BtcContext> {
  const nowMs = Date.now();
  if (!liveCache || nowMs - liveCache.fetchedAt > LIVE_TTL_MS) {
    const klines = await fetchBtc1mKlines({ limit: 1500 });
    liveCache = { fetchedAt: nowMs, klines };
  }
  return computeBtcContext(liveCache.klines, refTime);
}
