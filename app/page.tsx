"use client";

import { useEffect, useMemo, useState } from "react";
import type { DeltaBias, FRBias, ScanResult, Signal, Timeframe } from "@/lib/types";

type ApiResponse = (ScanResult & { stale: boolean; ageMs: number }) | {
  scannedAt: null;
  signals: [];
  stale: true;
  message: string;
};

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
};

export default function DashboardPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Filters
  const [tfFilter, setTfFilter] = useState<Set<Timeframe>>(new Set(["15m"]));
  const [sideFilter, setSideFilter] = useState<"all" | "long" | "short">("all");
  const [minZ, setMinZ] = useState<2 | 3>(2);
  const [frFilter, setFrFilter] = useState<"all" | "favorable">("all");

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/signals", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ApiResponse;
      setData(json);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // Auto-refresh every 60s — cheap, just hits our /api/signals (KV read).
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, []);

  const activeSignals = useMemo<Signal[]>(() => {
    if (!data || !("signals" in data) || data.signals.length === 0) return [];
    return data.signals.filter((s) => isSignalActive(s, Date.now()));
  }, [data]);

  const expiredCount =
    data && data.scannedAt !== null ? data.signals.length - activeSignals.length : 0;

  const filtered = useMemo<Signal[]>(() => {
    if (activeSignals.length === 0) return [];
    return activeSignals.filter((s) => {
      if (!tfFilter.has(s.timeframe)) return false;
      if (sideFilter !== "all" && s.side !== sideFilter) return false;
      if (s.zLevel < minZ) return false;
      if (frFilter === "favorable" && s.frBias !== "favorable") return false;
      return true;
    });
  }, [activeSignals, tfFilter, sideFilter, minZ, frFilter]);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium">MP + Z screener</h1>
          <p className="text-sm text-neutral-400">Binance USDT-M futures · top by volume</p>
        </div>
        <button
          onClick={refresh}
          className="px-3 py-1.5 text-sm rounded-md border border-neutral-700 hover:border-neutral-500 transition-colors"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {data && data.scannedAt !== null && (
        <div
          className={`mb-4 px-3 py-2 rounded-md text-sm ${
            data.stale ? "bg-amber-950/40 border border-amber-900/60 text-amber-200" : "bg-neutral-900 border border-neutral-800 text-neutral-300"
          }`}
        >
          Last scan: {new Date(data.scannedAt).toLocaleString()} ·{" "}
          {data.symbolsScanned} symbols · {activeSignals.length} active signals
          {expiredCount > 0 && ` · ${expiredCount} expired hidden`}
          {data.stale && " · stale, check cron"}
          {data.symbolsErrored.length > 0 && ` · ${data.symbolsErrored.length} errors`}
        </div>
      )}

      {data && data.scannedAt === null && (
        <div className="mb-4 px-3 py-2 rounded-md text-sm bg-blue-950/40 border border-blue-900/60 text-blue-200">
          {data.message}
        </div>
      )}

      {err && (
        <div className="mb-4 px-3 py-2 rounded-md text-sm bg-red-950/40 border border-red-900/60 text-red-200">
          Error: {err}
        </div>
      )}

      <section className="mb-4 flex flex-wrap gap-2 items-center">
        <FilterGroup label="Timeframe">
          {(["15m"] as Timeframe[]).map((tf) => (
            <Chip
              key={tf}
              active={tfFilter.has(tf)}
              onClick={() => {
                const next = new Set(tfFilter);
                if (next.has(tf)) next.delete(tf);
                else next.add(tf);
                setTfFilter(next);
              }}
            >
              {tf}
            </Chip>
          ))}
        </FilterGroup>
        <FilterGroup label="Side">
          {(["all", "long", "short"] as const).map((s) => (
            <Chip key={s} active={sideFilter === s} onClick={() => setSideFilter(s)}>
              {s}
            </Chip>
          ))}
        </FilterGroup>
        <FilterGroup label="Min Z">
          <Chip active={minZ === 2} onClick={() => setMinZ(2)}>≥ Large</Chip>
          <Chip active={minZ === 3} onClick={() => setMinZ(3)}>Extreme only</Chip>
        </FilterGroup>
        <FilterGroup label="Fund rate">
          <Chip active={frFilter === "all"} onClick={() => setFrFilter("all")}>All</Chip>
          <Chip active={frFilter === "favorable"} onClick={() => setFrFilter("favorable")}>Favorable</Chip>
        </FilterGroup>
        <div className="ml-auto text-sm text-neutral-400">
          {filtered.length} signal{filtered.length === 1 ? "" : "s"}
        </div>
      </section>

      <SignalTable signals={filtered} />
    </main>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs uppercase tracking-wide text-neutral-500 mr-1">{label}</span>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
        active
          ? "bg-neutral-100 text-neutral-900"
          : "bg-neutral-900 text-neutral-400 border border-neutral-800 hover:border-neutral-700"
      }`}
    >
      {children}
    </button>
  );
}

function SignalTable({ signals }: { signals: Signal[] }) {
  if (signals.length === 0) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-8 text-center text-neutral-500 text-sm">
        No signals match the current filters.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-neutral-800 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-neutral-900 text-neutral-400 text-left">
          <tr>
            <th className="px-3 py-2 font-normal">Symbol</th>
            <th className="px-3 py-2 font-normal">TF</th>
            <th className="px-3 py-2 font-normal">Side</th>
            <th className="px-3 py-2 font-normal">HTF bias</th>
            <th className="px-3 py-2 font-normal">Z</th>
            <th className="px-3 py-2 font-normal" title="Last settled funding rate. Positive = longs pay; negative = shorts pay.">FR</th>
            <th className="px-3 py-2 font-normal text-right" title="Fraction of trigger bar volume that were taker buy orders.">Buy%</th>
            <th className="px-3 py-2 font-normal text-right" title="Open interest % change over the last 4 × 15m periods. Rising OI = new money entering.">OI Δ</th>
            <th className="px-3 py-2 font-normal">Conf</th>
            <th className="px-3 py-2 font-normal">Trigger</th>
            <th
              className="px-3 py-2 font-normal text-right"
              title="Market Profile level touched by the trigger candle wick"
            >
              Level touched
            </th>
            <th
              className="px-3 py-2 font-normal text-right"
              title="Close price of the trigger candle"
            >
              Bar close
            </th>
            <th
              className="px-3 py-2 font-normal text-right"
              title="How long the signal remains actionable before the next candle closes"
            >
              Valid for
            </th>
            <th className="px-3 py-2 font-normal">Time</th>
            <th className="px-3 py-2 font-normal"></th>
          </tr>
        </thead>
        <tbody>
          {signals.map((s, i) => (
            <tr
              key={`${s.symbol}-${s.timeframe}-${s.barTime}-${i}`}
              className="border-t border-neutral-800 hover:bg-neutral-900/40"
            >
              <td className="px-3 py-2 font-medium">{s.symbol}</td>
              <td className="px-3 py-2 text-neutral-400">{s.timeframe}</td>
              <td
                className={`px-3 py-2 ${
                  s.side === "long" ? "text-emerald-400" : "text-pink-400"
                }`}
              >
                {s.side}
              </td>
              <td className="px-3 py-2 text-xs text-neutral-400">
                {formatBias(s)}
              </td>
              <td className="px-3 py-2">
                <ZBadge level={s.zLevel} z={s.zScore} />
              </td>
              <td className="px-3 py-2">
                {s.fundingRate !== undefined ? (
                  <FRBadge rate={s.fundingRate} bias={s.frBias} />
                ) : (
                  <span className="text-neutral-600">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                {s.takerBuyRatio !== undefined ? (
                  <DeltaBadge ratio={s.takerBuyRatio} bias={s.deltaBias} side={s.side} />
                ) : (
                  <span className="text-neutral-600">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                {s.oiChangePct !== undefined ? (
                  <OIBadge changePct={s.oiChangePct} bias={s.oiBias} />
                ) : (
                  <span className="text-neutral-600">—</span>
                )}
              </td>
              <td className="px-3 py-2">
                <ConfBadges signal={s} />
              </td>
              <td className="px-3 py-2 text-neutral-300">{s.triggerLevel}</td>
              <td className="px-3 py-2 text-right tabular-nums text-neutral-400">
                {formatPrice(s.triggerPrice)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatPrice(s.barClose)}</td>
              <td className="px-3 py-2 text-right text-xs tabular-nums text-amber-300">
                {formatRemaining(signalExpiresAt(s) - Date.now())}
              </td>
              <td className="px-3 py-2 text-xs text-neutral-500 tabular-nums">
                {new Date(s.barTime).toISOString().slice(5, 16).replace("T", " ")}
              </td>
              <td className="px-3 py-2">
                <a
                  href={tradingViewUrl(s)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300"
                  title="Open Binance perpetual chart on TradingView"
                >
                  TV →
                </a>
                <a
                  href={binanceFuturesUrl(s.symbol)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-3 text-xs text-amber-400 hover:text-amber-300"
                  title="Open Binance Futures chart"
                >
                  BN
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function tradingViewUrl(s: Signal): string {
  const interval =
    s.timeframe === "1h" ? "60" : s.timeframe === "4h" ? "240" : s.timeframe.replace("m", "");
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${s.symbol}.P&interval=${interval}`;
}

function binanceFuturesUrl(symbol: string): string {
  return `https://www.binance.com/en/futures/${symbol}`;
}

function isSignalActive(signal: Signal, now: number): boolean {
  return now < signalExpiresAt(signal);
}

function signalExpiresAt(signal: Signal): number {
  return signal.barTime + TIMEFRAME_MS[signal.timeframe] * 2;
}

function formatBias(signal: Signal): string {
  if (!signal.bias4h || !signal.bias1h) return "-";
  return `4H ${signal.bias4h} / 1H ${signal.bias1h}`;
}

function DeltaBadge({ ratio, bias, side }: { ratio: number; bias?: DeltaBias; side: "long" | "short" }) {
  const pct = Math.round(ratio * 100);
  // Color relative to whether the pressure aligns with the signal direction.
  const styles =
    bias === "aligned"
      ? side === "long" ? "text-emerald-400" : "text-pink-400"
      : bias === "opposed"
      ? "text-red-400"
      : "text-neutral-400";
  return (
    <span className={`tabular-nums text-xs ${styles}`} title={`Taker buy ratio: ${pct}% of bar volume were aggressive buys`}>
      {pct}%
    </span>
  );
}

function OIBadge({ changePct, bias }: { changePct: number; bias?: "rising" | "flat" | "falling" }) {
  const arrow = bias === "rising" ? "↑" : bias === "falling" ? "↓" : "→";
  const styles =
    bias === "rising"  ? "text-emerald-400" :
    bias === "falling" ? "text-red-400"     : "text-neutral-400";
  return (
    <span
      className={`tabular-nums text-xs ${styles}`}
      title={`OI changed ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% over last 4 × 15m periods`}
    >
      {arrow}{Math.abs(changePct).toFixed(2)}%
    </span>
  );
}

function ConfBadges({ signal }: { signal: Signal }) {
  const flags: { label: string; title: string }[] = [];
  if (signal.nearVwap) flags.push({ label: "VWAP", title: "Bar close within tolerance of session VWAP" });
  if (signal.nearPdh)  flags.push({ label: "PDH",  title: "Bar touched previous-day high" });
  if (signal.nearPdl)  flags.push({ label: "PDL",  title: "Bar touched previous-day low" });
  if (flags.length === 0) return <span className="text-neutral-700">—</span>;
  return (
    <span className="flex gap-1 flex-wrap">
      {flags.map((f) => (
        <span
          key={f.label}
          title={f.title}
          className="px-1 py-0.5 text-xs rounded bg-amber-950/60 text-amber-300 border border-amber-900/50"
        >
          {f.label}
        </span>
      ))}
    </span>
  );
}

function FRBadge({ rate, bias }: { rate: number; bias?: FRBias }) {
  const pct = (rate * 100).toFixed(4);
  const signed = rate >= 0 ? `+${pct}%` : `${pct}%`;
  const styles =
    bias === "favorable"
      ? "text-emerald-400"
      : bias === "unfavorable"
      ? "text-red-400"
      : "text-neutral-400";
  return (
    <span className={`tabular-nums text-xs ${styles}`} title={`FR ${signed} per 8h`}>
      {signed}
    </span>
  );
}

function ZBadge({ level, z }: { level: 1 | 2 | 3; z: number }) {
  const styles =
    level === 3
      ? "bg-emerald-950 text-emerald-300 border-emerald-900"
      : level === 2
      ? "bg-blue-950 text-blue-300 border-blue-900"
      : "bg-neutral-900 text-neutral-400 border-neutral-800";
  const label = level === 3 ? "EX" : level === 2 ? "LG" : "—";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs border tabular-nums ${styles}`}>
      {label} {z.toFixed(2)}
    </span>
  );
}

function formatPrice(n: number): string {
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toFixed(7);
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
