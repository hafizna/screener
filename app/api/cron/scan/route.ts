import { NextRequest, NextResponse } from "next/server";
import { fetchFundingRates, fetchKlines, fetchTopSymbolsByVolume, withConcurrency } from "@/lib/binance";
import type { FRBias } from "@/lib/types";
import { analyzeBias } from "@/lib/bias";
import { detectSignal } from "@/lib/signals";
import { storeScanResult } from "@/lib/kv";
import type { Signal, ScanResult } from "@/lib/types";

// Vercel function config — needs the extended timeout that comes with Pro plan
// (or with fluid compute on Hobby — set to 60s and it works on either).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SYMBOL_LIMIT = parseInt(process.env.SYMBOL_LIMIT ?? "150", 10);
const CONCURRENCY = parseInt(process.env.FETCH_CONCURRENCY ?? "20", 10);

// Vercel cron hits this with header `Authorization: Bearer ${CRON_SECRET}`.
// External cron (cron-job.org) does the same — set a custom header in their UI.
function authorize(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // If no secret configured, allow only in dev. Block in prod.
    return process.env.NODE_ENV !== "production";
  }
  const got = req.headers.get("authorization");
  return got === `Bearer ${expected}`;
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();

  // 1. Pick the symbol universe
  let symbols: string[];
  try {
    symbols = await fetchTopSymbolsByVolume(SYMBOL_LIMIT);
  } catch (e) {
    return NextResponse.json(
      { error: "failed to fetch symbol list", detail: (e as Error).message },
      { status: 502 }
    );
  }

  // 2. Fetch funding rates for all symbols in one call before the main loop.
  //    Weight: 10. Non-fatal — scan continues without FR data if this fails.
  const fundingRates = await fetchFundingRates().catch((e: Error) => {
    console.warn("FR fetch failed, proceeding without FR data:", e.message);
    return new Map<string, { lastFundingRate: number }>();
  });

  // 3. Fan out with bounded concurrency. Entry is 15m only; 1H/4H
  // are fetched only after a raw trigger exists, so the scan stays light.
  const results = await withConcurrency(symbols, CONCURRENCY, async (symbol) => {
    const entryKlines = await fetchKlines(symbol, "15m");
    const signal = detectSignal(symbol, "15m", entryKlines);
    if (!signal) return null;

    const [oneHourKlines, fourHourKlines] = await Promise.all([
      fetchKlines(symbol, "1h"),
      fetchKlines(symbol, "4h"),
    ]);

    const bias1h = analyzeBias(oneHourKlines);
    const bias4h = analyzeBias(fourHourKlines);
    if (!passesBiasConfirmation(signal, bias1h, bias4h)) return null;

    const frInfo = fundingRates.get(symbol);
    return {
      ...signal,
      bias1h: bias1h.bias,
      bias4h: bias4h.bias,
      biasScore1h: bias1h.score,
      biasScore4h: bias4h.score,
      ...(frInfo !== undefined
        ? { fundingRate: frInfo.lastFundingRate, frBias: classifyFR(signal.side, frInfo.lastFundingRate) }
        : {}),
    };
  });

  // 3. Collect signals and errors
  const signals: Signal[] = [];
  const errored: string[] = [];
  for (const r of results) {
    if ("error" in r) {
      errored.push(r.item);
    } else if (r.result) {
      signals.push(r.result);
    }
  }

  // 4. Rank: HTF agreement + FR + delta alignment, then higher Z.
  signals.sort((a, b) => {
    const frWeight = (sig: Signal) =>
      sig.frBias === "favorable" ? 1 : sig.frBias === "unfavorable" ? -1 : 0;
    const deltaWeight = (sig: Signal) =>
      sig.deltaBias === "aligned" ? 1 : sig.deltaBias === "opposed" ? -1 : 0;
    const scoreA = (a.biasScore4h ?? 0) + (a.biasScore1h ?? 0) + frWeight(a) + deltaWeight(a);
    const scoreB = (b.biasScore4h ?? 0) + (b.biasScore1h ?? 0) + frWeight(b) + deltaWeight(b);
    if (scoreB !== scoreA) return scoreB - scoreA;
    if (b.zLevel !== a.zLevel) return b.zLevel - a.zLevel;
    return Math.abs(b.zScore) - Math.abs(a.zScore);
  });

  const scanResult: ScanResult = {
    scannedAt: Date.now(),
    durationMs: Date.now() - t0,
    symbolsScanned: symbols.length,
    symbolsErrored: errored,
    signals,
  };

  try {
    await storeScanResult(scanResult);
  } catch (e) {
    // Don't fail the whole scan if KV write fails — return the result so a
    // human-triggered run still surfaces info, and log loudly.
    console.error("KV write failed", e);
    return NextResponse.json(
      { ...scanResult, kvError: (e as Error).message },
      { status: 200 }
    );
  }

  return NextResponse.json({
    scannedAt: scanResult.scannedAt,
    durationMs: scanResult.durationMs,
    symbolsScanned: scanResult.symbolsScanned,
    signalsFound: scanResult.signals.length,
    errors: scanResult.symbolsErrored.length,
  });
}

// Positive FR = longs pay shorts; negative = shorts pay longs.
// Favorable for longs: negative FR (shorts crowded, squeeze potential).
// Favorable for shorts: FR ≥ +0.05% per 8h (longs overextended, paid to be short).
// Unfavorable: FR is clearly working against the signal side.
function classifyFR(side: "long" | "short", fr: number): FRBias {
  if (side === "long") {
    if (fr < 0) return "favorable";
    if (fr > 0.001) return "unfavorable"; // > +0.10% per 8h — longs very crowded
    return "neutral";
  } else {
    if (fr > 0.0005) return "favorable";  // > +0.05% per 8h — longs paying
    if (fr < 0) return "unfavorable";
    return "neutral";
  }
}

type Bias = ReturnType<typeof analyzeBias>;

function passesBiasConfirmation(signal: Signal, bias1h: Bias, bias4h: Bias): boolean {
  const opposite = signal.side === "long" ? "short" : "long";
  if (bias4h.bias === opposite || bias1h.bias === opposite) return false;
  if (bias4h.bias === signal.side || bias1h.bias === signal.side) return true;
  return Math.abs(bias4h.score) >= 3 && Math.abs(bias1h.score) <= 1;
}
