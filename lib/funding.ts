import type { FRBias, MarketRegime } from "./types";

// FR classification is regime-aware.
// In a FLUSH for longs: high positive FR = shorts overcrowded at support = squeeze fuel → FAVORABLE.
// In all other cases: standard logic.
export function classifyFR(side: "long" | "short", fr: number, regime: MarketRegime): FRBias {
  if (regime === "flush" && side === "long") {
    if (fr > 0.0005) return "favorable";  // > +0.05%: shorts are paying, crowded
    if (fr < 0)      return "neutral";    // negative FR in flush = unusual
    return "neutral";
  }
  if (side === "long") {
    if (fr < 0)    return "favorable";
    if (fr > 0.001) return "unfavorable"; // > +0.10%: longs crowded in normal market
    return "neutral";
  }
  // short
  if (fr > 0.0005) return "favorable";
  if (fr < 0)      return "unfavorable";
  return "neutral";
}

// L/S account-ratio classification, shared by the live scan and the backfill.
export function classifyLs(longShortRatio: number): "crowded_shorts" | "balanced" | "crowded_longs" {
  return longShortRatio < 0.85 ? "crowded_shorts"
    : longShortRatio > 1.20 ? "crowded_longs"
    : "balanced";
}
