import type { Kline, MarketRegime } from "./types";
import { zScoreLastBar } from "./zscore";

export interface RegimeResult {
  regime: MarketRegime;
  btcMomentum12h: number; // % change open→close over last 3 × 4H bars (~12 hours)
  btcDrawdown12h: number; // % change from 12h-window HIGH to current close (always ≤ 0 when dumping)
  btcFR: number;
  summary: string;        // human-readable label for the dashboard banner
}

// Determines the current market regime from BTC 4H klines + BTC funding rate.
//
// FLUSH:    BTC dropped ≥2% from 12h-window HIGH to current close
//             AND (FR elevated OR volume spike)
//           OR dropped ≥3% from the 12h high regardless.
//           Measuring from the HIGH (not the open) catches the case where BTC
//           pumped earlier in the window then reversed — the net open-to-close
//           would look flat/positive but alts are already getting slapped from
//           the top.
//           → alt longs at MP support become contrarian bounce setups.
//             High positive FR = shorts overcrowded = squeeze fuel.
//             HTF bias confirmation is relaxed; bounce candidates aren't filtered out.
//
// BREAKOUT: BTC net open→close gain ≥2% over 12h.
//           Measured net (not from high) so a pump-then-small-pullback still
//           counts as breakout, not flush.
//           → look for trend continuation, not fades.
//
// NEUTRAL:  everything else — standard signal logic applies.
export function detectBTCRegime(
  btcKlines4h: Kline[],
  btcFR: number
): RegimeResult {
  if (btcKlines4h.length < 4) {
    return { regime: "neutral", btcMomentum12h: 0, btcDrawdown12h: 0, btcFR, summary: "Insufficient BTC data" };
  }

  // Last 3 completed 4H bars + the bar before them for open reference
  const recent = btcKlines4h.slice(-4);
  const from   = recent[0].open;
  const to     = recent[recent.length - 1].close;

  // Net directional momentum (open 12h ago → current close)
  const momentum = (to - from) / from * 100;

  // Actual drawdown: from the HIGHEST point seen in the 12h window to current close.
  // This catches pump-then-dump patterns that look flat on open→close.
  const periodHigh = Math.max(...recent.map((k) => k.high));
  const drawdown   = (to - periodHigh) / periodHigh * 100; // ≤ 0 when below the window high

  // Volume anomaly on the most recent BTC 4H bar
  const z = zScoreLastBar(btcKlines4h);
  const volSpike = z ? z.level >= 2 : false;

  const frPct      = (btcFR * 100).toFixed(3);
  const momStr     = `${momentum >= 0 ? "+" : ""}${momentum.toFixed(1)}%`;
  const drawStr    = drawdown < -0.1 ? ` (−${Math.abs(drawdown).toFixed(1)}% off high)` : "";

  let regime: MarketRegime;
  let summary: string;

  // Flush check uses drawdown-from-high so a pump-then-dump is caught even
  // when net 12h momentum looks benign.
  if (drawdown <= -2 && (btcFR > 0.0005 || volSpike)) {
    regime  = "flush";
    summary = `BTC ${momStr} net${drawStr} · FR ${frPct}% · shorts crowded`;
  } else if (drawdown <= -3) {
    regime  = "flush";
    summary = `BTC sharp drop from high${drawStr} · net ${momStr}`;
  } else if (momentum >= 2) {
    // Breakout: sustained net move up. Don't use drawdown here — a minor
    // pullback after a big pump should still read as breakout, not flush.
    regime  = "breakout";
    summary = `BTC ${momStr} 12h${drawStr}`;
  } else {
    regime  = "neutral";
    summary = `BTC ${momStr} 12h${drawStr}`;
  }

  return { regime, btcMomentum12h: momentum, btcDrawdown12h: drawdown, btcFR, summary };
}
