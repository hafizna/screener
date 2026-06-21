import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { fetchKlineRange, withConcurrency } from "@/lib/binance";
import { computeVwapLevels, prevQuarterAnchorFloor, signedDistPct } from "@/lib/vwap";
import { ensureSchema } from "@/lib/db";
import type { Timeframe } from "@/lib/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Research-only backfill: for each historical signal, computes how far its entry
// sat from the weekly / monthly / prev-week / prev-month / quarter / prev-quarter
// anchored VWAP at fire time, and stores the six signed distances (% of entry vs
// level). This lets us test whether higher-TF VWAP confluence — up to the
// previous-quarter VWAP (pqVWAP) traders fade rejections off — adds signal beyond
// weekly/monthly, WITHOUT touching the live scanner.
//
// VWAP is anchored on 4h klines (plenty accurate for multi-week anchors); the
// fetch reaches back to the previous quarter's start (the deepest anchor).
// Existing non-NULL values are never overwritten, so the run is idempotent and
// resumable, keyed on the quarter column so a re-run tops up the new levels.
//
// Usage:
//   curl -X POST -H "Authorization: Bearer <CRON_SECRET>" "<app>/api/admin/vwap-research?dryRun=1"
//   curl -X POST -H "Authorization: Bearer <CRON_SECRET>" "<app>/api/admin/vwap-research?limit=400"   # repeat until remaining=0

interface Row {
  id: string;
  symbol: string;
  timeframe: string;
  bar_time: string | number;
  entry_price: number;
}

const VALID_TF: Timeframe[] = ["15m", "30m", "1h", "4h"];

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: "no DATABASE_URL" }, { status: 500 });

  await ensureSchema();
  const sql = neon(url);

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 400), 800);
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  // Keyed on the quarter column: rows filled by the earlier (weekly/monthly-only)
  // version still have NULL quarter/prev-quarter, so a re-run tops them up.
  const nullCount = (await sql`
    SELECT COUNT(*) AS n FROM signal_log WHERE dist_vwap_quarter_pct IS NULL`)[0] as { n: number };

  if (dryRun) {
    return NextResponse.json({ ok: true, dryRun: true, remaining: Number(nullCount.n) });
  }

  const rows = (await sql`
    SELECT id, symbol, timeframe, bar_time, entry_price
    FROM signal_log
    WHERE dist_vwap_quarter_pct IS NULL AND entry_price > 0
    ORDER BY symbol ASC, bar_time ASC
    LIMIT ${limit}`) as Row[];

  // Group by symbol so each symbol's 4h history is fetched exactly once per batch.
  const bySymbol = new Map<string, Row[]>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol);
    if (list) list.push(r);
    else bySymbol.set(r.symbol, [r]);
  }

  const filled = { rows: 0, symbols: 0, errors: 0 };

  await withConcurrency([...bySymbol.entries()], 4, async ([symbol, group]) => {
    try {
      const times = group.map((g) => Number(g.bar_time));
      const earliest = Math.min(...times);
      const latest = Math.max(...times);
      // Reach back to the previous quarter's start (the deepest anchor, for pqVWAP).
      const start = prevQuarterAnchorFloor(earliest);
      const end = latest + 4 * 60 * 60_000;
      const klines = await fetchKlineRange(symbol, "4h", start, end);
      if (klines.length === 0) return;

      for (const r of group) {
        const tf = (VALID_TF.includes(r.timeframe as Timeframe) ? r.timeframe : "15m") as Timeframe;
        void tf; // distances are anchored on 4h regardless of the signal timeframe
        const levels = computeVwapLevels(klines, Number(r.bar_time));
        const entry = Number(r.entry_price);
        const dW = signedDistPct(entry, levels.weekly);
        const dM = signedDistPct(entry, levels.monthly);
        const dPW = signedDistPct(entry, levels.prevWeek);
        const dPM = signedDistPct(entry, levels.prevMonth);
        const dQ = signedDistPct(entry, levels.quarter);
        const dPQ = signedDistPct(entry, levels.prevQuarter);
        if (dW === null && dM === null && dPW === null && dPM === null && dQ === null && dPQ === null) continue;
        await sql`
          UPDATE signal_log SET
            dist_vwap_weekly_pct   = COALESCE(dist_vwap_weekly_pct, ${dW}),
            dist_vwap_monthly_pct  = COALESCE(dist_vwap_monthly_pct, ${dM}),
            dist_vwap_pweek_pct    = COALESCE(dist_vwap_pweek_pct, ${dPW}),
            dist_vwap_pmonth_pct   = COALESCE(dist_vwap_pmonth_pct, ${dPM}),
            dist_vwap_quarter_pct  = COALESCE(dist_vwap_quarter_pct, ${dQ}),
            dist_vwap_pquarter_pct = COALESCE(dist_vwap_pquarter_pct, ${dPQ})
          WHERE id = ${r.id}`;
        filled.rows++;
      }
      filled.symbols++;
    } catch {
      filled.errors++;
    }
  });

  const remaining = (await sql`
    SELECT COUNT(*) AS n FROM signal_log WHERE dist_vwap_quarter_pct IS NULL`)[0] as { n: number };

  return NextResponse.json({
    ok: true,
    processed: rows.length,
    symbolsInBatch: bySymbol.size,
    filled,
    remainingBefore: Number(nullCount.n),
    remaining: Number(remaining.n),
  });
}
