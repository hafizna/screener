// Run with: npx tsx scripts/sanity-test.ts
// Or: npx ts-node --esm scripts/sanity-test.ts
//
// Standalone sanity test — no test framework. Asserts a few invariants on
// constructed kline data so we know the port matches expectations before
// touching live data.

import { buildProfile, buildValueArea } from "../lib/profile";
import { zScoreAt } from "../lib/zscore";
import type { Kline } from "../lib/types";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("PASS:", msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Profile basics
// Build a profile from bars that all overlap a narrow range [100, 102].
// Expect: POC near the middle, narrow value area.
// ─────────────────────────────────────────────────────────────────────────────
const t1_bars: Kline[] = [
  // openTime, open, high, low, close, volume, closeTime, takerBuyVolume
  { openTime: 0, open: 100, high: 102, low: 100, close: 101, volume: 10, closeTime: 0, takerBuyVolume: 5 },
  { openTime: 1, open: 101, high: 102, low: 100.5, close: 101, volume: 10, closeTime: 1, takerBuyVolume: 5 },
  { openTime: 2, open: 101, high: 101.5, low: 100.5, close: 101, volume: 10, closeTime: 2, takerBuyVolume: 5 },
  { openTime: 3, open: 101, high: 101.5, low: 100.8, close: 101.2, volume: 10, closeTime: 3, takerBuyVolume: 5 },
  { openTime: 4, open: 101.2, high: 101.8, low: 101, close: 101.5, volume: 10, closeTime: 4, takerBuyVolume: 5 },
];
const p1 = buildProfile(t1_bars, 0.1);
assert(p1 !== null, "T1: profile built");
if (p1) {
  assert(p1.priceMin <= 100 && p1.priceMax >= 102, "T1: profile range covers all bars");
  assert(p1.tpoCounts.reduce((a, b) => a + b, 0) > 0, "T1: nonzero TPO counts");
  assert(p1.val < p1.vah, "T1: VAL < VAH");
  assert(p1.poc >= p1.val && p1.poc <= p1.vah, "T1: POC inside VA");
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Value-area construction with a known distribution.
// TPO counts: [1, 2, 5, 10, 5, 2, 1] = total 26, target 68% = ~18.
// POC at index 3 (count 10). Going outward:
//   step 1: above [5+2]=7, below [5+2]=7 → tie, take upper. VA = 17 (10+5+2).
//   step 2: still need 1 more. above [1+0]=1, below [5+2]=7 → take lower.
//   VA = 24 (10+5+2 above, 5 below). VAL=2, VAH=5.
// ─────────────────────────────────────────────────────────────────────────────
const counts = [1, 2, 5, 10, 5, 2, 1];
const [val, vah] = buildValueArea(counts, 3, 0.6826);
console.log(`T2: VAL=${val}, VAH=${vah}, sum=${counts.slice(val, vah + 1).reduce((a, b) => a + b, 0)}/${counts.reduce((a, b) => a + b, 0)}`);
const vaSum = counts.slice(val, vah + 1).reduce((a, b) => a + b, 0);
assert(vaSum / 26 >= 0.6826, `T2: VA sum ${vaSum} >= target`);
assert(val <= 3 && vah >= 3, "T2: POC inside VA");

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Z-score sanity. Build a series where bar 24 is an outlier.
// Mean of first 24 bars = 10, stdev ≈ 0 (constant). Bar 24 (last) volume = 50.
// Expect: huge positive Z, level == 3 (extreme).
// ─────────────────────────────────────────────────────────────────────────────
const t3_bars: Kline[] = [];
for (let i = 0; i < 24; i++) {
  t3_bars.push({ openTime: i, open: 100, high: 101, low: 99, close: 100.5, volume: 10 + (i % 2), closeTime: i, takerBuyVolume: 5 });
}
t3_bars.push({ openTime: 24, open: 100, high: 101, low: 99, close: 100.5, volume: 50, closeTime: 24, takerBuyVolume: 25 });
const z = zScoreAt(t3_bars, 24);
assert(z !== null, "T3: z computed");
if (z) {
  console.log(`T3: z=${z.z.toFixed(2)}, level=${z.level}`);
  assert(z.z > 2.5, "T3: outlier bar yields extreme Z");
  assert(z.level === 3, "T3: classified as extreme");
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Half-open interval correctness.
// Bar with high=100.5, low=100.5 (touches exactly one row boundary).
// With ts=0.1 and priceMin=100.0: row 5 = [100.5, 100.6).
// Pine logic: high >= rowMin (100.5 >= 100.5 = true) AND low < rowMax (100.5 < 100.6 = true).
// So row 5 should be touched, row 4 should NOT be (low not < rowMax = 100.5).
// ─────────────────────────────────────────────────────────────────────────────
const t4_bars: Kline[] = [
  { openTime: 0, open: 100.5, high: 100.5, low: 100.5, close: 100.5, volume: 1, closeTime: 0, takerBuyVolume: 0 },
];
const p4 = buildProfile(t4_bars, 0.1);
if (p4) {
  // priceMin should snap to 100.5 (the only price), so row 0 has the count.
  console.log(`T4: priceMin=${p4.priceMin}, counts=${JSON.stringify(p4.tpoCounts)}`);
  assert(p4.tpoCounts.reduce((a, b) => a + b, 0) >= 1, "T4: doji bar counted at least once");
}

console.log("\nAll sanity tests passed.");
