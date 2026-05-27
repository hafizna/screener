import type { Kline, MarketRegime } from "./types";
import { zScoreLastBar } from "./zscore";

export interface RegimeResult {
  regime: MarketRegime;
  btcMomentum12h: number; // % change over last 3 × 4H bars (~12 hours)
  btcFR: number;
  summary: string;        // human-readable label for the dashboard banner
}

// Determines the current market regime from BTC 4H klines + BTC funding rate.
//
// FLUSH:     BTC dropped ≥2% in 12h AND (FR elevated OR volume spike)
//            OR dropped ≥3% regardless.
//            → alt longs at MP support become contrarian bounce setups.
//              In this regime: high positive FR = shorts overcrowded = squeeze fuel.
//              HTF bias confirmation is relaxed so bounce candidates aren't filtered out.
//
// BREAKOUT:  BTC gained ≥2% in 12h.
//            → look for trend continuation, not fades.
//
// NEUTRAL:   everything else — standard signal logic applies.
export function detectBTCRegime(
  btcKlines4h: Kline[],
  btcFR: number
): RegimeResult {
  if (btcKlines4h.length < 4) {
    return { regime: "neutral", btcMomentum12h: 0, btcFR, summary: "Insufficient BTC data" };
  }

  // Price change over last 3 completed 4H bars (~12 hours)
  const recent = btcKlines4h.slice(-4);
  const from   = recent[0].open;
  const to     = recent[recent.length - 1].close;
  const momentum = (to - from) / from * 100;

  // Volume anomaly on the most recent BTC 4H bar
  const z = zScoreLastBar(btcKlines4h);
  const volSpike = z ? z.level >= 2 : false;

  const frPct  = (btcFR * 100).toFixed(3);
  const momStr = `${momentum >= 0 ? "+" : ""}${momentum.toFixed(1)}%`;

  let regime: MarketRegime;
  let summary: string;

  if (momentum <= -2 && (btcFR > 0.0005 || volSpike)) {
    regime  = "flush";
    summary = `BTC ${momStr} 12h · FR ${frPct}% · shorts crowded`;
  } else if (momentum <= -3) {
    regime  = "flush";
    summary = `BTC sharp drop ${momStr} 12h`;
  } else if (momentum >= 2) {
    regime  = "breakout";
    summary = `BTC ${momStr} 12h`;
  } else {
    regime  = "neutral";
    summary = `BTC ${momStr} 12h`;
  }

  return { regime, btcMomentum12h: momentum, btcFR, summary };
}
