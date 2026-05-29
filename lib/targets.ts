import type { SignalSide } from "./types";

// Where a take-profit level came from. Used for observability — so we can later
// check in History whether VWAP-anchored TPs actually outperform pure-ATR ones.
export type TPSource = "atr" | "vwap_daily" | "vwap_weekly";

export interface TargetLevels {
  sl?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  tp2Source: TPSource;
  tp3Source: TPSource;
}

interface ComputeTargetsParams {
  entry: number;
  side: SignalSide;
  atr: number;
  vwapDaily?: number | null;
  vwapWeekly?: number | null;
}

// ATR multiples — TP1 is the fixed anchor; TP2/TP3 are *caps* that VWAP magnets
// may pull inward (closer = more achievable) but never push beyond.
const SL_MULT = 1.0;
const TP1_MULT = 1.5;
const TP2_MULT = 3.0;
const TP3_MULT = 5.0;
const MIN_GAP_MULT = 0.3; // a magnet must sit at least this far past the prior TP

interface Magnet {
  price: number;
  source: TPSource;
}

// Pick the nearest magnet strictly inside (lower, upper] in the trade's profit
// direction. "Nearest" = most achievable intermediate target.
function nearestMagnet(
  magnets: Magnet[],
  lower: number,
  upper: number,
  isLong: boolean
): Magnet | null {
  const inWindow = magnets.filter((m) =>
    isLong ? m.price > lower && m.price <= upper : m.price < lower && m.price >= upper
  );
  if (inWindow.length === 0) return null;
  // Nearest to `lower` (the prior TP) — the closest magnet beyond it.
  return inWindow.reduce((best, m) =>
    Math.abs(m.price - lower) < Math.abs(best.price - lower) ? m : best
  );
}

// TP1 stays pure ATR (anchor). TP2/TP3 snap to the nearest VWAP magnet that
// falls between the prior TP (plus a min gap) and the ATR cap, otherwise they
// fall back to the ATR target. Guarantees TP1 < TP2 < TP3 (or reversed for shorts).
export function computeTargets({ entry, side, atr, vwapDaily, vwapWeekly }: ComputeTargetsParams): TargetLevels {
  if (!(atr > 0) || !(entry > 0)) {
    return { tp2Source: "atr", tp3Source: "atr" };
  }
  const isLong = side === "long";
  const dir = isLong ? 1 : -1;

  const sl = entry - dir * SL_MULT * atr;
  const tp1 = entry + dir * TP1_MULT * atr;
  const atrTp2 = entry + dir * TP2_MULT * atr;
  const atrTp3 = entry + dir * TP3_MULT * atr;
  const minGap = MIN_GAP_MULT * atr;

  const magnets: Magnet[] = [];
  if (vwapDaily != null && Number.isFinite(vwapDaily)) magnets.push({ price: vwapDaily, source: "vwap_daily" });
  if (vwapWeekly != null && Number.isFinite(vwapWeekly)) magnets.push({ price: vwapWeekly, source: "vwap_weekly" });

  // TP2: nearest magnet in (tp1 + gap, atrTp2], else the ATR cap.
  const tp2Lower = tp1 + dir * minGap;
  const tp2Magnet = nearestMagnet(magnets, tp2Lower, atrTp2, isLong);
  const tp2 = tp2Magnet ? tp2Magnet.price : atrTp2;
  const tp2Source: TPSource = tp2Magnet ? tp2Magnet.source : "atr";

  // TP3: nearest remaining magnet in (tp2 + gap, atrTp3], else the ATR cap.
  const tp3Lower = tp2 + dir * minGap;
  const remaining = magnets.filter((m) => m.source !== tp2Source);
  const tp3Magnet = nearestMagnet(remaining, tp3Lower, atrTp3, isLong);
  const tp3 = tp3Magnet ? tp3Magnet.price : atrTp3;
  const tp3Source: TPSource = tp3Magnet ? tp3Magnet.source : "atr";

  return { sl, tp1, tp2, tp3, tp2Source, tp3Source };
}
