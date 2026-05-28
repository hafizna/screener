// Single source of truth for shapes used across the screener.

export type Timeframe = "15m" | "30m" | "1h" | "4h";

export type SignalSide = "long" | "short";
export type BiasSide = SignalSide | "neutral";

export type ZLevel = 1 | 2 | 3; // 1 = normal, 2 = large, 3 = extreme

// Funding rate bias relative to the signal side.
// Positive FR = longs pay shorts; negative FR = shorts pay longs.
export type FRBias = "favorable" | "neutral" | "unfavorable";

// Whether the trigger bar's taker buy pressure aligns with the signal direction.
export type DeltaBias = "aligned" | "neutral" | "opposed";

// Global long/short account positioning for a symbol.
export type LsBias = "crowded_shorts" | "balanced" | "crowded_longs";

// High-level market regime derived from BTC 4H price action + FR.
export type MarketRegime = "flush" | "neutral" | "breakout";

// What kind of setup the signal represents given the current regime.
export type SignalType = "bounce" | "continuation" | "standard";

export type WatchState = "watch" | "near_trigger";
export type BiasWindow = "1-2d" | "3-5d" | "5-7d";

export interface Kline {
  openTime: number;   // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  takerBuyVolume: number; // aggressive buy volume; takerSell = volume - takerBuyVolume
}

// Computed market profile for one "session" window.
// We don't have intraday session boundaries (those are FX/equity concepts),
// so a "session" here is a rolling N-bar window — see profile.ts for why.
export interface MarketProfile {
  tickSize: number;     // price increment per TPO row
  priceMin: number;     // bottom of profile
  priceMax: number;     // top of profile
  tpoCounts: number[];  // index 0 = priceMin row, last = priceMax row
  pocIndex: number;
  valIndex: number;
  vahIndex: number;
  poc: number;          // price at POC
  val: number;          // price at value-area-low
  vah: number;          // price at value-area-high
  totalTpos: number;
}

export interface Signal {
  symbol: string;
  timeframe: Timeframe;
  side: SignalSide;
  zLevel: ZLevel;
  zScore: number;       // raw z value for the trigger bar
  bias4h?: BiasSide;
  bias1h?: BiasSide;
  biasScore4h?: number;
  biasScore1h?: number;
  triggerLevel: "POC" | "VAH" | "VAL" | "PREV_POC" | "PREV_VAH" | "PREV_VAL";
  triggerPrice: number; // the MP level we touched
  barTime: number;      // openTime of trigger bar
  barClose: number;
  barHigh: number;
  barLow: number;
  // Confluence flags — for ranking / filtering on the dashboard
  nearVwap: boolean;
  nearWeeklyVwap: boolean;
  nearPdh: boolean;
  nearPdl: boolean;
  // For the table — pretty distances etc., precomputed server-side
  distanceFromLevel: number; // ticks
  // Funding rate at signal time (decimal: 0.0001 = +0.01% per 8h)
  fundingRate?: number;
  frBias?: FRBias;
  // Taker buy ratio of trigger bar (0–1). >0.55 = buy-dominated, <0.45 = sell-dominated.
  takerBuyRatio?: number;
  deltaBias?: DeltaBias;
  // Open interest % change over the last 4 × 15m periods at signal time.
  // Rising OI = new money entering the market (confirms either direction).
  oiChangePct?: number;
  oiBias?: "rising" | "flat" | "falling";
  // Global long/short account ratio at signal time.
  longShortRatio?: number;  // > 1 = more longs, < 1 = more shorts
  lsBias?: LsBias;
  // What kind of setup this is given the current market regime.
  signalType?: SignalType;
  // ATR-based targets (from 1H klines, 14-period SMA ATR)
  atr1h?: number;
  tp1?: number;     // entry + 1.5 × ATR (long) or entry - 1.5 × ATR (short)
  tp2?: number;     // entry + 3.0 × ATR (long) or entry - 3.0 × ATR (short)
  tp3?: number;     // entry + 5.0 × ATR — swing target (3-5 day hold)
  sl?: number;      // entry - 1.0 × ATR (long) or entry + 1.0 × ATR (short)
  // Relative Strength vs BTC over last 4 × 4H bars
  relativeStrength?: number;  // >1 = outperforming BTC
  rsBias?: "strong" | "neutral" | "weak";
  // Bounce quality composite (0–6)
  squeezeScore?: number;
}

export interface WatchCandidate {
  symbol: string;
  timeframe: Timeframe;
  side: SignalSide;
  state: WatchState;
  score: number;
  biasWindow?: BiasWindow;
  reasons: string[];
  missing: string[];
  zLevel: ZLevel;
  zScore: number;
  bias4h?: BiasSide;
  bias1h?: BiasSide;
  biasScore4h?: number;
  biasScore1h?: number;
  triggerLevel: Signal["triggerLevel"];
  triggerPrice: number;
  barTime: number;
  barClose: number;
  distanceFromLevel: number;
  fundingRate?: number;
  frBias?: FRBias;
  oiChangePct?: number;
  oiBias?: "rising" | "flat" | "falling";
  longShortRatio?: number;
  lsBias?: LsBias;
  signalType?: SignalType;
  relativeStrength?: number;
  rsBias?: "strong" | "neutral" | "weak";
  squeezeScore?: number;
}

export interface ScanResult {
  scannedAt: number;
  durationMs: number;
  symbolsScanned: number;
  symbolsErrored: string[];
  signals: Signal[];
  // Market regime at scan time, derived from BTC 4H + FR.
  regime?: MarketRegime;
  regimeSummary?: string;
  recentWindowBars?: number;
  watchlist?: WatchCandidate[];
}
