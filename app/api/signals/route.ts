import { NextResponse } from "next/server";
import { loadLatestScan } from "@/lib/kv";
import { fetchMarkPrices } from "@/lib/binance";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scan = await loadLatestScan();
    if (!scan) {
      return NextResponse.json({
        scannedAt: null,
        signals: [],
        stale: true,
        message: "No scan results yet — wait for the next cron tick, or trigger /api/cron/scan manually.",
      });
    }
    const ageMs = Date.now() - scan.scannedAt;
    const stale = ageMs > 30 * 60 * 1000; // 30min = something's wrong
    const prices = scan.signals.length > 0
      ? await fetchMarkPrices().catch(() => new Map<string, number>())
      : new Map<string, number>();
    const signals = scan.signals.map((signal) => ({
      ...signal,
      currentPrice: prices.get(signal.symbol),
    }));
    return NextResponse.json({ ...scan, signals, stale, ageMs });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
