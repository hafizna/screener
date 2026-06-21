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

// Monthly VWAP anchored to the 1st of the UTC month. Pass 4h klines (200 × 4h ≈
// 33 days covers the full current month back to the 1st in all cases).
export function monthlyVwap(klines: Kline[]): number | null {
  if (klines.length === 0) return null;
  const last = klines[klines.length - 1].openTime;
  const d = new Date(last);
  const anchor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return vwapOver(klines, anchor);
}

// ─── Research: anchored higher-TF VWAPs at a point in time ────────────────────
// Used by /api/admin/vwap-research to test whether a signal's proximity to a
// weekly / monthly / prev-week / prev-month VWAP predicts its outcome. These are
// point-in-time (computed at the signal bar), so the kline window passed in must
// cover from the previous month's start through the signal bar.

const DAY_MS = 86_400_000;

// 1st 00:00 UTC of the month containing `ms`.
function startOfUtcMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

// 1st 00:00 UTC of the month before the one containing `ms` (handles year wrap).
function startOfPrevUtcMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
}

// Earliest kline timestamp the research backfill must fetch to anchor every level
// (prev-month VWAP) for a signal at `ms`. Exported so the route can size its range.
export function prevMonthAnchorFloor(ms: number): number {
  return startOfPrevUtcMonth(ms);
}

// Volume-weighted typical price over bars whose openTime is in [startMs, endMs].
function vwapWindow(klines: Kline[], startMs: number, endMs: number): number | null {
  let pv = 0;
  let v = 0;
  for (const k of klines) {
    if (k.openTime < startMs || k.openTime > endMs) continue;
    const typical = (k.high + k.low + k.close) / 3;
    pv += typical * k.volume;
    v += k.volume;
  }
  return v > 0 ? pv / v : null;
}

export interface VwapLevels {
  weekly: number | null;     // anchored at week start, through the signal bar
  monthly: number | null;    // anchored at month start, through the signal bar
  prevWeek: number | null;   // full VWAP of the previous completed week (static level)
  prevMonth: number | null;  // full VWAP of the previous completed month (static level)
}

// The four anchored VWAPs as they stood at `signalBarMs` (the signal bar's open).
export function computeVwapLevels(klines: Kline[], signalBarMs: number): VwapLevels {
  const ws = startOfUtcWeek(signalBarMs);
  const ms = startOfUtcMonth(signalBarMs);
  const pws = ws - 7 * DAY_MS;
  const pms = startOfPrevUtcMonth(signalBarMs);
  return {
    weekly: vwapWindow(klines, ws, signalBarMs),
    monthly: vwapWindow(klines, ms, signalBarMs),
    prevWeek: vwapWindow(klines, pws, ws - 1),
    prevMonth: vwapWindow(klines, pms, ms - 1),
  };
}

// Signed distance of `price` from `level`, in percent. +ve = price above the level.
export function signedDistPct(price: number, level: number | null): number | null {
  if (level === null || !(level > 0) || !(price > 0)) return null;
  return ((price - level) / level) * 100;
}
