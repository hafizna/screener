import { NextResponse } from "next/server";
import { getTrackedSignals, getRadarCandidates, getRecentResolved } from "@/lib/db";
import { fetchMarkPrices } from "@/lib/binance";

export const dynamic = "force-dynamic";

// One unified payload for the Lifecycle board: radar candidates, tracked
// (active + running + paper) signals, and recently resolved signals — each with
// the current mark price attached so the client can compute live state / P&L.
export async function GET() {
  try {
    const since = Date.now() - 3 * 60 * 60_000; // radar freshness window: 3h
    const [radar, tracked, resolved, prices] = await Promise.all([
      getRadarCandidates(since),
      getTrackedSignals(),
      getRecentResolved(25),
      fetchMarkPrices().catch(() => new Map<string, number>()),
    ]);

    const withPrice = <T extends { symbol: string }>(rows: T[]) =>
      rows.map((r) => ({ ...r, current_price: prices.get(r.symbol) ?? null }));

    return NextResponse.json({
      radar: withPrice(radar),
      tracked: withPrice(tracked),
      resolved: withPrice(resolved),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
