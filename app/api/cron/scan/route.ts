import { NextRequest, NextResponse } from "next/server";
import { fetchKlines, fetchTopSymbolsByVolume, withConcurrency } from "@/lib/binance";
import { detectSignal } from "@/lib/signals";
import { storeScanResult } from "@/lib/kv";
import type { Signal, Timeframe, ScanResult } from "@/lib/types";

// Vercel function config — needs the extended timeout that comes with Pro plan
// (or with fluid compute on Hobby — set to 60s and it works on either).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h"];
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

  // 2. Build the (symbol, timeframe) task list
  type Task = { symbol: string; timeframe: Timeframe };
  const tasks: Task[] = [];
  for (const symbol of symbols) {
    for (const timeframe of TIMEFRAMES) {
      tasks.push({ symbol, timeframe });
    }
  }

  // 3. Fan out with bounded concurrency. Each task: fetch + detect.
  const results = await withConcurrency(tasks, CONCURRENCY, async (task) => {
    const klines = await fetchKlines(task.symbol, task.timeframe);
    return detectSignal(task.symbol, task.timeframe, klines);
  });

  // 4. Collect signals and errors
  const signals: Signal[] = [];
  const errored: string[] = [];
  for (const r of results) {
    if ("error" in r) {
      errored.push(`${r.item.symbol}:${r.item.timeframe}`);
    } else if (r.result) {
      signals.push(r.result);
    }
  }

  // 5. Rank: higher Z first, then more confluence flags
  signals.sort((a, b) => {
    const confA = (a.nearVwap ? 1 : 0) + (a.nearPdh ? 1 : 0) + (a.nearPdl ? 1 : 0);
    const confB = (b.nearVwap ? 1 : 0) + (b.nearPdh ? 1 : 0) + (b.nearPdl ? 1 : 0);
    if (b.zLevel !== a.zLevel) return b.zLevel - a.zLevel;
    if (confB !== confA) return confB - confA;
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
