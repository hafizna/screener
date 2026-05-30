import { NextResponse } from "next/server";
import { getSignalHistory } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await getSignalHistory(5000);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
