import { NextRequest, NextResponse } from "next/server";
import { setSignalAction } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { id, action } = (await req.json()) as { id: string; action: "enter" | "skip" | null };
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    if (action !== "enter" && action !== "skip" && action !== null) {
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
    }
    await setSignalAction(id, action);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
