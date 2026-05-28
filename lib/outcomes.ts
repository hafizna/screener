import type { Kline } from "./types";
import type { Outcome, SignalLog } from "./db";

interface OutcomeResult {
  outcome: Outcome;
  outcomeAt: number;
  outcomePrice: number;
  maxFavorable: number;
  maxAdverse:   number;
}

// Resolves the outcome of a signal by processing bars chronologically.
//
// State machine — once a higher TP is hit, lower ones are "locked in":
//   Phase 0 (no TP hit yet):   SL hit → "sl" (actual loss)
//   Phase 1 (TP1 hit):         continue watching; SL hit → "tp1" (break-even, SL moved to entry)
//   Phase 2 (TP2 hit):         continue watching; SL/reversal → "tp2" (partial win locked)
//   Phase 3 (TP3 hit):         stop, outcome = "tp3" (full swing target)
//
// Within a single bar where both SL and TP would trigger: TP takes priority if
// a lower TP was already hit in a previous bar (SL assumed moved). Otherwise SL
// wins (conservative).
export function resolveOutcome(
  signal: Pick<SignalLog, "side" | "entry_price" | "tp1" | "tp2" | "tp3" | "sl">,
  klines: Kline[],
): OutcomeResult | null {
  const { side, tp1, tp2, tp3, sl } = signal;
  const entry = signal.entry_price;
  const isLong = side === "long";

  let maxFav = 0;
  let maxAdv = 0;
  // Track highest TP reached so far (determines which phase we're in)
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

    // Highest TP check first (within a bar, highest TP wins)
    if (tp3Hit) {
      return { outcome: "tp3", outcomeAt: bar.closeTime, outcomePrice: tp3!, maxFavorable: maxFav, maxAdverse: maxAdv };
    }
    if (tp2Hit) {
      // Record TP2 but don't stop — keep watching for TP3 in future bars
      if (!bestTP || bestTP.outcome === "tp1") {
        bestTP = { outcome: "tp2", at: bar.closeTime, price: tp2! };
      }
    }
    if (tp1Hit && !bestTP) {
      bestTP = { outcome: "tp1", at: bar.closeTime, price: tp1! };
    }

    // SL logic depends on phase:
    //   Phase 0 (no TP hit): SL = actual loss → stop immediately
    //   Phase 1+ (TP already hit): SL = stopped out at break-even or better → return bestTP
    if (slHit) {
      if (!bestTP) {
        return { outcome: "sl", outcomeAt: bar.closeTime, outcomePrice: sl!, maxFavorable: maxFav, maxAdverse: maxAdv };
      }
      // Trade was profitable; SL stopped us out after TP1+ — lock in best result
      return { outcome: bestTP.outcome, outcomeAt: bar.closeTime, outcomePrice: bestTP.price, maxFavorable: maxFav, maxAdverse: maxAdv };
    }
  }

  // End of klines — return best TP reached so far if any
  if (bestTP) {
    return { outcome: bestTP.outcome, outcomeAt: bestTP.at, outcomePrice: bestTP.price, maxFavorable: maxFav, maxAdverse: maxAdv };
  }

  return null; // No level hit yet — still active
}
