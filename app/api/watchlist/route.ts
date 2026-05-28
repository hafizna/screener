import { NextResponse } from "next/server";
import { getWatchedSignals } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const signals = await getWatchedSignals();
  return NextResponse.json({ signals });
}
