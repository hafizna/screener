import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { PROJECT_PAUSED, PROJECT_PAUSED_AT } from "./lib/project-state";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
};

export function middleware(req: NextRequest) {
  if (!PROJECT_PAUSED) return NextResponse.next();

  const { pathname } = req.nextUrl;

  // The external scheduler may continue calling this URL. A successful no-op
  // prevents retries while ensuring the scanner never reaches Binance, Neon,
  // Upstash, outcome tracking, or Discord.
  if (pathname === "/api/cron/scan") {
    return NextResponse.json(
      {
        ok: true,
        paused: true,
        pausedAt: PROJECT_PAUSED_AT,
        message: "Scanner is paused by the repository kill switch.",
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  }

  // Block every other API before its route module can read or mutate external
  // services. This includes dashboard polling, manual actions, and admin jobs.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        error: "project_paused",
        paused: true,
        pausedAt: PROJECT_PAUSED_AT,
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  // Inline maintenance HTML means the paused dashboard loads no client bundle
  // and starts no polling timers.
  return new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>MP+Z Screener — Paused</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #09090b;
        color: #e4e4e7;
        font: 15px/1.6 ui-sans-serif, system-ui, sans-serif;
      }
      main {
        width: min(520px, calc(100% - 48px));
        padding: 28px;
        border: 1px solid #27272a;
        border-radius: 12px;
        background: #111113;
      }
      h1 { margin: 0 0 8px; font-size: 20px; }
      p { margin: 0; color: #a1a1aa; }
      code { color: #d4d4d8; }
    </style>
  </head>
  <body>
    <main>
      <h1>MP+Z Screener is paused</h1>
      <p>Scanning, outcome tracking, storage writes, alerts, and dashboard polling are disabled from code.</p>
    </main>
  </body>
</html>`,
    {
      status: 503,
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
      },
    },
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
