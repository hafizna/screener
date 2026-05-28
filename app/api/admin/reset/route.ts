import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";

// One-time DB reset — clears all signal_log rows for a clean slate.
// Requires CRON_SECRET in Authorization header (same secret as the cron job).
// Usage: curl -H "Authorization: Bearer <CRON_SECRET>" https://<your-app>/api/admin/reset
export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: "no DATABASE_URL" }, { status: 500 });

  const sql = neon(url);
  const rows = await sql`DELETE FROM signal_log RETURNING id` as Array<{ id: string }>;

  return NextResponse.json({ deleted: rows.length, ok: true });
}
