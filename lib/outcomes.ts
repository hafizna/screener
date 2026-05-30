import type { Kline } from "./types";
import type { Outcome, SignalLog } from "./db";

export interface OutcomeResult {
  outcome: Outcome;
  outcomeAt: number;
  outcomePrice: number;
  maxFavorable: number;
  maxAdverse:   number;
  outcomeDetail: string;
  // true = trailing SL hit or TP3 hit — outcome final, signal closes to History.
  // false = TP1/TP2 reached but price still inside trailing range — keep active.
  terminal: boolean;
}

// Resolves the outcome of a signal by processing bars chronologically.
//
// State machine with trailing SL — once a TP is reached, the effective SL
// trails up to lock in profit. Locked-in outcomes are terminal even if price
// later moves further (signal is closed and won't upgrade in History):
//   Phase 0 (no TP yet):   effective SL = original SL  → break → outcome "sl"
//   Phase 1 (TP1 reached): effective SL = entry        → pullback to entry → outcome "tp1"
//   Phase 2 (TP2 reached): effective SL = TP1          → pullback to TP1   → outcome "tp2"
//   Phase 3 (TP3 reached): immediate terminal "tp3"
//
// Within a bar, TP hits are processed BEFORE the trailing SL tightens — so a
// bar that touches both TP1 and entry locks TP1 first, and trailing only takes
// effect from the next bar onward (we have no intra-bar order from OHLC).
//
// When klines are exhausted mid-phase: returns non-terminal result so the
// signal stays active and is re-checked on the next scan cycle.
export function resolveOutcome(
  signal: Pick<SignalLog, "side" | "entry_price" | "tp1" | "tp2" | "tp3" | "sl">,
  klines: Kline[],
): OutcomeResult | null {
  const { side, entry_price: entry, tp1, tp2, tp3, sl } = signal;
  const isLong = side === "long";

  let maxFav = 0;
  let maxAdv = 0;
  let bestTP: { outcome: "tp1" | "tp2" | "tp3"; at: number; price: number } | null = null;
  let effectiveSL: number | null = sl;

  for (const bar of klines) {
    const favorable = isLong ? bar.high - entry : entry - bar.low;
    const adverse   = isLong ? entry - bar.low  : bar.high - entry;
    if (favorable > maxFav) maxFav = favorable;
    if (adverse   > maxAdv) maxAdv = adverse;

    const slHit  = effectiveSL != null && (isLong ? bar.low  <= effectiveSL : bar.high >= effectiveSL);
    const tp3Hit = tp3 != null && (isLong ? bar.high >= tp3 : bar.low  <= tp3);
    const tp2Hit = tp2 != null && (isLong ? bar.high >= tp2 : bar.low  <= tp2);
    const tp1Hit = tp1 != null && (isLong ? bar.high >= tp1 : bar.low  <= tp1);

    if (tp3Hit) {
      return { outcome: "tp3", outcomeAt: bar.closeTime, outcomePrice: tp3!, maxFavorable: maxFav, maxAdverse: maxAdv, outcomeDetail: "tp3_hit", terminal: true };
    }
    if (tp2Hit && (!bestTP || bestTP.outcome === "tp1")) {
      bestTP = { outcome: "tp2", at: bar.closeTime, price: tp2! };
    }
    if (tp1Hit && !bestTP) {
      bestTP = { outcome: "tp1", at: bar.closeTime, price: tp1! };
    }

    if (slHit) {
      if (!bestTP) {
        return { outcome: "sl", outcomeAt: bar.closeTime, outcomePrice: sl!, maxFavorable: maxFav, maxAdverse: maxAdv, outcomeDetail: "initial_sl_hit", terminal: true };
      }
      // Trailing SL hit after a TP — lock in the best TP reached so far.
      return { outcome: bestTP.outcome, outcomeAt: bar.closeTime, outcomePrice: effectiveSL!, maxFavorable: maxFav, maxAdverse: maxAdv, outcomeDetail: `trailing_sl_after_${bestTP.outcome}`, terminal: true };
    }

    // Tighten trailing SL AFTER this bar's hits — takes effect from next bar.
    if (bestTP?.outcome === "tp2") effectiveSL = tp1 ?? effectiveSL;
    else if (bestTP?.outcome === "tp1") effectiveSL = entry;
  }

  // Klines exhausted — if any TP was reached, return it as non-terminal (still running).
  // Caller should NOT finalize the outcome; update best_tp only and re-check next scan.
  if (bestTP) {
    return { outcome: bestTP.outcome, outcomeAt: bestTP.at, outcomePrice: bestTP.price, maxFavorable: maxFav, maxAdverse: maxAdv, outcomeDetail: `${bestTP.outcome}_hit_running`, terminal: false };
  }

  return null; // No level hit yet — signal still active
}
