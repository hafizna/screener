import { buildProfile } from "./profile";
import type { BiasSide, Kline } from "./types";

export interface BiasResult {
  bias: BiasSide;
  score: number;
}

const PROFILE_WINDOW = 48;
const SMA_LENGTH = 20;
const MOMENTUM_LOOKBACK = 6;
const MOMENTUM_THRESHOLD = 0.002;

export function analyzeBias(klines: Kline[]): BiasResult {
  if (klines.length < SMA_LENGTH + 1) return { bias: "neutral", score: 0 };

  const window = klines.slice(-PROFILE_WINDOW);
  const last = klines[klines.length - 1];
  const profile = buildProfile(window);
  const sma = smaClose(klines, SMA_LENGTH);

  let score = 0;

  if (profile) {
    if (last.close > profile.vah) score += 2;
    else if (last.close > profile.poc) score += 1;
    else if (last.close < profile.val) score -= 2;
    else if (last.close < profile.poc) score -= 1;
  }

  if (last.close > sma) score += 1;
  else if (last.close < sma) score -= 1;

  const momentumBar = klines[Math.max(0, klines.length - 1 - MOMENTUM_LOOKBACK)];
  const momentum = (last.close - momentumBar.close) / momentumBar.close;
  if (momentum > MOMENTUM_THRESHOLD) score += 1;
  else if (momentum < -MOMENTUM_THRESHOLD) score -= 1;

  if (score >= 2) return { bias: "long", score };
  if (score <= -2) return { bias: "short", score };
  return { bias: "neutral", score };
}

function smaClose(klines: Kline[], length: number): number {
  const slice = klines.slice(-length);
  return slice.reduce((sum, k) => sum + k.close, 0) / slice.length;
}
