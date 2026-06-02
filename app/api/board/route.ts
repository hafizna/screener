import { NextResponse } from "next/server";
import { ensureSchema, getTrackedSignals, getRadarCandidates, getRecentResolved, getSignalTraceSnapshots } from "@/lib/db";
import { fetchMarkPrices } from "@/lib/binance";

export const dynamic = "force-dynamic";

// One unified payload for the Lifecycle board: radar candidates, tracked
// (active + running + paper) signals, and recently resolved signals — each with
// the current mark price attached so the client can compute live state / P&L.
export async function GET() {
  try {
    // The board reads tables (e.g. signal_trace_snapshots) that are created by
    // ensureSchema. The cron scan also calls it, but the board can be hit before
    // the first post-deploy scan runs, so ensure the schema here too — it's a
    // no-op when the DB is unconfigured and idempotent otherwise.
    await ensureSchema();

    const since = Date.now() - 3 * 60 * 60_000; // radar freshness window: 3h
    const [radar, tracked, resolved, prices] = await Promise.all([
      getRadarCandidates(since),
      getTrackedSignals(),
      getRecentResolved(25),
      fetchMarkPrices().catch(() => new Map<string, number>()),
    ]);
    const traces = await getSignalTraceSnapshots([
      ...tracked.map((s) => s.id),
      ...resolved.map((s) => s.id),
    ]);

    const withPrice = <T extends { symbol: string }>(rows: T[]) =>
      rows.map((r) => ({ ...r, current_price: prices.get(r.symbol) ?? null }));
    const withPriceAndTrace = <T extends { id: string; symbol: string }>(rows: T[]) =>
      rows.map((r) => ({ ...r, current_price: prices.get(r.symbol) ?? null, trace: traces[r.id] ?? [] }));

    return NextResponse.json({
      radar: withPrice(radar),
      tracked: withPriceAndTrace(tracked),
      resolved: withPriceAndTrace(resolved),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
