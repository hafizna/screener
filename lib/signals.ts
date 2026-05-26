import type { DeltaBias, Kline, MarketProfile, Signal, Timeframe } from "./types";
import { buildCurrentAndPreviousDayProfiles } from "./profile";
import { zScoreLastBar } from "./zscore";

// ─────────────────────────────────────────────────────────────────────────────
// Signal detection — port of Pine block:
//
//   bool z_qualifies = enable_zscore and (require_extreme ? z_lvl == 3 : z_lvl >= 2)
//   bool touched_support = f_near(low, TPO_POC) or f_near(low, TPO_VAL) or f_near(low, prev_POC) or f_near(low, prev_VAL)
//   bool touched_resist  = f_near(high, TPO_POC) or f_near(high, TPO_VAH) or f_near(high, prev_POC) or f_near(high, prev_VAH)
//   bool long_signal  = z_qualifies and is_up      and touched_support and close > open
//   bool short_signal = z_qualifies and (not is_up) and touched_resist  and close < open
//
// "Near" = within signal_tolerance_ticks * MP-tick of the level. The MP tick
// is the profile's row size, NOT the symbol's mintick.
// ─────────────────────────────────────────────────────────────────────────────

export interface DetectSignalsOptions {
  requireExtreme?: boolean;       // if true, need z_lvl == 3 (Pine default false)
  toleranceTicks?: number;        // Pine default 2
  vwapConfluenceTicks?: number;   // extra ranking — bar near VWAP gets flagged
}

interface LevelMatch {
  level: Signal["triggerLevel"];
  price: number;
  distanceTicks: number;
}

// Returns the *closest* matching level if the bar's low (for long) or high
// (for short) is within tolerance. We pick closest — not first — so the
// "trigger level" reported to the user is the one the bar actually rejected
// from. Otherwise we'd always credit POC even when the bar wicked into VAL.
function nearestSupport(
  barLow: number,
  curr: MarketProfile | null,
  prev: MarketProfile | null,
  tolerancePrice: number
): LevelMatch | null {
  const candidates: LevelMatch[] = [];
  if (curr) {
    candidates.push({ level: "POC", price: curr.poc, distanceTicks: Math.abs(barLow - curr.poc) });
    candidates.push({ level: "VAL", price: curr.val, distanceTicks: Math.abs(barLow - curr.val) });
  }
  if (prev) {
    candidates.push({ level: "PREV_POC", price: prev.poc, distanceTicks: Math.abs(barLow - prev.poc) });
    candidates.push({ level: "PREV_VAL", price: prev.val, distanceTicks: Math.abs(barLow - prev.val) });
  }
  let best: LevelMatch | null = null;
  for (const c of candidates) {
    if (c.distanceTicks <= tolerancePrice) {
      if (!best || c.distanceTicks < best.distanceTicks) best = c;
    }
  }
  return best;
}

function nearestResistance(
  barHigh: number,
  curr: MarketProfile | null,
  prev: MarketProfile | null,
  tolerancePrice: number
): LevelMatch | null {
  const candidates: LevelMatch[] = [];
  if (curr) {
    candidates.push({ level: "POC", price: curr.poc, distanceTicks: Math.abs(barHigh - curr.poc) });
    candidates.push({ level: "VAH", price: curr.vah, distanceTicks: Math.abs(barHigh - curr.vah) });
  }
  if (prev) {
    candidates.push({ level: "PREV_POC", price: prev.poc, distanceTicks: Math.abs(barHigh - prev.poc) });
    candidates.push({ level: "PREV_VAH", price: prev.vah, distanceTicks: Math.abs(barHigh - prev.vah) });
  }
  let best: LevelMatch | null = null;
  for (const c of candidates) {
    if (c.distanceTicks <= tolerancePrice) {
      if (!best || c.distanceTicks < best.distanceTicks) best = c;
    }
  }
  return best;
}

// Rolling VWAP for the current UTC day — used only for confluence flagging.
// Not a true session VWAP across all the Pine cases (Asian/London/US); the
// screener uses 24hr session by default (matches your Pine session_option_24hr
// fallback for crypto).
function dayVwap(klines: Kline[]): number | null {
  if (klines.length === 0) return null;
  const lastDay = new Date(klines[klines.length - 1].openTime);
  const yyyy = lastDay.getUTCFullYear();
  const mm = lastDay.getUTCMonth();
  const dd = lastDay.getUTCDate();
  let pv = 0;
  let v = 0;
  for (const k of klines) {
    const d = new Date(k.openTime);
    if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== mm || d.getUTCDate() !== dd) continue;
    const typical = (k.high + k.low + k.close) / 3;
    pv += typical * k.volume;
    v += k.volume;
  }
  return v > 0 ? pv / v : null;
}

// Previous-day high / low for confluence.
function prevDayHL(klines: Kline[]): { high: number; low: number } | null {
  if (klines.length === 0) return null;
  const last = new Date(klines[klines.length - 1].openTime);
  const todayKey = `${last.getUTCFullYear()}-${last.getUTCMonth()}-${last.getUTCDate()}`;
  let pdHigh = -Infinity;
  let pdLow = Infinity;
  let found = false;
  // Walk backward, group by day, pick the day immediately before today.
  let prevKey: string | null = null;
  for (let i = klines.length - 1; i >= 0; i--) {
    const d = new Date(klines[i].openTime);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (key === todayKey) continue;
    if (prevKey === null) prevKey = key;
    if (key !== prevKey) break;
    if (klines[i].high > pdHigh) pdHigh = klines[i].high;
    if (klines[i].low < pdLow) pdLow = klines[i].low;
    found = true;
  }
  return found ? { high: pdHigh, low: pdLow } : null;
}

export function detectSignal(
  symbol: string,
  timeframe: Timeframe,
  klines: Kline[],
  options: DetectSignalsOptions = {}
): Signal | null {
  const requireExtreme = options.requireExtreme ?? false;
  const toleranceTicks = options.toleranceTicks ?? 2;

  if (klines.length < 30) return null;

  // We evaluate the *last closed bar*. The caller is responsible for excluding
  // the in-progress bar — see binance.ts:fetchKlines.
  const lastBar = klines[klines.length - 1];

  // 1. Z-score qualification
  const z = zScoreLastBar(klines);
  if (!z) return null;
  const zPasses = requireExtreme ? z.level === 3 : z.level >= 2;
  if (!zPasses) return null;

  // 2. Build profiles (current and previous UTC day)
  const { current, previous } = buildCurrentAndPreviousDayProfiles(klines);
  if (!current && !previous) return null;

  // Tolerance is in MP ticks — use the current profile's tick size if we have it,
  // else previous, else fall back to a tiny fraction of price.
  const tickSize = current?.tickSize ?? previous?.tickSize ?? lastBar.close * 0.0005;
  const tolerancePrice = toleranceTicks * tickSize;

  const isUp = lastBar.close >= lastBar.open;
  const closeBeyondOpen =
    (isUp && lastBar.close > lastBar.open) || (!isUp && lastBar.close < lastBar.open);
  if (!closeBeyondOpen) return null; // Pine: close > open / close < open (strict)

  let side: Signal["side"];
  let match: LevelMatch | null;
  if (isUp) {
    side = "long";
    match = nearestSupport(lastBar.low, current, previous, tolerancePrice);
  } else {
    side = "short";
    match = nearestResistance(lastBar.high, current, previous, tolerancePrice);
  }
  if (!match) return null;

  // 3. Confluence flags — used for ranking on the dashboard
  const vwap = dayVwap(klines);
  const nearVwap = vwap !== null && Math.abs(lastBar.close - vwap) <= tolerancePrice * 2;
  const pdhl = prevDayHL(klines);
  const nearPdh = pdhl !== null && Math.abs(lastBar.high - pdhl.high) <= tolerancePrice * 2;
  const nearPdl = pdhl !== null && Math.abs(lastBar.low - pdhl.low) <= tolerancePrice * 2;

  // 4. Taker buy ratio — fraction of volume that was aggressive buy orders.
  //    >0.55 = buy-dominated bar, <0.45 = sell-dominated bar.
  const takerBuyRatio =
    lastBar.volume > 0 ? lastBar.takerBuyVolume / lastBar.volume : 0.5;
  const deltaBias: DeltaBias =
    takerBuyRatio > 0.55
      ? side === "long" ? "aligned" : "opposed"
      : takerBuyRatio < 0.45
      ? side === "short" ? "aligned" : "opposed"
      : "neutral";

  return {
    symbol,
    timeframe,
    side,
    zLevel: z.level,
    zScore: z.z,
    triggerLevel: match.level,
    triggerPrice: match.price,
    barTime: lastBar.openTime,
    barClose: lastBar.close,
    barHigh: lastBar.high,
    barLow: lastBar.low,
    nearVwap,
    nearWeeklyVwap: false, // would need a 1H+ feed to compute reliably; skip v1
    nearPdh,
    nearPdl,
    distanceFromLevel: match.distanceTicks / tickSize,
    takerBuyRatio,
    deltaBias,
  };
}
