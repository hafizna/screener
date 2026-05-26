import type { Kline, ZLevel } from "./types";

// Rolling SMA — simple, matches Pine ta.sma when z_ma_mode == "SMA" (default).
// We don't bother with EMA mode; SMA is the more honest baseline for "is this
// bar unusually big vs recent history". EMA tilts toward very recent bars,
// which makes a string of high-volume bars look "normal" too fast.
function sma(values: number[], length: number, endIndex: number): number {
  if (endIndex < length - 1) return NaN;
  let sum = 0;
  for (let i = endIndex - length + 1; i <= endIndex; i++) sum += values[i];
  return sum / length;
}

function stdev(values: number[], length: number, endIndex: number): number {
  if (endIndex < length - 1) return NaN;
  const mean = sma(values, length, endIndex);
  let sumSq = 0;
  for (let i = endIndex - length + 1; i <= endIndex; i++) {
    const d = values[i] - mean;
    sumSq += d * d;
  }
  // Pine ta.stdev uses population stdev (divides by N), match that.
  return Math.sqrt(sumSq / length);
}

export interface ZResult {
  z: number;
  level: ZLevel;
}

export const DEFAULT_Z_LENGTH = 24;
export const DEFAULT_Z_THRESHOLD_LARGE = 1.5;
export const DEFAULT_Z_THRESHOLD_EXTREME = 2.5;

export function zScoreLastBar(
  klines: Kline[],
  length = DEFAULT_Z_LENGTH,
  thresholdLarge = DEFAULT_Z_THRESHOLD_LARGE,
  thresholdExtreme = DEFAULT_Z_THRESHOLD_EXTREME
): ZResult | null {
  if (klines.length < length) return null;
  const volumes = klines.map((k) => k.volume);
  const lastIdx = volumes.length - 1;
  const mean = sma(volumes, length, lastIdx);
  const sd = stdev(volumes, length, lastIdx);
  if (sd === 0 || !isFinite(sd)) return { z: 0, level: 1 };
  const z = (volumes[lastIdx] - mean) / sd;
  const level: ZLevel = z >= thresholdExtreme ? 3 : z >= thresholdLarge ? 2 : 1;
  return { z, level };
}

// Variant — compute z at an arbitrary bar (useful for replay and for the
// backtest harness later, even though we're not building that today).
export function zScoreAt(
  klines: Kline[],
  index: number,
  length = DEFAULT_Z_LENGTH,
  thresholdLarge = DEFAULT_Z_THRESHOLD_LARGE,
  thresholdExtreme = DEFAULT_Z_THRESHOLD_EXTREME
): ZResult | null {
  if (index < length - 1) return null;
  const volumes = klines.map((k) => k.volume);
  const mean = sma(volumes, length, index);
  const sd = stdev(volumes, length, index);
  if (sd === 0 || !isFinite(sd)) return { z: 0, level: 1 };
  const z = (volumes[index] - mean) / sd;
  const level: ZLevel = z >= thresholdExtreme ? 3 : z >= thresholdLarge ? 2 : 1;
  return { z, level };
}
