import { NextResponse } from "next/server";
import { markAsPaperTrade } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json() as { id?: unknown; entryPrice?: unknown };
    const id = typeof body.id === "string" ? body.id : null;
    const entryPrice = typeof body.entryPrice === "number" && Number.isFinite(body.entryPrice) && body.entryPrice > 0
      ? body.entryPrice
      : null;
    if (!id || !entryPrice) {
      return NextResponse.json({ error: "id and entryPrice required" }, { status: 400 });
    }
    await markAsPaperTrade(id, entryPrice);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
