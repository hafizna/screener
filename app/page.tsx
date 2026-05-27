"use client";

import { useEffect, useMemo, useState } from "react";
import type { DeltaBias, FRBias, LsBias, MarketRegime, ScanResult, Signal, SignalType, Timeframe } from "@/lib/types";

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

// Confluence score: each of the 6 factors contributes ±1.
// Range: −6 (everything opposed) to +6 (everything aligned).
function confluenceScore(s: Signal): number {
  const htf4h = s.bias4h === s.side ? 1 : s.bias4h && s.bias4h !== "neutral" && s.bias4h !== s.side ? -1 : 0;
  const htf1h = s.bias1h === s.side ? 1 : s.bias1h && s.bias1h !== "neutral" && s.bias1h !== s.side ? -1 : 0;
  const fr    = s.frBias    === "favorable" ? 1 : s.frBias    === "unfavorable" ? -1 : 0;
  const delta = s.deltaBias === "aligned"   ? 1 : s.deltaBias === "opposed"     ? -1 : 0;
  const oi    = s.oiBias    === "rising"    ? 1 : s.oiBias    === "falling"     ? -1 : 0;
  const ls    = s.lsBias
    ? (s.side === "long"
        ? s.lsBias === "crowded_shorts" ? 1 : s.lsBias === "crowded_longs" ? -1 : 0
        : s.lsBias === "crowded_longs"  ? 1 : s.lsBias === "crowded_shorts" ? -1 : 0)
    : 0;
  return htf4h + htf1h + fr + delta + oi + ls;
}

export default function DashboardPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Filters
  const [tfFilter, setTfFilter] = useState<Set<Timeframe>>(new Set(["15m"]));
  const [sideFilter, setSideFilter] = useState<"all" | "long" | "short">("all");
  const [minZ, setMinZ] = useState<2 | 3>(2);
  const [frFilter, setFrFilter] = useState<"all" | "favorable">("all");
  const [minScore, setMinScore] = useState<number>(0);
  const [typeFilter, setTypeFilter] = useState<"all" | "bounce" | "continuation">("all");

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

  // When regime changes, nudge filters to match the playbook automatically.
  // User can still override; this just saves them from manually switching every time.
  const regime = data && "regime" in data ? (data.regime as MarketRegime | undefined) : undefined;
  useEffect(() => {
    if (!regime) return;
    if (regime === "flush") {
      setSideFilter("long");        // bounce = longs at support
      setTypeFilter("bounce");
      setMinScore((prev) => Math.max(prev, 2)); // at least some squeeze confirmation
    } else if (regime === "breakout") {
      setSideFilter("long");        // continuation = riding the breakout
      setTypeFilter("continuation");
      setMinScore((prev) => Math.max(prev, 0));
    } else {
      setTypeFilter("all");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regime]);

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
      if (confluenceScore(s) < minScore) return false;
      if (typeFilter !== "all" && s.signalType !== typeFilter) return false;
      return true;
    });
  }, [activeSignals, tfFilter, sideFilter, minZ, frFilter, minScore, typeFilter]);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 px-3 py-4 sm:px-6 sm:py-6">
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
        <>
          {"regime" in data && data.regime && (
            <RegimeBanner regime={data.regime as MarketRegime} summary={"regimeSummary" in data ? data.regimeSummary as string : ""} />
          )}
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
        </>
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
        <FilterGroup label="Min score">
          {([0, 2, 3, 4] as const).map((n) => (
            <Chip key={n} active={minScore === n} onClick={() => setMinScore(n)}>
              {n === 0 ? "All" : `≥ ${n}`}
            </Chip>
          ))}
        </FilterGroup>
        <FilterGroup label="Type">
          <Chip active={typeFilter === "all"}          onClick={() => setTypeFilter("all")}>All</Chip>
          <Chip active={typeFilter === "bounce"}       onClick={() => setTypeFilter("bounce")}>Bounce</Chip>
          <Chip active={typeFilter === "continuation"} onClick={() => setTypeFilter("continuation")}>Cont.</Chip>
        </FilterGroup>
        <div className="ml-auto text-sm text-neutral-400">
          {filtered.length} signal{filtered.length === 1 ? "" : "s"}
        </div>
      </section>

      <SignalTable
        signals={filtered}
        regime={
          data && "regime" in data ? (data.regime as MarketRegime | undefined) : undefined
        }
      />
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

// Column visibility per regime:
//   flush     → hide HTF bias (bypassed by design), highlight Sqz/FR/L/S
//   breakout  → hide Sqz (not a squeeze play), highlight HTF bias
//   neutral   → show everything, no highlights
interface ColFlags {
  showHTF: boolean;
  showSqz: boolean;
  hlHTF: boolean;   // highlight header
  hlFR: boolean;
  hlLS: boolean;
  hlSqz: boolean;
}
function colFlags(regime?: MarketRegime): ColFlags {
  if (regime === "flush")    return { showHTF: false, showSqz: true,  hlHTF: false, hlFR: true,  hlLS: true,  hlSqz: true  };
  if (regime === "breakout") return { showHTF: true,  showSqz: false, hlHTF: true,  hlFR: false, hlLS: false, hlSqz: false };
  return                            { showHTF: true,  showSqz: true,  hlHTF: false, hlFR: false, hlLS: false, hlSqz: false };
}

function SignalTable({ signals, regime }: { signals: Signal[]; regime?: MarketRegime }) {
  if (signals.length === 0) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-8 text-center text-neutral-500 text-sm">
        No signals match the current filters.
      </div>
    );
  }

  const f = colFlags(regime);
  // Header cell: dim when not highlighted (in a regime-specific view), normal otherwise.
  const th = (label: string, extra?: string, highlight?: boolean) => (
    <th
      className={`px-3 py-2 font-normal ${highlight ? "text-neutral-100" : ""}`}
      title={extra}
    >
      {label}
    </th>
  );

  return (
    <div className="rounded-md border border-neutral-800 overflow-hidden">
      <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[1200px]">
        <thead className="bg-neutral-900 text-neutral-400 text-left">
          <tr>
            {th("Score", "Confluence score: HTF4H + HTF1H + FR + Delta + OI + L/S + RS, each ±1.")}
            {th("Symbol")}
            {th("Type", "Signal type given current market regime.")}
            {th("TF")}
            {th("Side")}
            {f.showHTF && th("HTF bias", undefined, f.hlHTF)}
            {th("Z")}
            {th("FR",   "Last settled funding rate. Positive = longs pay; negative = shorts pay.", f.hlFR)}
            <th className="px-3 py-2 font-normal text-right" title="Fraction of trigger bar volume that were taker buy orders.">Buy%</th>
            <th className="px-3 py-2 font-normal text-right" title="Open interest % change over last 4 × 15m periods.">OI Δ</th>
            <th className={`px-3 py-2 font-normal text-right ${f.hlLS ? "text-neutral-100" : ""}`} title="Global long/short account ratio. <0.85 = crowded shorts, >1.20 = crowded longs.">L/S</th>
            <th className="px-3 py-2 font-normal text-right" title="Relative strength vs BTC over last 4 × 4H bars.">RS</th>
            {f.showSqz && (
              <th className={`px-3 py-2 font-normal text-center ${f.hlSqz ? "text-neutral-100" : ""}`} title="Squeeze potential score (0–6): L/S + FR magnitude + OI + RS divergence.">Sqz</th>
            )}
            {th("Conf")}
            {th("Trigger")}
            <th className="px-3 py-2 font-normal text-right" title="Market Profile level touched by the trigger candle wick">Level</th>
            <th className="px-3 py-2 font-normal text-right" title="Close price of the trigger candle">Close</th>
            <th className="px-3 py-2 font-normal text-right" title="ATR-based targets: SL · TP1 (1.5×ATR) · TP2 (3×ATR)">SL · TP1 · TP2</th>
            <th className="px-3 py-2 font-normal text-right" title="How long the signal remains actionable">Valid</th>
            {th("Time")}
            <th className="px-3 py-2 font-normal"></th>
          </tr>
        </thead>
        <tbody>
          {signals.map((s, i) => (
            <tr
              key={`${s.symbol}-${s.timeframe}-${s.barTime}-${i}`}
              className="border-t border-neutral-800 hover:bg-neutral-900/40"
            >
              <td className="px-3 py-2">
                <ScoreBadge score={confluenceScore(s)} />
              </td>
              <td className="px-3 py-2 font-medium">{s.symbol}</td>
              <td className="px-3 py-2"><SignalTypeBadge type={s.signalType} /></td>
              <td className="px-3 py-2 text-neutral-400">{s.timeframe}</td>
              <td className={`px-3 py-2 ${s.side === "long" ? "text-emerald-400" : "text-pink-400"}`}>
                {s.side}
              </td>
              {f.showHTF && (
                <td className="px-3 py-2 text-xs text-neutral-400">{formatBias(s)}</td>
              )}
              <td className="px-3 py-2">
                <ZBadge level={s.zLevel} z={s.zScore} />
              </td>
              <td className="px-3 py-2">
                {s.fundingRate !== undefined
                  ? <FRBadge rate={s.fundingRate} bias={s.frBias} />
                  : <span className="text-neutral-600">—</span>}
              </td>
              <td className="px-3 py-2 text-right">
                {s.takerBuyRatio !== undefined
                  ? <DeltaBadge ratio={s.takerBuyRatio} bias={s.deltaBias} side={s.side} />
                  : <span className="text-neutral-600">—</span>}
              </td>
              <td className="px-3 py-2 text-right">
                {s.oiChangePct !== undefined
                  ? <OIBadge changePct={s.oiChangePct} bias={s.oiBias} />
                  : <span className="text-neutral-600">—</span>}
              </td>
              <td className="px-3 py-2 text-right">
                {s.longShortRatio !== undefined
                  ? <LSBadge ratio={s.longShortRatio} bias={s.lsBias} />
                  : <span className="text-neutral-600">—</span>}
              </td>
              <td className="px-3 py-2 text-right">
                {s.relativeStrength !== undefined
                  ? <RSBadge rs={s.relativeStrength} bias={s.rsBias} side={s.side} />
                  : <span className="text-neutral-600">—</span>}
              </td>
              {f.showSqz && (
                <td className="px-3 py-2 text-center">
                  {s.squeezeScore !== undefined
                    ? <SqueezeBadge score={s.squeezeScore} />
                    : <span className="text-neutral-600">—</span>}
                </td>
              )}
              <td className="px-3 py-2">
                <ConfBadges signal={s} />
              </td>
              <td className="px-3 py-2 text-neutral-300">{s.triggerLevel}</td>
              <td className="px-3 py-2 text-right tabular-nums text-neutral-400">
                {formatPrice(s.triggerPrice)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatPrice(s.barClose)}</td>
              <td className="px-3 py-2 text-right">
                <TargetsCell signal={s} />
              </td>
              <td className="px-3 py-2 text-right text-xs tabular-nums text-amber-300">
                {formatRemaining(signalExpiresAt(s) - Date.now())}
              </td>
              <td className="px-3 py-2 text-xs text-neutral-500 tabular-nums">
                {new Date(s.barTime).toISOString().slice(5, 16).replace("T", " ")}
              </td>
              <td className="px-3 py-2">
                <a href={tradingViewUrl(s)} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300" title="Open on TradingView">
                  TV →
                </a>
                <a href={binanceFuturesUrl(s.symbol)} target="_blank" rel="noopener noreferrer"
                  className="ml-3 text-xs text-amber-400 hover:text-amber-300" title="Open Binance Futures chart">
                  BN
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
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

function RegimeBanner({ regime, summary }: { regime: MarketRegime; summary: string }) {
  const styles =
    regime === "flush"     ? "bg-orange-950/50 border-orange-800/60 text-orange-200" :
    regime === "breakout"  ? "bg-emerald-950/50 border-emerald-800/60 text-emerald-200" :
                             "bg-neutral-900 border-neutral-800 text-neutral-400";
  const icon =
    regime === "flush"    ? "🔴" :
    regime === "breakout" ? "🟢" : "⚪";
  const label =
    regime === "flush"    ? "FLUSH — bouncing alts mode" :
    regime === "breakout" ? "BREAKOUT — trend continuation mode" :
                            "NEUTRAL — standard scan";
  return (
    <div className={`mb-3 px-3 py-2 rounded-md text-sm border flex items-center gap-2 ${styles}`}>
      <span>{icon}</span>
      <span className="font-medium">{label}</span>
      <span className="text-xs opacity-70 ml-1">{summary}</span>
    </div>
  );
}

function SignalTypeBadge({ type }: { type?: SignalType }) {
  if (!type || type === "standard") return <span className="text-neutral-600 text-xs">—</span>;
  const styles =
    type === "bounce"       ? "bg-orange-950/60 text-orange-300 border-orange-800/50" :
                              "bg-blue-950/60 text-blue-300 border-blue-800/50";
  const label = type === "bounce" ? "bounce" : "cont.";
  return (
    <span className={`px-1.5 py-0.5 text-xs rounded border ${styles}`}>{label}</span>
  );
}

function LSBadge({ ratio, bias }: { ratio: number; bias?: LsBias }) {
  const styles =
    bias === "crowded_shorts" ? "text-emerald-400" :
    bias === "crowded_longs"  ? "text-red-400"     : "text-neutral-400";
  return (
    <span
      className={`tabular-nums text-xs ${styles}`}
      title={`L/S ratio ${ratio.toFixed(2)} — ${bias === "crowded_shorts" ? "more shorts than longs" : bias === "crowded_longs" ? "more longs than shorts" : "balanced"}`}
    >
      {ratio.toFixed(2)}
    </span>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const styles =
    score >= 5  ? "bg-emerald-500  text-white border-emerald-400" :
    score >= 3  ? "bg-emerald-900  text-emerald-300 border-emerald-700" :
    score >= 0  ? "bg-neutral-800  text-neutral-300 border-neutral-700" :
                  "bg-red-950      text-red-400 border-red-900";
  const sign = score > 0 ? "+" : "";
  return (
    <span
      className={`inline-flex items-center justify-center w-8 h-6 rounded text-xs font-medium border tabular-nums ${styles}`}
      title={`Confluence score ${sign}${score} / 6 (HTF4H + HTF1H + FR + Delta + OI + L/S)`}
    >
      {sign}{score}
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

function RSBadge({ rs, bias, side }: { rs: number; bias?: Signal["rsBias"]; side: "long" | "short" }) {
  const aligned = (side === "long" && bias === "strong") || (side === "short" && bias === "weak");
  const opposed = (side === "long" && bias === "weak")   || (side === "short" && bias === "strong");
  const styles = aligned ? "text-emerald-400" : opposed ? "text-red-400" : "text-neutral-400";
  const arrow = bias === "strong" ? "↑" : bias === "weak" ? "↓" : "";
  return (
    <span
      className={`tabular-nums text-xs ${styles}`}
      title={`Relative strength vs BTC: ${rs.toFixed(3)} (>1.1 = outperforming, <0.9 = underperforming)`}
    >
      {arrow}{rs.toFixed(2)}
    </span>
  );
}

function SqueezeBadge({ score }: { score: number }) {
  const styles =
    score >= 5 ? "bg-orange-500   text-white border-orange-400" :
    score >= 3 ? "bg-orange-950/70 text-orange-300 border-orange-700/60" :
    score >= 1 ? "bg-neutral-800   text-neutral-300 border-neutral-700" :
                 "bg-neutral-900   text-neutral-600 border-neutral-800";
  return (
    <span
      className={`inline-flex items-center justify-center w-7 h-6 rounded text-xs font-medium border tabular-nums ${styles}`}
      title={`Squeeze potential score ${score}/6 (L/S positioning + FR magnitude + OI rising + RS divergence)`}
    >
      {score}
    </span>
  );
}

function TargetsCell({ signal: s }: { signal: Signal }) {
  if (s.tp1 === undefined || s.tp2 === undefined || s.sl === undefined) {
    return <span className="text-neutral-600 text-xs">—</span>;
  }
  const isLong = s.side === "long";
  return (
    <span className="flex gap-1.5 justify-end text-xs tabular-nums">
      <span
        className="text-red-400"
        title={`Stop loss: ${formatPrice(s.sl)} (1× ATR below entry)`}
      >
        {formatPrice(s.sl)}
      </span>
      <span className="text-neutral-600">·</span>
      <span
        className={isLong ? "text-emerald-300" : "text-pink-300"}
        title={`TP1: ${formatPrice(s.tp1)} (1.5× ATR)`}
      >
        {formatPrice(s.tp1)}
      </span>
      <span className="text-neutral-600">·</span>
      <span
        className={isLong ? "text-emerald-400" : "text-pink-400"}
        title={`TP2: ${formatPrice(s.tp2)} (3× ATR)`}
      >
        {formatPrice(s.tp2)}
      </span>
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
