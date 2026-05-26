import { Redis } from "@upstash/redis";
import type { ScanResult } from "./types";

// Upstash Redis. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in
// Vercel env vars. Free tier: 10,000 commands/day. Our pattern:
//   - 1 SET per scan (every 15m = 96/day)
//   - 1 GET per dashboard visit
// Trivially within budget.

let _redis: Redis | null = null;
function getRedis(): Redis {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Upstash credentials missing. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
    );
  }
  _redis = new Redis({ url, token });
  return _redis;
}

const LATEST_SCAN_KEY = "mpz:scan:latest";

export async function storeScanResult(result: ScanResult): Promise<void> {
  const r = getRedis();
  // Single key, overwritten each scan. Upstash JSON-encodes for us.
  await r.set(LATEST_SCAN_KEY, result);
  // Also keep a tiny history ring (last 5 scans) for debugging.
  const histKey = `mpz:scan:hist:${result.scannedAt}`;
  await r.set(histKey, { scannedAt: result.scannedAt, count: result.signals.length, durationMs: result.durationMs }, { ex: 60 * 60 * 24 });
}

export async function loadLatestScan(): Promise<ScanResult | null> {
  const r = getRedis();
  const data = await r.get<ScanResult>(LATEST_SCAN_KEY);
  return data ?? null;
}
