import { NextRequest, NextResponse } from "next/server";
import { markAsWatched } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { id, holdDays } = (await req.json()) as { id: string; holdDays?: number };
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    await markAsWatched(id, holdDays ?? 3);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
