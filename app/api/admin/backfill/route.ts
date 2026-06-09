import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import {
  fetchFundingRateAt,
  fetchKlines,
  fetchLongShortRatioAt,
  fetchOIHistoryAt,
  withConcurrency,
} from "@/lib/binance";
import { computeRS, computeSqueezeScore } from "@/lib/atr";
import { classifyFR, classifyLs } from "@/lib/funding";
import { ensureSchema } from "@/lib/db";
import type { DeltaBias, MarketRegime, Timeframe } from "@/lib/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Retroactively fills enrichment columns that were added to signal_log after
// rows had already been written (NULLs), using Binance historical endpoints:
//
//   taker_buy_ratio / delta_bias   — the signal bar's own kline (exact, any age)
//   relative_strength / rs_bias    — 4H klines ending at the signal bar (exact, any age)
//   funding_rate / fr_bias         — settled funding nearest before the bar
//                                    (approximates the live predicted rate, any age)
//   long_short_ratio / ls_bias     — 5m account ratio at the bar (~30 days retention)
//   oi_change_pct / oi_bias        — 15m OI window ending at the bar (~30 days retention)
//   squeeze_score                  — recomputed when one of its inputs was filled
//   outcome_price                  — reconstructed from the trailing state machine (SQL only)
//
// Existing non-NULL values are never overwritten (except squeeze_score, which is
// recomputed only when it previously lacked inputs). The L/S + OI endpoints only
// retain ~30 days, so run this before old rows age out of that window.
//
// Usage:
//   curl -X POST -H "Authorization: Bearer <CRON_SECRET>" \
//     "https://<app>/api/admin/backfill?limit=100"          # repeat until remaining=0
//   curl -X POST ... "?dryRun=1"                             # count NULLs only

interface BackfillRow {
  id: string;
  symbol: string;
  timeframe: string;
  side: "long" | "short";
  regime: string | null;
  bar_time: string | number;
  taker_buy_ratio: number | null;
  funding_rate: number | null;
  long_short_ratio: number | null;
  oi_change_pct: number | null;
  relative_strength: number | null;
  squeeze_score: number | null;
}

const TF_MS: Record<string, number> = { "15m": 15 * 60_000, "30m": 30 * 60_000, "1h": 60 * 60_000, "4h": 240 * 60_000 };

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: "no DATABASE_URL" }, { status: 500 });

  await ensureSchema();
  const sql = neon(url);

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 100), 300);
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  // outcome_price is derivable without any API call: the trailing state machine's
  // exit is deterministic given the outcome (see lib/outcomes.ts).
  const outcomePriceFilled = dryRun ? [] : await sql`
    UPDATE signal_log SET outcome_price = CASE outcome
      WHEN 'sl'  THEN sl
      WHEN 'tp1' THEN entry_price
      WHEN 'tp2' THEN tp1
      WHEN 'tp3' THEN tp3
    END
    WHERE outcome_price IS NULL AND outcome IN ('sl','tp1','tp2','tp3')
    RETURNING id` as Array<{ id: string }>;

  const nullCounts = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE taker_buy_ratio   IS NULL) AS taker,
      COUNT(*) FILTER (WHERE funding_rate      IS NULL) AS fr,
      COUNT(*) FILTER (WHERE long_short_ratio  IS NULL) AS ls,
      COUNT(*) FILTER (WHERE oi_change_pct     IS NULL) AS oi,
      COUNT(*) FILTER (WHERE relative_strength IS NULL) AS rs,
      COUNT(*) FILTER (WHERE outcome_price IS NULL AND outcome IN ('sl','tp1','tp2','tp3')) AS exit_price
    FROM signal_log`)[0] as Record<string, number>;

  if (dryRun) {
    return NextResponse.json({ ok: true, dryRun: true, nullCounts });
  }

  const rows = (await sql`
    SELECT id, symbol, timeframe, side, regime, bar_time,
           taker_buy_ratio, funding_rate, long_short_ratio,
           oi_change_pct, relative_strength, squeeze_score
    FROM signal_log
    WHERE taker_buy_ratio IS NULL OR funding_rate IS NULL OR long_short_ratio IS NULL
       OR oi_change_pct IS NULL OR relative_strength IS NULL
    ORDER BY bar_time ASC
    LIMIT ${limit}`) as BackfillRow[];

  // BTC 4H klines are shared across rows; cache per 4H bucket.
  const btc4hCache = new Map<number, Promise<Awaited<ReturnType<typeof fetchKlines>>>>();
  const btc4hAt = (endTime: number) => {
    const bucket = Math.floor(endTime / TF_MS["4h"]);
    let p = btc4hCache.get(bucket);
    if (!p) { p = fetchKlines("BTCUSDT", "4h", undefined, { endTime, limit: 6 }); btc4hCache.set(bucket, p); }
    return p;
  };

  const filled = { taker: 0, fr: 0, ls: 0, oi: 0, rs: 0, squeezeRecomputed: 0, errors: 0 };

  await withConcurrency(rows, 8, async (row) => {
    try {
      const barTime = Number(row.bar_time);
      const tf = (row.timeframe in TF_MS ? row.timeframe : "15m") as Timeframe;
      const barCloseMs = barTime + TF_MS[tf];

      let taker: number | null = null;
      let deltaBias: DeltaBias | null = null;
      if (row.taker_buy_ratio === null) {
        const bars = await fetchKlines(row.symbol, tf, undefined, { endTime: barTime + 1000, limit: 1 });
        const bar = bars.find((b) => b.openTime === barTime);
        if (bar && bar.volume > 0) {
          taker = bar.takerBuyVolume / bar.volume;
          // Same thresholds as detectSignal (lib/signals.ts): >0.55 buy-dominated, <0.45 sell-dominated.
          deltaBias = taker > 0.55
            ? (row.side === "long" ? "aligned" : "opposed")
            : taker < 0.45
            ? (row.side === "short" ? "aligned" : "opposed")
            : "neutral";
          filled.taker++;
        }
      }

      let fr: number | null = null;
      if (row.funding_rate === null) {
        fr = await fetchFundingRateAt(row.symbol, barCloseMs);
        if (fr !== null) filled.fr++;
      }

      let ls: number | null = null;
      if (row.long_short_ratio === null) {
        ls = await fetchLongShortRatioAt(row.symbol, barTime);
        if (ls !== null) filled.ls++;
      }

      let oiChangePct: number | null = null;
      let oiBias: string | null = null;
      if (row.oi_change_pct === null) {
        const oi = await fetchOIHistoryAt(row.symbol, barTime);
        if (oi.length >= 2 && oi[0].openInterest > 0) {
          oiChangePct = ((oi[oi.length - 1].openInterest - oi[0].openInterest) / oi[0].openInterest) * 100;
          oiBias = oiChangePct > 0.5 ? "rising" : oiChangePct < -0.5 ? "falling" : "flat";
          filled.oi++;
        }
      }

      let rs: number | null = null;
      if (row.relative_strength === null) {
        const [coin4h, btc4h] = await Promise.all([
          fetchKlines(row.symbol, "4h", undefined, { endTime: barCloseMs, limit: 6 }),
          btc4hAt(barCloseMs),
        ]);
        if (coin4h.length >= 4 && btc4h.length >= 4) {
          rs = computeRS(coin4h, btc4h);
          filled.rs++;
        }
      }

      // Recompute the squeeze score only when an input that was missing at fire
      // time has now been filled — rows scored live with full inputs keep their
      // as-seen value.
      const mergedFr = row.funding_rate ?? fr ?? undefined;
      const mergedLs = row.long_short_ratio ?? ls ?? undefined;
      const mergedRs = row.relative_strength ?? rs ?? undefined;
      const mergedOiBias = oiBias ?? undefined;
      let newSqueeze: number | null = null;
      if (fr !== null || ls !== null || rs !== null || oiBias !== null) {
        newSqueeze = computeSqueezeScore(row.side, mergedFr, mergedLs, mergedOiBias, mergedRs);
        filled.squeezeRecomputed++;
      }

      const regime = (row.regime ?? "neutral") as MarketRegime;
      const frBias = fr !== null ? classifyFR(row.side, fr, regime) : null;
      const lsBias = ls !== null ? classifyLs(ls) : null;
      const rsBias = rs !== null ? (rs > 1.1 ? "strong" : rs < 0.9 ? "weak" : "neutral") : null;

      await sql`
        UPDATE signal_log SET
          taker_buy_ratio   = COALESCE(taker_buy_ratio, ${taker}),
          delta_bias        = COALESCE(delta_bias, ${deltaBias}),
          funding_rate      = COALESCE(funding_rate, ${fr}),
          fr_bias           = COALESCE(fr_bias, ${frBias}),
          long_short_ratio  = COALESCE(long_short_ratio, ${ls}),
          ls_bias           = COALESCE(ls_bias, ${lsBias}),
          oi_change_pct     = COALESCE(oi_change_pct, ${oiChangePct}),
          oi_bias           = COALESCE(oi_bias, ${oiBias}),
          relative_strength = COALESCE(relative_strength, ${rs}),
          rs_bias           = COALESCE(rs_bias, ${rsBias}),
          squeeze_score     = COALESCE(${newSqueeze}, squeeze_score)
        WHERE id = ${row.id}`;
    } catch {
      filled.errors++;
    }
  });

  const remaining = (await sql`
    SELECT COUNT(*) AS n FROM signal_log
    WHERE taker_buy_ratio IS NULL OR funding_rate IS NULL OR long_short_ratio IS NULL
       OR oi_change_pct IS NULL OR relative_strength IS NULL`)[0] as { n: number };

  return NextResponse.json({
    ok: true,
    processed: rows.length,
    filled,
    outcomePriceFilled: outcomePriceFilled.length,
    nullCountsBefore: nullCounts,
    remaining: Number(remaining.n),
  });
}
