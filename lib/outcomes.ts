import type { Kline } from "./types";
import type { Outcome, SignalLog } from "./db";

export interface OutcomeResult {
  outcome: Outcome;
  outcomeAt: number;
  outcomePrice: number;
  maxFavorable: number;
  maxAdverse:   number;
  // true = SL hit or TP3 hit — no further tracking needed.
  // false = TP1/TP2 reached but price still running — keep signal active.
  terminal: boolean;
}

// Resolves the outcome of a signal by processing bars chronologically.
//
// State machine — once a higher TP is hit, lower ones are "locked in":
//   Phase 0 (no TP hit yet):   SL hit → "sl" terminal
//   Phase 1 (TP1 hit):         continue watching; SL hit → "tp1" terminal (break-even)
//   Phase 2 (TP2 hit):         continue watching; SL/reversal → "tp2" terminal
//   Phase 3 (TP3 hit):         "tp3" terminal (full swing target)
//
// When klines are exhausted mid-phase (no SL/TP3): returns non-terminal result
// so the signal stays active and is re-checked on the next scan cycle.
export function resolveOutcome(
  signal: Pick<SignalLog, "side" | "entry_price" | "tp1" | "tp2" | "tp3" | "sl">,
  klines: Kline[],
): OutcomeResult | null {
  const { side, entry_price: entry, tp1, tp2, tp3, sl } = signal;
  const isLong = side === "long";

  let maxFav = 0;
  let maxAdv = 0;
  let bestTP: { outcome: "tp1" | "tp2" | "tp3"; at: number; price: number } | null = null;

  for (const bar of klines) {
    const favorable = isLong ? bar.high - entry : entry - bar.low;
    const adverse   = isLong ? entry - bar.low  : bar.high - entry;
    if (favorable > maxFav) maxFav = favorable;
    if (adverse   > maxAdv) maxAdv = adverse;

    const slHit  = sl  != null && (isLong ? bar.low  <= sl  : bar.high >= sl);
    const tp3Hit = tp3 != null && (isLong ? bar.high >= tp3 : bar.low  <= tp3);
    const tp2Hit = tp2 != null && (isLong ? bar.high >= tp2 : bar.low  <= tp2);
    const tp1Hit = tp1 != null && (isLong ? bar.high >= tp1 : bar.low  <= tp1);

    if (tp3Hit) {
      return { outcome: "tp3", outcomeAt: bar.closeTime, outcomePrice: tp3!, maxFavorable: maxFav, maxAdverse: maxAdv, terminal: true };
    }
    if (tp2Hit && (!bestTP || bestTP.outcome === "tp1")) {
      bestTP = { outcome: "tp2", at: bar.closeTime, price: tp2! };
    }
    if (tp1Hit && !bestTP) {
      bestTP = { outcome: "tp1", at: bar.closeTime, price: tp1! };
    }

    if (slHit) {
      if (!bestTP) {
        return { outcome: "sl", outcomeAt: bar.closeTime, outcomePrice: sl!, maxFavorable: maxFav, maxAdverse: maxAdv, terminal: true };
      }
      // SL after TP = stopped at break-even or better — terminal, lock in best TP
      return { outcome: bestTP.outcome, outcomeAt: bar.closeTime, outcomePrice: bestTP.price, maxFavorable: maxFav, maxAdverse: maxAdv, terminal: true };
    }
  }

  // Klines exhausted — if any TP was reached, return it as non-terminal (still running).
  // Caller should NOT finalize the outcome; update best_tp only and re-check next scan.
  if (bestTP) {
    return { outcome: bestTP.outcome, outcomeAt: bestTP.at, outcomePrice: bestTP.price, maxFavorable: maxFav, maxAdverse: maxAdv, terminal: false };
  }

  return null; // No level hit yet — signal still active
}
