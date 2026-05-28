import type { Kline } from "./types";
import type { Outcome, SignalLog } from "./db";

interface OutcomeResult {
  outcome: Outcome;
  outcomeAt: number;
  outcomePrice: number;
  maxFavorable: number; // best excursion in direction of trade (MFE)
  maxAdverse:   number; // worst excursion against the trade (MAE)
}

// Process klines that came AFTER the signal bar and determine the outcome.
// Priority within a single bar: SL > TP2 > TP1 (conservative — assume worst fills).
// Returns null if no level was hit yet and the signal hasn't expired.
export function resolveOutcome(
  signal: Pick<SignalLog, "side" | "entry_price" | "tp1" | "tp2" | "sl" | "bar_time">,
  klines: Kline[],  // bars after the signal bar, chronological order
): OutcomeResult | null {
  const { side, entry_price: entry, tp1, tp2, sl } = signal;
  const isLong = side === "long";

  let maxFav = 0;
  let maxAdv = 0;

  for (const bar of klines) {
    // Track excursions relative to entry
    const favorable = isLong ? bar.high - entry : entry - bar.low;
    const adverse   = isLong ? entry - bar.low  : bar.high - entry;
    if (favorable > maxFav) maxFav = favorable;
    if (adverse   > maxAdv) maxAdv = adverse;

    const slHit  = sl  !== null && (isLong ? bar.low  <= sl  : bar.high >= sl);
    const tp2Hit = tp2 !== null && (isLong ? bar.high >= tp2 : bar.low  <= tp2);
    const tp1Hit = tp1 !== null && (isLong ? bar.high >= tp1 : bar.low  <= tp1);

    if (slHit) {
      return { outcome: "sl",  outcomeAt: bar.closeTime, outcomePrice: sl!,  maxFavorable: maxFav, maxAdverse: maxAdv };
    }
    if (tp2Hit) {
      return { outcome: "tp2", outcomeAt: bar.closeTime, outcomePrice: tp2!, maxFavorable: maxFav, maxAdverse: maxAdv };
    }
    if (tp1Hit) {
      return { outcome: "tp1", outcomeAt: bar.closeTime, outcomePrice: tp1!, maxFavorable: maxFav, maxAdverse: maxAdv };
    }
  }

  // Expired: 24h have passed since signal without hitting any level
  const ageMs = Date.now() - signal.bar_time;
  if (ageMs > 24 * 60 * 60_000) {
    const lastClose = klines.at(-1)?.close ?? entry;
    return { outcome: "expired", outcomeAt: Date.now(), outcomePrice: lastClose, maxFavorable: maxFav, maxAdverse: maxAdv };
  }

  return null; // still active, check again next scan
}
