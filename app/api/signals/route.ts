import { NextResponse } from "next/server";
import { loadLatestScan } from "@/lib/kv";

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
    return NextResponse.json({ ...scan, stale, ageMs });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
