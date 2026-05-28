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
import type { FRBias, LsBias, MarketRegime, Signal, SignalType, ScanResult, WatchCandidate } from "@/lib/types";
import { analyzeBias } from "@/lib/bias";
import { detectRecentSignals, detectWatchCandidate } from "@/lib/signals";
import { storeScanResult } from "@/lib/kv";
import { ensureSchema, insertSignal, getActiveSignals, updateOutcome, expireOldSignals, pruneOldSignals } from "@/lib/db";
import { resolveOutcome } from "@/lib/outcomes";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SYMBOL_LIMIT  = parseInt(process.env.SYMBOL_LIMIT     ?? "150", 10);
const CONCURRENCY   = parseInt(process.env.FETCH_CONCURRENCY ?? "20",  10);
const RECENT_SIGNAL_BARS = parseInt(process.env.RECENT_SIGNAL_BARS ?? "8", 10);
const WATCHLIST_LIMIT = parseInt(process.env.WATCHLIST_LIMIT ?? "30", 10);

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
    const recentSignals = detectRecentSignals(symbol, "15m", entryKlines, RECENT_SIGNAL_BARS);
    const watchSeed = detectWatchCandidate(symbol, "15m", entryKlines);
    if (recentSignals.length === 0 && (!watchSeed || watchSeed.score < 5)) {
      return { signals: [] as Signal[], watch: null as WatchCandidate | null };
    }

    const [oneHourKlines, fourHourKlines, oiHistory, lsData] = await Promise.all([
      fetchKlines(symbol, "1h"),
      fetchKlines(symbol, "4h"),
      fetchOIHistory(symbol).catch(() => null),
      fetchLongShortRatio(symbol).catch(() => null),
    ]);

    const bias1h = analyzeBias(oneHourKlines);
    const bias4h = analyzeBias(fourHourKlines);

    // FR — interpretation flips in flush regime for longs
    const frInfo = fundingRates.get(symbol);

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

    // ATR-based targets from 1H klines
    const atr1h = computeATR(oneHourKlines, 14);

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
    const enrichedSignals = recentSignals
      .filter((signal) => passesBiasConfirmation(signal, bias1h, bias4h, regime))
      .map((signal) => {
        const frBias = frInfo !== undefined
          ? classifyFR(signal.side, frInfo.lastFundingRate, regime)
          : undefined;
        const signalType = determineSignalType(signal.side, regime, lsBias, frBias);
        const entry = signal.barClose;
        const tp1 = atr1h > 0 ? (signal.side === "long" ? entry + 1.5 * atr1h : entry - 1.5 * atr1h) : undefined;
        const tp2 = atr1h > 0 ? (signal.side === "long" ? entry + 3.0 * atr1h : entry - 3.0 * atr1h) : undefined;
        const sl  = atr1h > 0 ? (signal.side === "long" ? entry - 1.0 * atr1h : entry + 1.0 * atr1h) : undefined;
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

    const watch = watchSeed
      ? enrichWatchCandidate(watchSeed, {
          bias1h,
          bias4h,
          regime,
          fr: frInfo?.lastFundingRate,
          oiChangePct,
          oiBias,
          longShortRatio,
          lsBias,
          relativeStrength,
          rsBias,
        })
      : null;

    return { signals: enrichedSignals, watch };
  });

  // 5. Collect
  const signals: Signal[] = [];
  const watchlist: WatchCandidate[] = [];
  const errored: string[] = [];
  for (const r of results) {
    if ("error" in r) errored.push(r.item);
    else {
      signals.push(...r.result.signals);
      if (r.result.watch) watchlist.push(r.result.watch);
    }
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
  watchlist.sort((a, b) => b.score - a.score || b.zLevel - a.zLevel || Math.abs(b.zScore) - Math.abs(a.zScore));

  const scanResult: ScanResult = {
    scannedAt:       Date.now(),
    durationMs:      Date.now() - t0,
    symbolsScanned:  symbols.length,
    symbolsErrored:  errored,
    signals,
    regime:          regimeResult.regime,
    regimeSummary:   regimeResult.summary,
    recentWindowBars: RECENT_SIGNAL_BARS,
    watchlist:        watchlist.slice(0, WATCHLIST_LIMIT),
  };

  try {
    await storeScanResult(scanResult);
  } catch (e) {
    console.error("KV write failed", e);
    return NextResponse.json({ ...scanResult, kvError: (e as Error).message }, { status: 200 });
  }

  // 7. Persist new signals + check outcomes for active ones.
  //    Both are non-fatal — DB being down must not break the live scan.
  let dbSignalsInserted = 0;
  let dbOutcomesResolved = 0;
  let dbSignalsPruned = 0;
  try {
    await ensureSchema();

    // 7a. Insert new signals (ON CONFLICT DO NOTHING, so re-runs are safe)
    await Promise.all(signals.map((s) => insertSignal(s, scanResult.scannedAt, regime)));
    dbSignalsInserted = signals.length;

    // 7b. Expire stale active signals (> 24h old, no level hit)
    await expireOldSignals();

    // 7c. Resolve outcomes for active signals
    const active = await getActiveSignals();
    if (active.length > 0) {
      // Fetch klines only for symbols that have active signals (de-duped)
      const symbolsToCheck = [...new Set(active.map((s) => s.symbol))];
      const klinesMap = new Map<string, Awaited<ReturnType<typeof fetchKlines>>>();
      await Promise.all(
        symbolsToCheck.map(async (sym) => {
          const k = await fetchKlines(sym, "15m").catch(() => null);
          if (k) klinesMap.set(sym, k);
        })
      );

      await Promise.all(
        active.map(async (row) => {
          const klines = klinesMap.get(row.symbol);
          if (!klines) return;
          // Only consider bars that came after this signal's bar
          const afterSignal = klines.filter((k) => k.openTime > row.bar_time);
          const result = resolveOutcome(row, afterSignal);
          if (!result) return;
          await updateOutcome(row.id, result.outcome, result.outcomeAt, result.outcomePrice, result.maxFavorable, result.maxAdverse);
          dbOutcomesResolved++;
        })
      );
    }

    // 7d. Retention cleanup to keep DB storage bounded.
    dbSignalsPruned = await pruneOldSignals();
  } catch (e) {
    console.error("DB write failed", e);
  }

  return NextResponse.json({
    scannedAt:      scanResult.scannedAt,
    durationMs:     Date.now() - t0,
    symbolsScanned: scanResult.symbolsScanned,
    signalsFound:   scanResult.signals.length,
    watchlistFound: scanResult.watchlist?.length ?? 0,
    recentWindowBars: RECENT_SIGNAL_BARS,
    errors:         scanResult.symbolsErrored.length,
    regime:         scanResult.regime,
    dbSignalsInserted,
    dbOutcomesResolved,
    dbSignalsPruned,
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// In FLUSH regime, long signals with bearish HTF are contrarian bounces — don't block them.
// Shorts confirmed normally; so do all non-flush signals.
type Bias = ReturnType<typeof analyzeBias>;

function enrichWatchCandidate(
  watch: WatchCandidate,
  ctx: {
    bias1h: Bias;
    bias4h: Bias;
    regime: MarketRegime;
    fr?: number;
    oiChangePct?: number;
    oiBias?: "rising" | "flat" | "falling";
    longShortRatio?: number;
    lsBias?: LsBias;
    relativeStrength?: number;
    rsBias?: Signal["rsBias"];
  }
): WatchCandidate {
  const frBias = ctx.fr !== undefined ? classifyFR(watch.side, ctx.fr, ctx.regime) : undefined;
  const signalType = determineSignalType(watch.side, ctx.regime, ctx.lsBias, frBias);
  const squeezeScore = computeSqueezeScore(
    watch.side,
    ctx.fr,
    ctx.longShortRatio,
    ctx.oiBias,
    ctx.relativeStrength,
  );

  let score = watch.score;
  const reasons = [...watch.reasons];
  const missing = [...watch.missing];
  const opposite = watch.side === "long" ? "short" : "long";

  if (ctx.bias4h.bias === watch.side || ctx.bias1h.bias === watch.side) {
    score += 2;
    reasons.push("HTF bias supportive");
  } else if (ctx.bias4h.bias === opposite || ctx.bias1h.bias === opposite) {
    score -= 2;
    missing.push("HTF bias currently opposite");
  }

  if (frBias === "favorable") score += 1;
  if (frBias === "unfavorable") score -= 1;

  const favoredLs = watch.side === "long" ? "crowded_shorts" : "crowded_longs";
  const opposedLs = watch.side === "long" ? "crowded_longs" : "crowded_shorts";
  if (ctx.lsBias === favoredLs) score += 1;
  if (ctx.lsBias === opposedLs) score -= 1;
  if (ctx.oiBias === "rising") score += 1;
  if ((watch.side === "long" && ctx.rsBias === "strong") || (watch.side === "short" && ctx.rsBias === "weak")) score += 1;
  if ((watch.side === "long" && ctx.rsBias === "weak") || (watch.side === "short" && ctx.rsBias === "strong")) score -= 1;
  score += Math.min(2, Math.floor(squeezeScore / 3));

  return {
    ...watch,
    score,
    reasons,
    missing,
    bias1h: ctx.bias1h.bias,
    bias4h: ctx.bias4h.bias,
    biasScore1h: ctx.bias1h.score,
    biasScore4h: ctx.bias4h.score,
    ...(ctx.fr !== undefined ? { fundingRate: ctx.fr, frBias } : {}),
    ...(ctx.oiChangePct !== undefined ? { oiChangePct: ctx.oiChangePct, oiBias: ctx.oiBias } : {}),
    ...(ctx.longShortRatio !== undefined ? { longShortRatio: ctx.longShortRatio, lsBias: ctx.lsBias } : {}),
    signalType,
    ...(ctx.relativeStrength !== undefined ? { relativeStrength: ctx.relativeStrength, rsBias: ctx.rsBias } : {}),
    squeezeScore,
  };
}

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
