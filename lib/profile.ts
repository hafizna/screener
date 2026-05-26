import type { Kline, MarketProfile } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Tick size resolution
//
// Pine has both auto and manual modes. We pick "auto" by default: choose a tick
// size that yields ~50–200 price rows for the window. Too few rows → POC is
// meaningless. Too many → fragmented, no clear value area.
//
// Heuristic: target 80 rows. tickSize = (priceMax - priceMin) / 80, then round
// to a sensible multiple of the symbol's price precision.
// ─────────────────────────────────────────────────────────────────────────────
export function resolveTickSize(
  klines: Kline[],
  targetRows = 80
): number {
  if (klines.length === 0) return 1;
  let hi = -Infinity;
  let lo = Infinity;
  for (const k of klines) {
    if (k.high > hi) hi = k.high;
    if (k.low < lo) lo = k.low;
  }
  const range = hi - lo;
  if (range <= 0) return 1;
  const raw = range / targetRows;

  // Round to a nice power of 10 increment. e.g. 0.0037 → 0.005,  0.42 → 0.5
  // We use 1, 2, 5 × 10^n increments — standard "engineering" rounding.
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  let nice: number;
  if (normalized < 1.5) nice = 1;
  else if (normalized < 3.5) nice = 2;
  else if (normalized < 7.5) nice = 5;
  else nice = 10;
  return nice * magnitude;
}

// ─────────────────────────────────────────────────────────────────────────────
// TPO counting
//
// For each price row [rowMin, rowMin + tickSize), count how many bars in the
// window touched that row, i.e. bar.high >= rowMin AND bar.low < rowMin + tickSize.
//
// CRITICAL: half-open interval [min, max). Without this each price gets counted
// twice at row boundaries — Pine's original gets this right and we match it.
// ─────────────────────────────────────────────────────────────────────────────
export function buildProfile(
  klines: Kline[],
  tickSize?: number
): MarketProfile | null {
  if (klines.length === 0) return null;

  const ts = tickSize ?? resolveTickSize(klines);
  if (ts <= 0) return null;

  let hi = -Infinity;
  let lo = Infinity;
  for (const k of klines) {
    if (k.high > hi) hi = k.high;
    if (k.low < lo) lo = k.low;
  }

  // Snap profile bounds to tick-size grid so rows align cleanly.
  const priceMin = Math.floor(lo / ts) * ts;
  const priceMax = Math.ceil(hi / ts) * ts;
  const rowCount = Math.max(1, Math.round((priceMax - priceMin) / ts));

  const tpoCounts = new Array<number>(rowCount).fill(0);

  for (const k of klines) {
    // Half-open: row r covers [priceMin + r*ts, priceMin + (r+1)*ts)
    // Bar touches row r if bar.high >= rowMin AND bar.low < rowMax
    // → r ranges from floor((bar.low - priceMin) / ts) to floor((bar.high - priceMin) / ts)
    // But bar.high at exactly a row boundary should NOT include the upper row
    // (since that row's rowMin == bar.high doesn't satisfy bar.high >= rowMin strictly?
    //  Actually `>=` does satisfy. Pine uses `high[i] >= price_min and low[i] < price_max`.
    //  So a bar whose high is exactly a row boundary DOES touch the upper row.)
    const rLow = Math.max(0, Math.floor((k.low - priceMin) / ts));
    // Upper bound: rows where rowMin <= bar.high.
    // rowMin = priceMin + r*ts, so r <= (high - priceMin) / ts.
    // Use floor; if high lands exactly on a boundary we include that row.
    const rHigh = Math.min(rowCount - 1, Math.floor((k.high - priceMin) / ts));
    for (let r = rLow; r <= rHigh; r++) {
      tpoCounts[r]++;
    }
  }

  // POC = row with max TPOs. Ties: pick the row closest to the mid of the
  // profile (Pine's behaviour — uses the lower one of equal counts when scanning
  // upward, but we'll match by picking the most "central" tie-breaker for
  // visual stability across re-scans).
  let pocIndex = 0;
  let pocCount = tpoCounts[0];
  const mid = (rowCount - 1) / 2;
  let pocCentrality = Math.abs(0 - mid);
  for (let i = 1; i < rowCount; i++) {
    const c = tpoCounts[i];
    if (c > pocCount) {
      pocCount = c;
      pocIndex = i;
      pocCentrality = Math.abs(i - mid);
    } else if (c === pocCount) {
      const cent = Math.abs(i - mid);
      if (cent < pocCentrality) {
        pocIndex = i;
        pocCentrality = cent;
      }
    }
  }

  const [valIndex, vahIndex] = buildValueArea(tpoCounts, pocIndex, 0.6826);

  return {
    tickSize: ts,
    priceMin,
    priceMax,
    tpoCounts,
    pocIndex,
    valIndex,
    vahIndex,
    poc: priceMin + (pocIndex + 0.5) * ts,
    val: priceMin + valIndex * ts,                // bottom edge of VAL row
    vah: priceMin + (vahIndex + 1) * ts,          // top edge of VAH row
    totalTpos: tpoCounts.reduce((a, b) => a + b, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Value Area builder — standard CBOT method, matches Pine f_build_VA
//
// Starting from POC, repeatedly compare the sum of next-two-rows above current
// VAH vs next-two-rows below current VAL. Pick whichever pair has more TPOs.
// Continue until the value area contains ≥ target TPOs (default 68.26% — one
// standard deviation, the conventional choice).
//
// Edge cases (Pine handles these, we match):
//   - If only one side has rows left, take from that side.
//   - If both sides tied, Pine takes the upper pair. We do the same.
// ─────────────────────────────────────────────────────────────────────────────
export function buildValueArea(
  tpoCounts: number[],
  pocIndex: number,
  pct: number
): [valIndex: number, vahIndex: number] {
  const total = tpoCounts.reduce((a, b) => a + b, 0);
  const target = Math.round(total * pct);
  let val = pocIndex;
  let vah = pocIndex;
  let tposInVA = tpoCounts[pocIndex];
  const maxIdx = tpoCounts.length - 1;

  while (tposInVA < target) {
    const upperAvailable = vah < maxIdx;
    const lowerAvailable = val > 0;
    if (!upperAvailable && !lowerAvailable) break;

    const upperPair =
      (vah + 1 <= maxIdx ? tpoCounts[vah + 1] : 0) +
      (vah + 2 <= maxIdx ? tpoCounts[vah + 2] : 0);
    const lowerPair =
      (val - 1 >= 0 ? tpoCounts[val - 1] : 0) +
      (val - 2 >= 0 ? tpoCounts[val - 2] : 0);

    if (!lowerAvailable || (upperAvailable && upperPair >= lowerPair)) {
      // Take from above
      const step1 = Math.min(vah + 1, maxIdx);
      const step2 = Math.min(vah + 2, maxIdx);
      if (step1 > vah) {
        tposInVA += tpoCounts[step1];
        vah = step1;
      }
      if (step2 > vah && tposInVA < target) {
        tposInVA += tpoCounts[step2];
        vah = step2;
      }
    } else {
      // Take from below
      const step1 = Math.max(val - 1, 0);
      const step2 = Math.max(val - 2, 0);
      if (step1 < val) {
        tposInVA += tpoCounts[step1];
        val = step1;
      }
      if (step2 < val && tposInVA < target) {
        tposInVA += tpoCounts[step2];
        val = step2;
      }
    }
  }

  return [val, vah];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build profiles for "current day" and "previous day" from a stream of
// klines (assumed sorted ascending by openTime). Day boundary = UTC midnight.
//
// We need both because the Pine signal checks current AND previous session
// POC/VAH/VAL — that's why long signals fire on bars rejecting yesterday's
// value area, which is a real edge most screeners miss.
// ─────────────────────────────────────────────────────────────────────────────
export function splitByUtcDay(klines: Kline[]): Map<string, Kline[]> {
  const days = new Map<string, Kline[]>();
  for (const k of klines) {
    const d = new Date(k.openTime);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
    let arr = days.get(key);
    if (!arr) {
      arr = [];
      days.set(key, arr);
    }
    arr.push(k);
  }
  return days;
}

export function buildCurrentAndPreviousDayProfiles(
  klines: Kline[]
): { current: MarketProfile | null; previous: MarketProfile | null } {
  if (klines.length === 0) return { current: null, previous: null };

  const days = splitByUtcDay(klines);
  const keys = Array.from(days.keys()); // insertion order = chronological
  if (keys.length === 0) return { current: null, previous: null };

  const currentKey = keys[keys.length - 1];
  const previousKey = keys.length >= 2 ? keys[keys.length - 2] : null;

  const current = buildProfile(days.get(currentKey)!);
  const previous = previousKey ? buildProfile(days.get(previousKey)!) : null;

  return { current, previous };
}
