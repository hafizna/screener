import type { Kline } from "./types";

// ─── ATR (Average True Range) ─────────────────────────────────────────────────
// SMA smoothing over `period` bars. Close enough to Wilder's RMA for TP/SL
// purposes and simpler to audit.
export function computeATR(klines: Kline[], period = 14): number {
  if (klines.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    trs.push(Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i - 1].close),
      Math.abs(klines[i].low  - klines[i - 1].close),
    ));
  }
  const window = trs.slice(-period);
  return window.reduce((s, v) => s + v, 0) / window.length;
}

// ─── Relative Strength vs BTC ─────────────────────────────────────────────────
// RS = (1 + coinChange) / (1 + btcChange) over the last `lookback` 4H bars.
// Using the ratio of returns (not raw change) keeps the sign correct when both
// are negative: RS > 1.0 = coin held up better than BTC.
export function computeRS(coinKlines4h: Kline[], btcKlines4h: Kline[], lookback = 4): number {
  if (coinKlines4h.length < lookback || btcKlines4h.length < lookback) return 1;
  const coin = coinKlines4h.slice(-lookback);
  const btc  = btcKlines4h.slice(-lookback);
  const coinRet = (coin[coin.length - 1].close - coin[0].open) / coin[0].open;
  const btcRet  = (btc[btc.length - 1].close  - btc[0].open)  / btc[0].open;
  const denom = 1 + btcRet;
  return denom !== 0 ? (1 + coinRet) / denom : 1;
}

// ─── Squeeze Potential Score (0–6) ────────────────────────────────────────────
// Bounce-specific quality score. Higher = more factors confirm a sharp reversal:
//
//   L/S positioning  (0–2): crowded shorts/longs = squeeze fuel
//   FR magnitude     (0–2): elevated funding = one side overextended
//   OI rising        (0–1): new money entering at the level
//   RS divergence    (0–1): coin outperforming (long) or underperforming (short) BTC
//
// Interpretation is side-aware so it works for both bounce longs and short setups.
export function computeSqueezeScore(
  side: "long" | "short",
  fundingRate?: number,
  longShortRatio?: number,
  oiBias?: string,
  relativeStrength?: number,
): number {
  let score = 0;

  if (side === "long") {
    if (longShortRatio !== undefined) {
      if (longShortRatio < 0.85) score += 2;       // clear short majority = squeeze fuel
      else if (longShortRatio < 1.0) score += 1;
    }
    if (fundingRate !== undefined) {
      if (fundingRate > 0.005) score += 2;          // > +0.50%: longs being heavily punished
      else if (fundingRate > 0.001) score += 1;     // > +0.10%: elevated
    }
  } else {
    if (longShortRatio !== undefined) {
      if (longShortRatio > 1.3) score += 2;
      else if (longShortRatio > 1.0) score += 1;
    }
    if (fundingRate !== undefined) {
      if (fundingRate < -0.001) score += 2;
      else if (fundingRate < 0) score += 1;
    }
  }

  if (oiBias === "rising") score += 1;

  if (relativeStrength !== undefined) {
    if (side === "long"  && relativeStrength > 1.1) score += 1;
    if (side === "short" && relativeStrength < 0.9) score += 1;
  }

  return Math.min(score, 6);
}
