// Backfill BTC context (15m return, 1h return, 24h realized vol) onto historical
// signals that predate the snapshot logic.
//
// Resumable: only touches rows where btc_return_15m_pct IS NULL, so re-running after
// an interruption continues where it stopped. Fetches BTC 1m klines for the whole
// span in 1500-bar chunks (a handful of requests for the entire history), then
// computes each trade's context in-memory — no per-trade Binance call.
//
// Run with: DATABASE_URL=... npx tsx scripts/backfill-btc.ts

import { ensureSchema, getSignalsMissingBtcContext, updateSignalBtcContext } from "../lib/db";
import { fetchBtc1mKlines, computeBtcContext } from "../lib/btc";

const MIN_MS = 60_000;
const CHUNK_BARS = 1500;          // Binance hard cap per klines request
const VOL_LOOKBACK_MS = 1441 * MIN_MS; // need ~24h + 1 bar of history before each trade
const PROGRESS_EVERY = 50;

interface MiniKline { closeTime: number; close: number }

async function main() {
  await ensureSchema();

  const todo = await getSignalsMissingBtcContext();
  if (todo.length === 0) {
    console.log("Nothing to backfill — all signals already have BTC context.");
    return;
  }

  const minBar = Math.min(...todo.map((t) => t.bar_time));
  const maxBar = Math.max(...todo.map((t) => t.bar_time));
  // Pull from 24h before the earliest trade (for the vol window) up to the latest trade.
  const rangeStart = minBar - VOL_LOOKBACK_MS;
  const rangeEnd = maxBar;
  console.log(
    `Backfilling ${todo.length} trades. BTC 1m range: ` +
    `${new Date(rangeStart).toISOString()} → ${new Date(rangeEnd).toISOString()}`
  );

  // 1. Fetch the whole BTC 1m series once, in chunks. Dedup by closeTime.
  const byCloseTime = new Map<number, MiniKline>();
  let cursor = rangeStart;
  let chunkCount = 0;
  while (cursor <= rangeEnd) {
    const chunk = await fetchBtc1mKlines({
      startTime: cursor,
      endTime: rangeEnd,
      limit: CHUNK_BARS,
    });
    chunkCount++;
    if (chunk.length === 0) break;
    for (const k of chunk) byCloseTime.set(k.closeTime, k);
    const lastClose = chunk[chunk.length - 1].closeTime;
    // Advance past the last bar's open (closeTime - 1 bar) to avoid an infinite loop.
    const nextCursor = lastClose + 1;
    if (nextCursor <= cursor) break; // no progress — bail
    cursor = nextCursor;
    if (chunk.length < CHUNK_BARS) break; // reached the end of available data
  }
  const klines = [...byCloseTime.values()].sort((a, b) => a.closeTime - b.closeTime);
  console.log(`Fetched ${klines.length} BTC 1m bars in ${chunkCount} request(s).`);

  // 2. Compute + update per trade.
  let done = 0;
  let errors = 0;
  for (const trade of todo) {
    try {
      const ctx = computeBtcContext(klines, trade.bar_time);
      await updateSignalBtcContext(trade.id, ctx);
      done++;
    } catch (e) {
      errors++;
      console.warn(`  ERR ${trade.id}: ${(e as Error).message}`);
    }
    if (done % PROGRESS_EVERY === 0) {
      console.log(`Backfilled ${done}/${todo.length} trades, ${errors} errors`);
    }
  }
  console.log(`Done. Backfilled ${done}/${todo.length} trades, ${errors} errors.`);
}

main().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
