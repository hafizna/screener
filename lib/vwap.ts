import type { Kline } from "./types";

// VWAP = Σ(typical price × volume) / Σ(volume), where typical = (H+L+C)/3.
// These are anchored VWAPs: daily resets at UTC midnight, weekly at UTC Monday.
// Both are computed over klines we already fetch in the scan loop (15m for daily,
// 1h for weekly), so they cost zero extra API calls.

function vwapOver(klines: Kline[], fromTime: number): number | null {
  let pv = 0;
  let v = 0;
  for (const k of klines) {
    if (k.openTime < fromTime) continue;
    const typical = (k.high + k.low + k.close) / 3;
    pv += typical * k.volume;
    v += k.volume;
  }
  return v > 0 ? pv / v : null;
}

// Start of the UTC day containing `ms`.
function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Start of the UTC week (Monday 00:00) containing `ms`.
function startOfUtcWeek(ms: number): number {
  const d = new Date(ms);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7; // Sun=0 → 6, Mon=1 → 0, …
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday);
}

// Daily VWAP anchored to UTC midnight. Pass 15m (or finer) klines.
export function dailyVwap(klines: Kline[]): number | null {
  if (klines.length === 0) return null;
  const anchor = startOfUtcDay(klines[klines.length - 1].openTime);
  return vwapOver(klines, anchor);
}

// Weekly VWAP anchored to UTC Monday. Pass 1h klines (200 × 1h ≈ 8 days covers
// the full current week back to Monday in all cases).
export function weeklyVwap(klines: Kline[]): number | null {
  if (klines.length === 0) return null;
  const anchor = startOfUtcWeek(klines[klines.length - 1].openTime);
  return vwapOver(klines, anchor);
}
