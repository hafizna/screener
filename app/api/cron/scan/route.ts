import { NextRequest, NextResponse } from "next/server";
import {
  fetchFundingRates,
  fetchKlines,
  fetchKlineRange,
  fetchLongShortRatio,
  fetchOIHistory,
  fetchTopSymbolsByVolume,
  withConcurrency,
} from "@/lib/binance";
import { detectBTCRegime } from "@/lib/regime";
import { computeATR, computeRS, computeSqueezeScore } from "@/lib/atr";
import type { BiasWindow, FRBias, LsBias, MarketRegime, Signal, SignalType, ScanResult, WatchCandidate } from "@/lib/types";
import { analyzeBias } from "@/lib/bias";
import { classifyFR, classifyLs } from "@/lib/funding";
import { detectRecentSignals, detectWatchCandidate } from "@/lib/signals";
import { dailyVwap, weeklyVwap, monthlyVwap, signedDistPct, computeVwapLevels, prevQuarterAnchorFloor } from "@/lib/vwap";
import { computeTargets } from "@/lib/targets";
import { storeScanResult, loadLatestScan } from "@/lib/kv";
import { ensureSchema, insertSignal, getActiveSignals, updateOutcome, updateBestTP, expireOldSignals, pruneOldSignals, upsertRadarCandidates, markRadarFired, pruneStaleRadar, insertScanFunnel, insertSignalTraceSnapshot } from "@/lib/db";
import { getBtcContextLive } from "@/lib/btc";
import type { RadarUpsert } from "@/lib/db";
import { resolveOutcome } from "@/lib/outcomes";
import { MODEL_PARAMS_HASH, MODEL_VERSION } from "@/lib/model";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SYMBOL_LIMIT  = parseInt(process.env.SYMBOL_LIMIT     ?? "150", 10);
const CONCURRENCY   = parseInt(process.env.FETCH_CONCURRENCY ?? "20",  10);
const RECENT_SIGNAL_BARS    = parseInt(process.env.RECENT_SIGNAL_BARS    ?? "8", 10);
const RECENT_SIGNAL_BARS_1H = parseInt(process.env.RECENT_SIGNAL_BARS_1H ?? "4", 10);
const WATCHLIST_LIMIT = parseInt(process.env.WATCHLIST_LIMIT ?? "30", 10);

interface ScanLoopResult {
  signals: Signal[];
  watch: WatchCandidate | null;
  entryCandidates15m: number;
  entryCandidates1h: number;
  passedZ: number;
  passedBias: number;
}

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

  // 3b. Load previous scan's watchlist — used to tag "fromWatchlist" on new signals.
  //     A signal is "from watchlist" if its symbol+side was a WatchCandidate last scan,
  //     meaning the setup was already on radar before the z-score fired.
  const prevScan = await loadLatestScan().catch(() => null);
  const prevWatchedKeys = new Set(
    (prevScan?.watchlist ?? []).map((w) => `${w.symbol}-${w.side}`)
  );

  // 4. Main scan loop — 15m signal detection, then HTF enrichment only if triggered.
  const results = await withConcurrency(symbols, CONCURRENCY, async (symbol) => {
    const entryKlines = await fetchKlines(symbol, "15m");
    const recentSignals = detectRecentSignals(symbol, "15m", entryKlines, RECENT_SIGNAL_BARS);
    const watchSeed = detectWatchCandidate(symbol, "15m", entryKlines);
    if (recentSignals.length === 0 && (!watchSeed || watchSeed.score < 5)) {
      return {
        signals: [],
        watch: null,
        entryCandidates15m: recentSignals.length,
        entryCandidates1h: 0,
        passedZ: recentSignals.length,
        passedBias: 0,
      } satisfies ScanLoopResult;
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
      ? classifyLs(longShortRatio)
      : undefined;

    // Signal type — what kind of setup is this given the regime?

    // ATR-based targets from 1H klines
    const atr1h = computeATR(oneHourKlines, 14);

    // Anchored VWAPs (free — klines already fetched). Daily from 15m, weekly
    // from 1h. Used as observable confluence and to anchor TP2/TP3 magnets.
    const vwapDaily = dailyVwap(entryKlines);
    const vwapWeekly = weeklyVwap(oneHourKlines);
    // Monthly VWAP from 4h klines (≈33 days, enough to anchor at the 1st). Powers
    // the board quality filter's confluence gate; costs no extra fetch.
    const vwapMonthly = monthlyVwap(fourHourKlines);

    // Also detect 1H signals (free — klines already fetched above)
    const recentSignals1h = detectRecentSignals(symbol, "1h", oneHourKlines, RECENT_SIGNAL_BARS_1H);
    const allRecentSignals = [...recentSignals, ...recentSignals1h];

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
    const enrichedSignals = allRecentSignals
      .filter((signal) => passesBiasConfirmation(signal, bias1h, bias4h))
      .map((signal) => {
        const frBias = frInfo !== undefined
          ? classifyFR(signal.side, frInfo.lastFundingRate, regime)
          : undefined;
        const signalType = determineSignalType(signal.side, regime, lsBias, frBias);
        const entry = signal.barClose;
        // VWAP-anchored targets: TP1 fixed at 1.5× ATR, TP2/TP3 snap to the
        // nearest VWAP magnet inside the 3×/5× ATR caps (or fall back to ATR).
        const targets = computeTargets({ entry, side: signal.side, atr: atr1h, vwapDaily, vwapWeekly });
        const { sl, tp1, tp2, tp3, tp2Source, tp3Source } = targets;
        const squeezeScore = computeSqueezeScore(
          signal.side,
          frInfo?.lastFundingRate,
          longShortRatio,
          oiBias,
          relativeStrength,
        );

        // fromWatchlist: was this symbol+side on the radar BEFORE this z-score fired?
        // Checked against: previous scan's watchlist (cross-scan) OR current scan's
        // own watch candidate (same-scan near_trigger → signal).
        const fromWatchlist =
          prevWatchedKeys.has(`${signal.symbol}-${signal.side}`) ||
          (watchSeed != null && watchSeed.side === signal.side && watchSeed.state === "near_trigger");

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
          ...(atr1h > 0 ? { atr1h, tp1, tp2, tp3, sl, tp2Source, tp3Source } : {}),
          ...(vwapDaily != null ? { vwapDaily } : {}),
          ...(vwapWeekly != null ? {
            vwapWeekly,
            nearWeeklyVwap: Math.abs(entry - vwapWeekly) <= atr1h * 0.5,
            distVwapWeeklyPct: signedDistPct(entry, vwapWeekly) ?? undefined,
          } : {}),
          ...(vwapMonthly != null ? {
            vwapMonthly,
            distVwapMonthlyPct: signedDistPct(entry, vwapMonthly) ?? undefined,
          } : {}),
          ...(relativeStrength !== undefined ? { relativeStrength, rsBias } : {}),
          squeezeScore,
          fromWatchlist,
        };
      });

    const watch = watchSeed
      ? enrichWatchCandidate(watchSeed, {
          bias1h,
          bias4h,
          regime,
          atr1h,
          vwapDaily,
          vwapWeekly,
          fr: frInfo?.lastFundingRate,
          oiChangePct,
          oiBias,
          longShortRatio,
          lsBias,
          relativeStrength,
          rsBias,
        })
      : null;

    return {
      signals: enrichedSignals,
      watch,
      entryCandidates15m: recentSignals.length,
      entryCandidates1h: recentSignals1h.length,
      passedZ: allRecentSignals.length,
      passedBias: enrichedSignals.length,
    } satisfies ScanLoopResult;
  });

  // 5. Collect
  const signals: Signal[] = [];
  const watchlist: WatchCandidate[] = [];
  const errored: string[] = [];
  let entryCandidates15m = 0;
  let entryCandidates1h = 0;
  let passedZ = 0;
  let passedBias = 0;
  for (const r of results) {
    if ("error" in r) errored.push(r.item);
    else {
      signals.push(...r.result.signals);
      if (r.result.watch) watchlist.push(r.result.watch);
      entryCandidates15m += r.result.entryCandidates15m;
      entryCandidates1h += r.result.entryCandidates1h;
      passedZ += r.result.passedZ;
      passedBias += r.result.passedBias;
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
  let dbFunnelLogged = false;
  let dbTraceSnapshotsInserted = 0;
  let dbError: string | undefined;
  try {
    await ensureSchema();

    dbFunnelLogged = await insertScanFunnel({
      scannedAt: scanResult.scannedAt,
      regime,
      symbolsScanned: symbols.length,
      symbolsErrored: errored.length,
      entryCandidates15m,
      entryCandidates1h,
      passedZ,
      passedBias,
      fired: signals.length,
      watchCandidates: watchlist.length,
      durationMs: scanResult.durationMs,
    });

    // 7a-pre. Upsert this scan's radar candidates so their lifecycle is tracked
    //         across scans (when first seen, peak score, eventual firing).
    const radarUpserts: RadarUpsert[] = scanResult.watchlist?.map((w) => ({
      symbol: w.symbol,
      timeframe: w.timeframe,
      side: w.side,
      state: w.state,
      score: w.score,
      biasWindow: w.biasWindow,
      zLevel: w.zLevel,
      zScore: w.zScore,
      triggerLevel: w.triggerLevel,
      triggerPrice: w.triggerPrice,
      entryPrice: w.entryPrice,
      sl: w.sl,
      tp1: w.tp1,
      tp2: w.tp2,
      tp3: w.tp3,
      squeezeScore: w.squeezeScore,
    })) ?? [];
    await upsertRadarCandidates(radarUpserts, scanResult.scannedAt);

    // 7a. Insert new signals (ON CONFLICT DO NOTHING, so re-runs are safe).
    //     If a signal came from the radar, mark that radar candidate fired and
    //     copy its first-seen time onto the signal so the board can trace it.
    //     Snapshot BTC context once per scan (cached 60s) — all signals fired in
    //     this scan share the same moment, so they get the same BTC backdrop.
    const btcContext = signals.length > 0
      ? await getBtcContextLive(scanResult.scannedAt).catch((e: Error) => {
          console.warn("BTC context fetch failed:", e.message);
          return null;
        })
      : null;
    const inserted = await Promise.all(signals.map(async (s) => {
      const radarFirstSeen = s.fromWatchlist
        ? await markRadarFired(s.symbol, s.side, scanResult.scannedAt).catch(() => null)
        : null;
      // pqVWAP (previous-quarter VWAP) distance — only for fired signals (few per
      // scan), so the extra ~1 quarter of 4h klines is cheap. Powers the board's
      // discretionary rejection badge; never blocks the signal.
      try {
        const start = prevQuarterAnchorFloor(s.barTime);
        const kl = await fetchKlineRange(s.symbol, "4h", start, s.barTime + 4 * 60 * 60_000);
        if (kl.length > 0) {
          const pq = computeVwapLevels(kl, s.barTime).prevQuarter;
          const d = signedDistPct(s.barClose, pq);
          if (d !== null) s.distVwapPquarterPct = d;
        }
      } catch { /* pqVWAP is best-effort; absence just means no badge */ }
      return insertSignal(s, scanResult.scannedAt, regime, radarFirstSeen, btcContext);
    }));
    dbSignalsInserted = inserted.filter(Boolean).length;

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
          const latestClosed = afterSignal[afterSignal.length - 1] ?? klines[klines.length - 1];
          if (latestClosed) {
            const traced = await insertSignalTraceSnapshot(row, scanResult.scannedAt, latestClosed.close, "cron_cycle");
            if (traced) dbTraceSnapshotsInserted++;
          }
          const result = resolveOutcome(row, afterSignal);
          if (!result) return;
          if (result.terminal) {
            // SL hit or TP3 hit — finalize the outcome, stop re-checking
            await updateOutcome(row.id, result.outcome, result.outcomeAt, result.outcomePrice, result.maxFavorable, result.maxAdverse, result.outcomeDetail);
            dbOutcomesResolved++;
          } else {
            // TP1 or TP2 reached but still running — record progress, keep active
            await updateBestTP(row.id, result.outcome, result.outcomeAt, result.outcomePrice, result.maxFavorable, result.maxAdverse, result.outcomeDetail);
          }
        })
      );
    }

    // 7d. Retention cleanup to keep DB storage bounded.
    dbSignalsPruned = await pruneOldSignals();
    // Drop radar candidates not seen in the last 3 hours (and never fired).
    await pruneStaleRadar(Date.now() - 3 * 60 * 60_000);
  } catch (e) {
    dbError = (e as Error).message;
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
    modelVersion:   MODEL_VERSION,
    modelParamsHash: MODEL_PARAMS_HASH,
    funnel: {
      logged: dbFunnelLogged,
      entryCandidates15m,
      entryCandidates1h,
      passedZ,
      passedBias,
      fired: signals.length,
    },
    dbSignalsInserted,
    dbTraceSnapshotsInserted,
    dbOutcomesResolved,
    dbSignalsPruned,
    ...(dbError ? { dbError } : {}),
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type Bias = ReturnType<typeof analyzeBias>;

function enrichWatchCandidate(
  watch: WatchCandidate,
  ctx: {
    bias1h: Bias;
    bias4h: Bias;
    regime: MarketRegime;
    atr1h: number;
    vwapDaily?: number | null;
    vwapWeekly?: number | null;
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
  const entryPrice = watch.barClose;
  const { sl, tp1, tp2, tp3, tp2Source, tp3Source } = computeTargets({
    entry: entryPrice, side: watch.side, atr: ctx.atr1h,
    vwapDaily: ctx.vwapDaily, vwapWeekly: ctx.vwapWeekly,
  });
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
  const biasWindow = estimateBiasWindow(watch, {
    fr: ctx.fr,
    longShortRatio: ctx.longShortRatio,
    lsBias: ctx.lsBias,
    squeezeScore,
    oiBias: ctx.oiBias,
    rsBias: ctx.rsBias,
  });
  reasons.push(`${biasWindow} bias window`);

  return {
    ...watch,
    score,
    biasWindow,
    reasons,
    missing,
    bias1h: ctx.bias1h.bias,
    bias4h: ctx.bias4h.bias,
    biasScore1h: ctx.bias1h.score,
    biasScore4h: ctx.bias4h.score,
    ...(ctx.atr1h > 0 ? { atr1h: ctx.atr1h, entryPrice, tp1, tp2, tp3, sl, tp2Source, tp3Source } : { entryPrice }),
    ...(ctx.vwapDaily != null ? { vwapDaily: ctx.vwapDaily } : {}),
    ...(ctx.vwapWeekly != null ? { vwapWeekly: ctx.vwapWeekly } : {}),
    ...(ctx.fr !== undefined ? { fundingRate: ctx.fr, frBias } : {}),
    ...(ctx.oiChangePct !== undefined ? { oiChangePct: ctx.oiChangePct, oiBias: ctx.oiBias } : {}),
    ...(ctx.longShortRatio !== undefined ? { longShortRatio: ctx.longShortRatio, lsBias: ctx.lsBias } : {}),
    signalType,
    ...(ctx.relativeStrength !== undefined ? { relativeStrength: ctx.relativeStrength, rsBias: ctx.rsBias } : {}),
    squeezeScore,
  };
}

function estimateBiasWindow(
  watch: WatchCandidate,
  ctx: {
    fr?: number;
    longShortRatio?: number;
    lsBias?: LsBias;
    squeezeScore: number;
    oiBias?: "rising" | "flat" | "falling";
    rsBias?: Signal["rsBias"];
  }
): BiasWindow {
  const favoredLs = watch.side === "long" ? "crowded_shorts" : "crowded_longs";
  const extremeLs =
    ctx.longShortRatio !== undefined &&
    (watch.side === "long" ? ctx.longShortRatio < 0.85 : ctx.longShortRatio > 1.3);
  const elevatedFunding = ctx.fr !== undefined && Math.abs(ctx.fr) >= 0.001;
  const alignedRs =
    (watch.side === "long" && ctx.rsBias === "strong") ||
    (watch.side === "short" && ctx.rsBias === "weak");

  if (
    ctx.squeezeScore >= 4 ||
    (ctx.lsBias === favoredLs && (elevatedFunding || ctx.oiBias === "rising" || alignedRs)) ||
    (extremeLs && elevatedFunding)
  ) {
    return "5-7d";
  }

  if (watch.state === "near_trigger" || ctx.squeezeScore >= 2 || ctx.oiBias === "rising") {
    return "3-5d";
  }

  return "1-2d";
}

// Flush-regime longs used to bypass HTF confirmation as "contrarian bounces",
// but 13 days of outcomes priced that bucket at -0.32R executable (n=262) —
// the worst slice in the log. Flush longs now confirm like everything else.
function passesBiasConfirmation(
  signal: Signal,
  bias1h: Bias,
  bias4h: Bias
): boolean {
  const opposite = signal.side === "long" ? "short" : "long";
  if (bias4h.bias === opposite || bias1h.bias === opposite) return false;
  if (bias4h.bias === signal.side || bias1h.bias === signal.side) return true;
  return Math.abs(bias4h.score) >= 3 && Math.abs(bias1h.score) <= 1;
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
