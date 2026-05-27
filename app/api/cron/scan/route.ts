import { NextRequest, NextResponse } from "next/server";
import {
  fetchFundingRates,
  fetchKlines,
  fetchLongShortRatio,
  fetchOIHistory,
  fetchTopSymbolsByVolume,
  withConcurrency,
} from "@/lib/binance";
import { detectBTCRegime } from "@/lib/regime";
import { computeATR, computeRS, computeSqueezeScore } from "@/lib/atr";
import type { FRBias, LsBias, MarketRegime, Signal, SignalType, ScanResult } from "@/lib/types";
import { analyzeBias } from "@/lib/bias";
import { detectSignal } from "@/lib/signals";
import { storeScanResult } from "@/lib/kv";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SYMBOL_LIMIT  = parseInt(process.env.SYMBOL_LIMIT     ?? "150", 10);
const CONCURRENCY   = parseInt(process.env.FETCH_CONCURRENCY ?? "20",  10);

function authorize(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${expected}`;
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();

  // 1. Symbol universe
  let symbols: string[];
  try {
    symbols = await fetchTopSymbolsByVolume(SYMBOL_LIMIT);
  } catch (e) {
    return NextResponse.json(
      { error: "failed to fetch symbol list", detail: (e as Error).message },
      { status: 502 }
    );
  }

  // 2. Pre-loop batch fetches — run in parallel, all non-fatal.
  //    fundingRates : one call for all symbols (weight 10)
  //    btcKlines4h  : BTC 4H for regime detection (weight 2)
  const [fundingRates, btcKlines4h] = await Promise.all([
    fetchFundingRates().catch((e: Error) => {
      console.warn("FR fetch failed:", e.message);
      return new Map<string, { lastFundingRate: number }>();
    }),
    fetchKlines("BTCUSDT", "4h").catch(() => null),
  ]);

  // 3. Detect market regime from BTC 4H + BTC FR
  const btcFR = fundingRates.get("BTCUSDT")?.lastFundingRate ?? 0;
  const regimeResult = btcKlines4h
    ? detectBTCRegime(btcKlines4h, btcFR)
    : { regime: "neutral" as const, btcMomentum12h: 0, btcFR: 0, summary: "BTC data unavailable" };

  const regime = regimeResult.regime;

  // 4. Main scan loop — 15m signal detection, then HTF enrichment only if triggered.
  const results = await withConcurrency(symbols, CONCURRENCY, async (symbol) => {
    const entryKlines = await fetchKlines(symbol, "15m");
    const signal = detectSignal(symbol, "15m", entryKlines);
    if (!signal) return null;

    const [oneHourKlines, fourHourKlines, oiHistory, lsData] = await Promise.all([
      fetchKlines(symbol, "1h"),
      fetchKlines(symbol, "4h"),
      fetchOIHistory(symbol).catch(() => null),
      fetchLongShortRatio(symbol).catch(() => null),
    ]);

    const bias1h = analyzeBias(oneHourKlines);
    const bias4h = analyzeBias(fourHourKlines);
    if (!passesBiasConfirmation(signal, bias1h, bias4h, regime)) return null;

    // FR — interpretation flips in flush regime for longs
    const frInfo = fundingRates.get(symbol);
    const frBias = frInfo !== undefined
      ? classifyFR(signal.side, frInfo.lastFundingRate, regime)
      : undefined;

    // OI
    let oiChangePct: number | undefined;
    let oiBias: "rising" | "flat" | "falling" | undefined;
    if (oiHistory && oiHistory.length >= 2) {
      const oldest = oiHistory[0].openInterest;
      const latest = oiHistory[oiHistory.length - 1].openInterest;
      if (oldest > 0) {
        oiChangePct = ((latest - oldest) / oldest) * 100;
        oiBias = oiChangePct > 0.5 ? "rising" : oiChangePct < -0.5 ? "falling" : "flat";
      }
    }

    // L/S ratio
    const longShortRatio = lsData?.longShortRatio;
    const lsBias: LsBias | undefined = longShortRatio !== undefined
      ? longShortRatio < 0.85 ? "crowded_shorts"
      : longShortRatio > 1.20 ? "crowded_longs"
      : "balanced"
      : undefined;

    // Signal type — what kind of setup is this given the regime?
    const signalType = determineSignalType(signal.side, regime, lsBias, frBias);

    // ATR-based targets from 1H klines
    const atr1h = computeATR(oneHourKlines, 14);
    const entry = signal.barClose;
    const tp1 = atr1h > 0 ? (signal.side === "long" ? entry + 1.5 * atr1h : entry - 1.5 * atr1h) : undefined;
    const tp2 = atr1h > 0 ? (signal.side === "long" ? entry + 3.0 * atr1h : entry - 3.0 * atr1h) : undefined;
    const sl  = atr1h > 0 ? (signal.side === "long" ? entry - 1.0 * atr1h : entry + 1.0 * atr1h) : undefined;

    // Relative Strength vs BTC (reuses already-fetched 4H klines)
    const relativeStrength = btcKlines4h
      ? computeRS(fourHourKlines, btcKlines4h)
      : undefined;
    const rsBias: Signal["rsBias"] =
      relativeStrength === undefined ? undefined
      : relativeStrength > 1.1 ? "strong"
      : relativeStrength < 0.9 ? "weak"
      : "neutral";

    // Squeeze Potential Score (0–6)
    const squeezeScore = computeSqueezeScore(
      signal.side,
      frInfo?.lastFundingRate,
      longShortRatio,
      oiBias,
      relativeStrength,
    );

    return {
      ...signal,
      bias1h:      bias1h.bias,
      bias4h:      bias4h.bias,
      biasScore1h: bias1h.score,
      biasScore4h: bias4h.score,
      ...(frInfo !== undefined ? { fundingRate: frInfo.lastFundingRate, frBias } : {}),
      ...(oiChangePct !== undefined ? { oiChangePct, oiBias } : {}),
      ...(longShortRatio !== undefined ? { longShortRatio, lsBias } : {}),
      signalType,
      ...(atr1h > 0 ? { atr1h, tp1, tp2, sl } : {}),
      ...(relativeStrength !== undefined ? { relativeStrength, rsBias } : {}),
      squeezeScore,
    };
  });

  // 5. Collect
  const signals: Signal[] = [];
  const errored: string[] = [];
  for (const r of results) {
    if ("error" in r) errored.push(r.item);
    else if (r.result)  signals.push(r.result);
  }

  // 6. Rank — HTF + FR + delta + OI + L/S, then Z
  signals.sort((a, b) => {
    const frW    = (s: Signal) => s.frBias    === "favorable"     ? 1 : s.frBias    === "unfavorable"  ? -1 : 0;
    const dW     = (s: Signal) => s.deltaBias === "aligned"       ? 1 : s.deltaBias === "opposed"      ? -1 : 0;
    const oiW    = (s: Signal) => s.oiBias    === "rising"        ? 1 : s.oiBias    === "falling"      ? -1 : 0;
    const lsW    = (s: Signal) => {
      if (!s.lsBias) return 0;
      const favored = s.side === "long" ? "crowded_shorts" : "crowded_longs";
      const opposed = s.side === "long" ? "crowded_longs"  : "crowded_shorts";
      return s.lsBias === favored ? 1 : s.lsBias === opposed ? -1 : 0;
    };
    const rsW    = (s: Signal) => s.rsBias === "strong"           ? 1 : s.rsBias   === "weak"          ? -1 : 0;
    const scoreA = (a.biasScore4h ?? 0) + (a.biasScore1h ?? 0) + frW(a) + dW(a) + oiW(a) + lsW(a) + rsW(a);
    const scoreB = (b.biasScore4h ?? 0) + (b.biasScore1h ?? 0) + frW(b) + dW(b) + oiW(b) + lsW(b) + rsW(b);
    if (scoreB !== scoreA) return scoreB - scoreA;
    if (b.zLevel !== a.zLevel) return b.zLevel - a.zLevel;
    return Math.abs(b.zScore) - Math.abs(a.zScore);
  });

  const scanResult: ScanResult = {
    scannedAt:       Date.now(),
    durationMs:      Date.now() - t0,
    symbolsScanned:  symbols.length,
    symbolsErrored:  errored,
    signals,
    regime:          regimeResult.regime,
    regimeSummary:   regimeResult.summary,
  };

  try {
    await storeScanResult(scanResult);
  } catch (e) {
    console.error("KV write failed", e);
    return NextResponse.json({ ...scanResult, kvError: (e as Error).message }, { status: 200 });
  }

  return NextResponse.json({
    scannedAt:      scanResult.scannedAt,
    durationMs:     scanResult.durationMs,
    symbolsScanned: scanResult.symbolsScanned,
    signalsFound:   scanResult.signals.length,
    errors:         scanResult.symbolsErrored.length,
    regime:         scanResult.regime,
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// In FLUSH regime, long signals with bearish HTF are contrarian bounces — don't block them.
// Shorts confirmed normally; so do all non-flush signals.
type Bias = ReturnType<typeof analyzeBias>;
function passesBiasConfirmation(
  signal: Signal,
  bias1h: Bias,
  bias4h: Bias,
  regime: MarketRegime
): boolean {
  if (regime === "flush" && signal.side === "long") return true;
  const opposite = signal.side === "long" ? "short" : "long";
  if (bias4h.bias === opposite || bias1h.bias === opposite) return false;
  if (bias4h.bias === signal.side || bias1h.bias === signal.side) return true;
  return Math.abs(bias4h.score) >= 3 && Math.abs(bias1h.score) <= 1;
}

// FR classification is regime-aware.
// In a FLUSH for longs: high positive FR = shorts overcrowded at support = squeeze fuel → FAVORABLE.
// In all other cases: standard logic.
function classifyFR(side: "long" | "short", fr: number, regime: MarketRegime): FRBias {
  if (regime === "flush" && side === "long") {
    if (fr > 0.0005) return "favorable";  // > +0.05%: shorts are paying, crowded
    if (fr < 0)      return "neutral";    // negative FR in flush = unusual
    return "neutral";
  }
  if (side === "long") {
    if (fr < 0)    return "favorable";
    if (fr > 0.001) return "unfavorable"; // > +0.10%: longs crowded in normal market
    return "neutral";
  }
  // short
  if (fr > 0.0005) return "favorable";
  if (fr < 0)      return "unfavorable";
  return "neutral";
}

function determineSignalType(
  side: "long" | "short",
  regime: MarketRegime,
  lsBias?: LsBias,
  frBias?: FRBias
): SignalType {
  if (regime === "flush" && side === "long") {
    // Bounce: flush + long + at least one confirming squeeze factor
    if (lsBias === "crowded_shorts" || frBias === "favorable") return "bounce";
    return "bounce"; // still a bounce candidate even without extra confirmation
  }
  if (regime === "breakout" && side === "long") return "continuation";
  return "standard";
}
