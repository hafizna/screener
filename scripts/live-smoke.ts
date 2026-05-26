// Hits real Binance fapi. Confirms the pipeline works against live data
// without needing Vercel or Upstash.
//
// Run with: npx tsx scripts/live-smoke.ts

import { fetchKlines, fetchTopSymbolsByVolume, withConcurrency } from "../lib/binance";
import { detectSignal } from "../lib/signals";
import type { Timeframe } from "../lib/types";

async function main() {
  console.log("Fetching top symbols by volume...");
  const top = await fetchTopSymbolsByVolume(10);
  console.log("Top 10:", top.join(", "));

  const timeframes: Timeframe[] = ["15m", "30m", "1h"];
  const tasks: { symbol: string; timeframe: Timeframe }[] = [];
  for (const symbol of top) {
    for (const tf of timeframes) {
      tasks.push({ symbol, timeframe: tf });
    }
  }

  console.log(`\nScanning ${tasks.length} symbol/TF combos with concurrency 10...`);
  const t0 = Date.now();
  const results = await withConcurrency(tasks, 10, async (t) => {
    const klines = await fetchKlines(t.symbol, t.timeframe);
    return { klines: klines.length, signal: detectSignal(t.symbol, t.timeframe, klines) };
  });
  const ms = Date.now() - t0;

  let signals = 0;
  let errors = 0;
  for (const r of results) {
    if ("error" in r) {
      errors++;
      console.log(`  ERR ${r.item.symbol}:${r.item.timeframe} — ${r.error.message}`);
    } else if (r.result.signal) {
      signals++;
      const s = r.result.signal;
      console.log(`  SIG ${s.symbol} ${s.timeframe} ${s.side} Z${s.zLevel}(${s.zScore.toFixed(2)}) @ ${s.triggerLevel} ${s.triggerPrice.toFixed(6)} close=${s.barClose.toFixed(6)}`);
    }
  }

  console.log(`\nDone in ${ms}ms. ${signals} signals, ${errors} errors out of ${tasks.length} scans.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
