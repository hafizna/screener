import type { Kline } from "./types";
import type { Outcome, SignalLog } from "./db";

interface OutcomeResult {
  outcome: Outcome;
  outcomeAt: number;
  outcomePrice: number;
  maxFavorable: number;
  maxAdverse:   number;
}

// Process klines that came AFTER the signal bar and determine the outcome.
// Priority within a single bar: SL > TP3 > TP2 > TP1 (conservative — assume worst fills).
// Time-based expiry is handled by expireOldSignals() in db.ts; this function
// only returns non-null when a price level is actually hit.
export function resolveOutcome(
  signal: Pick<SignalLog, "side" | "entry_price" | "tp1" | "tp2" | "tp3" | "sl">,
  klines: Kline[],
): OutcomeResult | null {
  const { side, entry_price: entry, tp1, tp2, tp3, sl } = signal;
  const isLong = side === "long";

  let maxFav = 0;
  let maxAdv = 0;

  for (const bar of klines) {
    const favorable = isLong ? bar.high - entry : entry - bar.low;
    const adverse   = isLong ? entry - bar.low  : bar.high - entry;
    if (favorable > maxFav) maxFav = favorable;
    if (adverse   > maxAdv) maxAdv = adverse;

    const slHit  = sl  != null && (isLong ? bar.low  <= sl  : bar.high >= sl);
    const tp3Hit = tp3 != null && (isLong ? bar.high >= tp3 : bar.low  <= tp3);
    const tp2Hit = tp2 != null && (isLong ? bar.high >= tp2 : bar.low  <= tp2);
    const tp1Hit = tp1 != null && (isLong ? bar.high >= tp1 : bar.low  <= tp1);

    if (slHit)  return { outcome: "sl",  outcomeAt: bar.closeTime, outcomePrice: sl!,  maxFavorable: maxFav, maxAdverse: maxAdv };
    if (tp3Hit) return { outcome: "tp3", outcomeAt: bar.closeTime, outcomePrice: tp3!, maxFavorable: maxFav, maxAdverse: maxAdv };
    if (tp2Hit) return { outcome: "tp2", outcomeAt: bar.closeTime, outcomePrice: tp2!, maxFavorable: maxFav, maxAdverse: maxAdv };
    if (tp1Hit) return { outcome: "tp1", outcomeAt: bar.closeTime, outcomePrice: tp1!, maxFavorable: maxFav, maxAdverse: maxAdv };
  }

  return null;
}
