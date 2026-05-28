import { NextResponse } from "next/server";
import { getTrackedSignals } from "@/lib/db";
import { fetchMarkPrices } from "@/lib/binance";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [signals, prices] = await Promise.all([
      getTrackedSignals(),
      fetchMarkPrices().catch(() => new Map<string, number>()),
    ]);

    // Attach current mark price to each signal so the frontend can show Near Entry state
    const signalsWithPrice = signals.map((s) => ({
      ...s,
      current_price: prices.get(s.symbol) ?? null,
    }));

    return NextResponse.json({ signals: signalsWithPrice });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
