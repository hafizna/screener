"use client";

import { useEffect, useMemo, useState } from "react";
import type { DeltaBias, FRBias, LsBias, MarketRegime, ScanResult, Signal, SignalType, Timeframe, WatchCandidate } from "@/lib/types";
import type { HistoryResult, SignalLog, Outcome } from "@/lib/db";

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

type SortDir = "asc" | "desc";
type WatchSortKey = "score" | "symbol" | "window" | "side" | "z" | "squeeze" | "time";
type HistoryFilter = Outcome | "all" | "running";
type HistoryConfidenceFilter = "all" | "high" | "medium" | "low";
type MainTab = "radar" | "entry" | "tracked" | "history";
type EntrySourceFilter = "all" | "radar";
type EntryViabilityFilter = "viable" | "all";
type EntryViabilityStatus = "viable" | "late" | "invalid" | "unknown";

interface EntryViability {
  status: EntryViabilityStatus;
  label: string;
  detail: string;
}

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
  const [tab, setTab] = useState<MainTab>("radar");

  // ── Live tab state ──────────────────────────────────────────────────────────
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // ── History tab state ───────────────────────────────────────────────────────
  const [history, setHistory] = useState<HistoryResult | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [histErr, setHistErr] = useState<string | null>(null);

  // ── Tracked signals from DB ─────────────────────────────────────────────────
  type TrackedSignal = SignalLog & { current_price: number | null };
  const [trackedSignals, setTrackedSignals] = useState<TrackedSignal[] | null>(null);
  const [trackedLoading, setTrackedLoading] = useState(false);
  const [trackedErr, setTrackedErr] = useState<string | null>(null);

  // Starred ids are persisted in localStorage so the button state survives refresh.
  const [watched, setWatched] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try { return new Set(JSON.parse(localStorage.getItem("watched") ?? "[]") as string[]); }
    catch { return new Set(); }
  });

  async function watchSignal(id: string, holdDays: number) {
    const next = new Set(watched).add(id);
    setWatched(next);
    localStorage.setItem("watched", JSON.stringify([...next]));
    await fetch("/api/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, holdDays }) }).catch(() => {});
  }

  // Filters
  const [tfFilter, setTfFilter] = useState<Set<Timeframe>>(new Set(["15m", "1h"]));
  const [sideFilter, setSideFilter] = useState<"all" | "long" | "short">("all");
  const [minZ, setMinZ] = useState<2 | 3>(2);
  const [frFilter, setFrFilter] = useState<"all" | "favorable">("all");
  const [minScore, setMinScore] = useState<number>(0);
  const [typeFilter, setTypeFilter] = useState<"all" | "bounce" | "continuation">("all");
  const [entryViabilityFilter, setEntryViabilityFilter] = useState<EntryViabilityFilter>("viable");

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

  async function loadHistory() {
    setHistLoading(true);
    setHistErr(null);
    try {
      const res = await fetch("/api/history", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHistory((await res.json()) as HistoryResult);
    } catch (e) {
      setHistErr((e as Error).message);
    } finally {
      setHistLoading(false);
    }
  }

  async function loadTrackedSignals() {
    setTrackedLoading(true);
    setTrackedErr(null);
    try {
      const res = await fetch("/api/watchlist", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setTrackedSignals(((await res.json()) as { signals: TrackedSignal[] }).signals);
    } catch (e) {
      setTrackedErr((e as Error).message);
    }
    finally { setTrackedLoading(false); }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, []);

  // Load history when user switches to the History tab (lazy — don't fetch until needed)
  useEffect(() => {
    if (tab === "history" && !history && !histLoading) loadHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Load tracked signals on mount + whenever user switches to Tracked tab.
  // Also auto-refresh every 60s while on the Tracked tab so DB changes surface quickly.
  useEffect(() => {
    loadTrackedSignals();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab !== "tracked") return;
    loadTrackedSignals();
    const id = setInterval(loadTrackedSignals, 60_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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

  const watchlist = useMemo<WatchCandidate[]>(() => {
    if (!data || data.scannedAt === null || !("watchlist" in data)) return [];
    return data.watchlist ?? [];
  }, [data]);

  const [entrySourceFilter, setEntrySourceFilter] = useState<EntrySourceFilter>("all");

  const radarSignals = useMemo(() =>
    activeSignals.filter((s) => s.fromWatchlist),
  [activeSignals]);

  const signalPool = useMemo(() =>
    entrySourceFilter === "radar" ? radarSignals : activeSignals,
  [activeSignals, radarSignals, entrySourceFilter]);

  const viableSignalCount = useMemo(() =>
    signalPool.filter(isEntryViable).length,
  [signalPool]);

  const filtered = useMemo<Signal[]>(() => {
    if (signalPool.length === 0) return [];
    return signalPool.filter((s) => {
      if (entryViabilityFilter === "viable" && !isEntryViable(s)) return false;
      if (!tfFilter.has(s.timeframe)) return false;
      if (sideFilter !== "all" && s.side !== sideFilter) return false;
      if (s.zLevel < minZ) return false;
      if (frFilter === "favorable" && s.frBias !== "favorable") return false;
      if (confluenceScore(s) < minScore) return false;
      if (typeFilter !== "all" && s.signalType !== typeFilter) return false;
      return true;
    });
  }, [signalPool, entryViabilityFilter, tfFilter, sideFilter, minZ, frFilter, minScore, typeFilter]);

  // ── Guide modal ─────────────────────────────────────────────────────────────
  const [showGuide, setShowGuide] = useState(false);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 px-3 py-4 sm:px-6 sm:py-6">
      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}
      <header className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium">MP + Z screener</h1>
          <p className="text-sm text-neutral-400">Binance USDT-M futures · top by volume</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowGuide(true)}
            className="px-2 py-1.5 text-sm rounded-md border border-neutral-700 hover:border-neutral-500 text-neutral-400 hover:text-neutral-200 transition-colors"
            title="How to use this app"
          >
            ?
          </button>
          <div className="flex rounded-md border border-neutral-700 overflow-hidden text-sm">
            <button
              onClick={() => setTab("radar")}
              className={`px-3 py-1.5 transition-colors ${tab === "radar" ? "bg-neutral-100 text-neutral-900" : "text-neutral-400 hover:text-neutral-200"}`}
            >
              Radar
            </button>
            <button
              onClick={() => setTab("entry")}
              className={`px-3 py-1.5 transition-colors border-l border-neutral-700 ${tab === "entry" ? "bg-neutral-100 text-neutral-900" : "text-neutral-400 hover:text-neutral-200"}`}
            >
              Entry
            </button>
            <button
              onClick={() => setTab("tracked")}
              className={`px-3 py-1.5 transition-colors border-l border-neutral-700 ${tab === "tracked" ? "bg-neutral-100 text-neutral-900" : "text-neutral-400 hover:text-neutral-200"}`}
            >
              Tracked
            </button>
            <button
              onClick={() => setTab("history")}
              className={`px-3 py-1.5 transition-colors border-l border-neutral-700 ${tab === "history" ? "bg-neutral-100 text-neutral-900" : "text-neutral-400 hover:text-neutral-200"}`}
            >
              History
            </button>
          </div>
          {(tab === "radar" || tab === "entry") && (
            <button
              onClick={refresh}
              className="px-3 py-1.5 text-sm rounded-md border border-neutral-700 hover:border-neutral-500 transition-colors"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          )}
          {tab === "tracked" && (
            <button
              onClick={loadTrackedSignals}
              className="px-3 py-1.5 text-sm rounded-md border border-neutral-700 hover:border-neutral-500 transition-colors"
            >
              {trackedLoading ? "Loading…" : "Reload"}
            </button>
          )}
          {tab === "history" && (
            <button
              onClick={loadHistory}
              className="px-3 py-1.5 text-sm rounded-md border border-neutral-700 hover:border-neutral-500 transition-colors"
            >
              {histLoading ? "Loading…" : "Reload"}
            </button>
          )}
        </div>
      </header>

      {tab === "history" && (
        <HistoryTab history={history} loading={histLoading} err={histErr} />
      )}
      {tab !== "history" && (<>

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
            {watchlist.length > 0 && ` · ${watchlist.length} radar candidates`}
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

      {tab === "radar" && (
        <WatchlistTab
          mode="radar"
          candidates={watchlist}
          loading={loading}
          tracked={null}
          trackedLoading={false}
          trackedErr={null}
          onReloadTracked={loadTrackedSignals}
        />
      )}

      {tab === "tracked" && (
        <WatchlistTab
          mode="tracked"
          candidates={[]}
          loading={false}
          tracked={trackedSignals}
          trackedLoading={trackedLoading}
          trackedErr={trackedErr}
          onReloadTracked={loadTrackedSignals}
        />
      )}

      {tab === "entry" && (<>
      <section className="mb-4 flex flex-wrap gap-2 items-center">
        <FilterGroup label="Timeframe">
          {(["15m", "1h"] as Timeframe[]).map((tf) => (
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
        <FilterGroup label="Entry">
          <Chip active={entryViabilityFilter === "viable"} onClick={() => setEntryViabilityFilter("viable")}>
            Viable
          </Chip>
          <Chip active={entryViabilityFilter === "all"} onClick={() => setEntryViabilityFilter("all")}>
            All
          </Chip>
        </FilterGroup>
        <div className="ml-auto flex items-center gap-3 text-sm text-neutral-400">
          {filtered.length} signal{filtered.length === 1 ? "" : "s"}
          <span className="text-xs text-neutral-600">{viableSignalCount}/{signalPool.length} viable</span>
          {radarSignals.length > 0 && (
            <button
              onClick={() => setEntrySourceFilter((v) => v === "all" ? "radar" : "all")}
              className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                entrySourceFilter === "radar"
                  ? "bg-amber-950/60 text-amber-300 border-amber-800/60"
                  : "text-neutral-500 border-neutral-700 hover:text-neutral-300"
              }`}
              title={entrySourceFilter === "radar" ? "Showing radar-sourced fired signals" : "Showing all fired signals"}
            >
              {entrySourceFilter === "radar"
                ? `Radar-sourced (${radarSignals.length})`
                : `All (${activeSignals.length}) · ${radarSignals.length} from radar`}
            </button>
          )}
          {radarSignals.length === 0 && activeSignals.length > 0 && (
            <span className="text-xs text-neutral-600">no radar-sourced hits yet</span>
          )}
        </div>
      </section>

      <SignalTable
        signals={filtered}
        regime={data && "regime" in data ? (data.regime as MarketRegime | undefined) : undefined}
        watched={watched}
        onWatch={watchSignal}
      />
      </>)}
      </>)}
    </main>
  );
}

// ─── History Tab ──────────────────────────────────────────────────────────────

function TradeLifecycleBadge({ signal, currentPrice }: { signal: SignalLog; currentPrice?: number | null }) {
  if (signal.outcome !== "active") {
    return <OutcomeBadge outcome={signal.outcome} />;
  }
  if (signal.best_tp === "tp2") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border bg-emerald-600 text-white border-emerald-500">
        TP2 ✓ Running →TP3
      </span>
    );
  }
  if (signal.best_tp === "tp1") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border bg-emerald-900 text-emerald-300 border-emerald-700">
        TP1 ✓ Running →TP2
      </span>
    );
  }
  // Near Entry: current price within 1% of entry — this is the moment to act
  if (currentPrice != null && signal.entry_price > 0) {
    const distPct = Math.abs(currentPrice - signal.entry_price) / signal.entry_price * 100;
    if (distPct <= 1.0) {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border bg-amber-950/80 text-amber-300 border-amber-700/70 animate-pulse">
          Near Entry {distPct.toFixed(2)}%
        </span>
      );
    }
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border bg-neutral-900 text-neutral-400 border-neutral-700">
      Waiting
    </span>
  );
}

// Effective SL based on trailing logic (mirrors resolveOutcome in lib/outcomes.ts).
// After TP1 → trails to entry (BE). After TP2 → trails to TP1.
function TrailingSLCell({ row }: { row: SignalLog }) {
  if (row.outcome !== "active") {
    return <span className="text-neutral-500">{row.sl != null ? formatPrice(row.sl) : "—"}</span>;
  }
  if (row.best_tp === "tp2" && row.tp1 != null) {
    return (
      <span title="Trailing SL: TP1 (locked-in TP2 minimum)">
        <span className="text-emerald-400">{formatPrice(row.tp1)}</span>
        <span className="ml-1 text-[10px] text-emerald-600">→ TP1</span>
      </span>
    );
  }
  if (row.best_tp === "tp1") {
    return (
      <span title="Trailing SL: entry (locked-in break-even)">
        <span className="text-emerald-300">{formatPrice(row.entry_price)}</span>
        <span className="ml-1 text-[10px] text-emerald-600">→ BE</span>
      </span>
    );
  }
  return <span className="text-neutral-500">{row.sl != null ? formatPrice(row.sl) : "—"}</span>;
}

function WatchlistTab({
  mode,
  candidates,
  loading,
  tracked,
  trackedLoading,
  trackedErr,
  onReloadTracked,
}: {
  mode: "radar" | "tracked";
  candidates: WatchCandidate[];
  loading: boolean;
  tracked: (SignalLog & { current_price: number | null })[] | null;
  trackedLoading: boolean;
  trackedErr: string | null;
  onReloadTracked: () => void;
}) {
  const [sortKey, setSortKey] = useState<WatchSortKey>("score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const sorted = useMemo(() => {
    const windowRank = { "1-2d": 1, "3-5d": 2, "5-7d": 3 };
    const valueFor = (row: WatchCandidate): number | string => {
      if (sortKey === "score") return row.score;
      if (sortKey === "symbol") return row.symbol;
      if (sortKey === "window") return windowRank[row.biasWindow ?? "1-2d"];
      if (sortKey === "side") return row.side;
      if (sortKey === "z") return row.zScore;
      if (sortKey === "squeeze") return row.squeezeScore ?? -1;
      return row.barTime;
    };
    return [...candidates].sort((a, b) => {
      const av = valueFor(a);
      const bv = valueFor(b);
      const cmp = typeof av === "string" && typeof bv === "string"
        ? av.localeCompare(bv)
        : Number(av) - Number(bv);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [candidates, sortDir, sortKey]);

  const setSort = (key: WatchSortKey) => {
    if (sortKey === key) {
      setSortDir((prev) => prev === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(key);
    setSortDir(key === "symbol" || key === "side" ? "asc" : "desc");
  };

  const sortLabel = (label: string, key: WatchSortKey) =>
    `${label}${sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}`;

  // Split tracked signals by lifecycle state
  const running  = tracked?.filter((s) => s.outcome === "active" && s.best_tp != null) ?? [];
  const nearEntry = tracked?.filter((s) => {
    if (s.outcome !== "active" || s.best_tp != null) return false;
    if (s.current_price == null || s.entry_price <= 0) return false;
    return Math.abs(s.current_price - s.entry_price) / s.entry_price * 100 <= 1.0;
  }) ?? [];
  const waiting  = tracked?.filter((s) => {
    if (s.outcome !== "active" || s.best_tp != null) return false;
    if (s.current_price == null || s.entry_price <= 0) return true;
    return Math.abs(s.current_price - s.entry_price) / s.entry_price * 100 > 1.0;
  }) ?? [];
  const resolved = tracked?.filter((s) => s.outcome !== "active") ?? [];

  return (
    <div className="space-y-6">
      {/* ── My Tracked Signals (from DB) ──────────────────────────────────── */}
      {mode === "tracked" && (
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-medium text-neutral-300">
              Active / Starred Signals
              {tracked && ` · ${tracked.length} total`}
            </h2>
            <button
              onClick={onReloadTracked}
              className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              {trackedLoading ? "Loading…" : "Reload"}
            </button>
          </div>

          {trackedLoading && !tracked && (
            <div className="text-neutral-600 text-sm py-4 text-center">Loading…</div>
          )}

          {trackedErr && (
            <div className="rounded-md border border-red-900/60 bg-red-950/30 p-4 text-center text-red-300 text-sm">
              Tracked failed to load: {trackedErr}
            </div>
          )}

          {!trackedLoading && !trackedErr && tracked === null && (
            <div className="text-neutral-600 text-sm py-4 text-center">No tracked data loaded yet.</div>
          )}

          {tracked !== null && tracked.length === 0 && (
            <div className="rounded-md border border-neutral-800 bg-neutral-900/20 p-6 text-center text-neutral-600 text-sm">
              No active or starred signals yet. New entries will show here automatically.
            </div>
          )}

          {tracked !== null && tracked.length > 0 && (
            <div className="rounded-md border border-neutral-800 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[720px]">
                  <thead className="bg-neutral-900 text-neutral-400 text-left">
                    <tr>
                      <th className="px-3 py-2 font-normal">Symbol</th>
                      <th className="px-3 py-2 font-normal">Side</th>
                      <th className="px-3 py-2 font-normal">Status</th>
                      <th className="px-3 py-2 font-normal text-right">Entry</th>
                      <th className="px-3 py-2 font-normal text-right">TP1</th>
                      <th className="px-3 py-2 font-normal text-right">TP2</th>
                      <th className="px-3 py-2 font-normal text-right">TP3</th>
                      <th className="px-3 py-2 font-normal text-right">SL</th>
                      <th className="px-3 py-2 font-normal">Age</th>
                      <th className="px-3 py-2 font-normal"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Running → Near Entry (pulsing) → Waiting → Resolved */}
                    {[...running, ...nearEntry, ...waiting, ...resolved].map((row) => (
                      <tr
                        key={row.id}
                        className={`border-t border-neutral-800 hover:bg-neutral-900/40 ${
                          row.outcome === "active" && row.best_tp != null
                            ? "bg-emerald-950/10"
                            : nearEntry.includes(row)
                            ? "bg-amber-950/20"
                            : ""
                        }`}
                      >
                        <td className="px-3 py-2 font-medium">{row.symbol}</td>
                        <td className={`px-3 py-2 ${row.side === "long" ? "text-emerald-400" : "text-pink-400"}`}>
                          {row.side}
                        </td>
                        <td className="px-3 py-2">
                          <TradeLifecycleBadge signal={row} currentPrice={row.current_price} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
                          {formatPrice(row.entry_price)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-neutral-500">
                          {row.tp1 != null ? formatPrice(row.tp1) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-neutral-500">
                          {row.tp2 != null ? formatPrice(row.tp2) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-cyan-600">
                          {row.tp3 != null ? formatPrice(row.tp3) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <TrailingSLCell row={row} />
                        </td>
                        <td className="px-3 py-2 text-xs text-neutral-500 tabular-nums">
                          {new Date(row.bar_time).toISOString().slice(5, 16).replace("T", " ")}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <a href={tradingViewSymbolUrl(row.symbol, row.timeframe as import("@/lib/types").Timeframe)} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300">TV</a>
                          <a href={binanceFuturesUrl(row.symbol)} target="_blank" rel="noopener noreferrer" className="ml-3 text-xs text-amber-400 hover:text-amber-300">BN</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Near Setups (auto-detected from current scan) ─────────────────── */}
      {mode === "radar" && <section>
        <h2 className="text-sm font-medium text-neutral-300 mb-2">
          Radar Candidates
          {candidates.length > 0 && ` · ${candidates.length} detected`}
        </h2>
        {loading && (
          <div className="text-neutral-500 text-sm py-8 text-center">Refreshing…</div>
        )}
        {!loading && candidates.length === 0 && (
          <div className="rounded-md border border-neutral-800 bg-neutral-900/20 p-6 text-center text-neutral-600 text-sm">
            No radar candidates in the latest scan.
          </div>
        )}
        {!loading && candidates.length > 0 && (
          <div className="rounded-md border border-neutral-800 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[1380px]">
                <thead className="bg-neutral-900 text-neutral-400 text-left">
                  <tr>
                    <th className="px-3 py-2 font-normal"><button onClick={() => setSort("score")}>{sortLabel("Score", "score")}</button></th>
                    <th className="px-3 py-2 font-normal"><button onClick={() => setSort("symbol")}>{sortLabel("Symbol", "symbol")}</button></th>
                    <th className="px-3 py-2 font-normal">State</th>
                    <th className="px-3 py-2 font-normal"><button onClick={() => setSort("window")}>{sortLabel("Window", "window")}</button></th>
                    <th className="px-3 py-2 font-normal"><button onClick={() => setSort("side")}>{sortLabel("Side", "side")}</button></th>
                    <th className="px-3 py-2 font-normal">HTF bias</th>
                    <th className="px-3 py-2 font-normal"><button onClick={() => setSort("z")}>{sortLabel("Z", "z")}</button></th>
                    <th className="px-3 py-2 font-normal text-right">Level</th>
                    <th className="px-3 py-2 font-normal text-right">Entry</th>
                    <th className="px-3 py-2 font-normal text-right">SL</th>
                    <th className="px-3 py-2 font-normal text-right">TP1</th>
                    <th className="px-3 py-2 font-normal text-right">TP2</th>
                    <th className="px-3 py-2 font-normal text-right text-cyan-500">TP3</th>
                    <th className="px-3 py-2 font-normal text-right">FR</th>
                    <th className="px-3 py-2 font-normal text-right">L/S</th>
                    <th className="px-3 py-2 font-normal text-right">OI</th>
                    <th className="px-3 py-2 font-normal text-right">RS</th>
                    <th className="px-3 py-2 font-normal text-center"><button onClick={() => setSort("squeeze")}>{sortLabel("Sqz", "squeeze")}</button></th>
                    <th className="px-3 py-2 font-normal">Ready / Missing</th>
                    <th className="px-3 py-2 font-normal"><button onClick={() => setSort("time")}>{sortLabel("Time", "time")}</button></th>
                    <th className="px-3 py-2 font-normal"></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => (
                    <tr key={`${row.symbol}-${row.side}-${row.barTime}`} className="border-t border-neutral-800 hover:bg-neutral-900/40">
                      <td className="px-3 py-2"><ScoreBadge score={row.score} /></td>
                      <td className="px-3 py-2 font-medium">{row.symbol}</td>
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 text-xs rounded border ${row.state === "near_trigger" ? "bg-amber-950/70 text-amber-300 border-amber-700/60" : "bg-neutral-900 text-neutral-400 border-neutral-700"}`}>
                          {row.state === "near_trigger" ? "near" : "watch"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-neutral-300 tabular-nums">{row.biasWindow ?? "1-2d"}</td>
                      <td className={`px-3 py-2 ${row.side === "long" ? "text-emerald-400" : "text-pink-400"}`}>{row.side}</td>
                      <td className="px-3 py-2 text-xs text-neutral-400">4H {row.bias4h ?? "-"} / 1H {row.bias1h ?? "-"}</td>
                      <td className="px-3 py-2"><ZBadge level={row.zLevel} z={row.zScore} /></td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums">
                        <span className="text-neutral-300">{row.triggerLevel}</span>{" "}
                        <span className="text-neutral-500">{formatPrice(row.triggerPrice)}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-300">{formatPrice(row.entryPrice ?? row.barClose)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-400 text-xs">{row.sl !== undefined ? formatPrice(row.sl) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-300 text-xs">{row.tp1 !== undefined ? formatPrice(row.tp1) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-400 text-xs">{row.tp2 !== undefined ? formatPrice(row.tp2) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-cyan-600 text-xs">{row.tp3 !== undefined ? formatPrice(row.tp3) : "—"}</td>
                      <td className="px-3 py-2 text-right">
                        {row.fundingRate !== undefined ? <FRBadge rate={row.fundingRate} bias={row.frBias} /> : <span className="text-neutral-600">-</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {row.longShortRatio !== undefined ? <LSBadge ratio={row.longShortRatio} bias={row.lsBias} /> : <span className="text-neutral-600">-</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {row.oiChangePct !== undefined ? <OIBadge changePct={row.oiChangePct} bias={row.oiBias} /> : <span className="text-neutral-600">-</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {row.relativeStrength !== undefined ? <RSBadge rs={row.relativeStrength} bias={row.rsBias} side={row.side} /> : <span className="text-neutral-600">-</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {row.squeezeScore !== undefined ? <SqueezeBadge score={row.squeezeScore} /> : <span className="text-neutral-600">-</span>}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div className="text-neutral-300">{row.reasons.slice(0, 2).join(" | ")}</div>
                        {row.missing.length > 0 && <div className="text-amber-400">{row.missing.slice(0, 2).join(" | ")}</div>}
                      </td>
                      <td className="px-3 py-2 text-xs text-neutral-500 tabular-nums">
                        {new Date(row.barTime).toISOString().slice(5, 16).replace("T", " ")}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <a href={tradingViewSymbolUrl(row.symbol, row.timeframe)} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300">TV</a>
                        <a href={binanceFuturesUrl(row.symbol)} target="_blank" rel="noopener noreferrer" className="ml-3 text-xs text-amber-400 hover:text-amber-300">BN</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const cfg: Record<Outcome, { label: string; cls: string }> = {
    tp3:     { label: "TP3 ✓",   cls: "bg-emerald-400   text-neutral-900 border-emerald-300" },
    tp2:     { label: "TP2 ✓",   cls: "bg-emerald-600   text-white border-emerald-500" },
    tp1:     { label: "TP1 ✓",   cls: "bg-emerald-900   text-emerald-300 border-emerald-700" },
    sl:      { label: "SL ✗",    cls: "bg-red-950       text-red-400 border-red-800" },
    expired: { label: "Expired", cls: "bg-neutral-800   text-neutral-500 border-neutral-700" },
    active:  { label: "Active",  cls: "bg-blue-950      text-blue-300 border-blue-800" },
  };
  const { label, cls } = cfg[outcome] ?? cfg.active;
  return (
    <span className={`inline-flex px-1.5 py-0.5 text-xs rounded border tabular-nums ${cls}`}>
      {label}
    </span>
  );
}

function RunningBadge({ bestTP }: { bestTP: string | null }) {
  if (bestTP === "tp2") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border bg-emerald-600 text-white border-emerald-500">
        TP2 ✓ →TP3
      </span>
    );
  }
  if (bestTP === "tp1") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border bg-emerald-900 text-emerald-300 border-emerald-700">
        TP1 ✓ →TP2
      </span>
    );
  }
  return <OutcomeBadge outcome="active" />;
}

function HistoryTab({ history, loading, err }: { history: HistoryResult | null; loading: boolean; err: string | null }) {
  const [outcomeFilter, setOutcomeFilter] = useState<HistoryFilter>("all");
  const [confidenceFilter, setConfidenceFilter] = useState<HistoryConfidenceFilter>("all");
  if (loading) return <div className="text-neutral-500 text-sm py-12 text-center">Loading signal history…</div>;
  if (err)     return <div className="text-red-400 text-sm py-4">Error: {err}</div>;
  if (!history) return null;

  const { signals, stats } = history;
  const resolved = stats.tp3 + stats.tp2 + stats.tp1 + stats.sl + stats.expired;
  const filteredSignals = signals.filter((row) => {
    if (outcomeFilter === "running") {
      if (row.outcome !== "active") return false;
    } else if (outcomeFilter !== "all" && row.outcome !== outcomeFilter) {
      return false;
    }
    if (confidenceFilter !== "all" && historyConfidenceBucket(row) !== confidenceFilter) return false;
    return true;
  });
  const confidenceRows = historyPerformanceRows(signals, historyConfidenceBucket);
  const squeezeRows = historyPerformanceRows(signals, historySqueezeBucket);
  const profileRows = historyPerformanceRows(signals, (row) => row.trigger_level || "unknown");

  return (
    <div>
      {/* Stats bar */}
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <StatPill label="Resolved" value={stats.total.toString()} active={outcomeFilter === "all"} onClick={() => setOutcomeFilter("all")} />
        {stats.running > 0 && (
          <StatPill label="Running" value={stats.running.toString()} color="text-emerald-300" active={outcomeFilter === "running"} onClick={() => setOutcomeFilter("running")} />
        )}
        <StatPill label="TP3 swing" value={`${stats.tp3} (${stats.tp3Rate}%)`} color="text-cyan-400" active={outcomeFilter === "tp3"} onClick={() => setOutcomeFilter("tp3")} />
        <StatPill label="TP2" value={`${stats.tp2} (${stats.tp2Rate}%)`} color="text-emerald-400" active={outcomeFilter === "tp2"} onClick={() => setOutcomeFilter("tp2")} />
        <StatPill label="TP1" value={`${stats.tp1} (${stats.tp1Rate}%)`} color="text-emerald-300" active={outcomeFilter === "tp1"} onClick={() => setOutcomeFilter("tp1")} />
        <StatPill label="SL"  value={`${stats.sl} (${stats.slRate}%)`}   color="text-red-400" active={outcomeFilter === "sl"} onClick={() => setOutcomeFilter("sl")} />
        <StatPill label="Expired" value={stats.expired.toString()} color="text-neutral-500" active={outcomeFilter === "expired"} onClick={() => setOutcomeFilter("expired")} />
        {resolved > 0 && (
          <StatPill label="Win rate" value={`${stats.winRate}%`} color="text-amber-300" />
        )}
      </div>

      <section className="mb-4 flex flex-wrap gap-2 items-center">
        <FilterGroup label="Confidence">
          {(["all", "high", "medium", "low"] as const).map((bucket) => (
            <Chip key={bucket} active={confidenceFilter === bucket} onClick={() => setConfidenceFilter(bucket)}>
              {bucket}
            </Chip>
          ))}
        </FilterGroup>
        <div className="ml-auto text-sm text-neutral-400">
          {filteredSignals.length} row{filteredSignals.length === 1 ? "" : "s"}
        </div>
      </section>

      <div className="mb-4 grid gap-3 lg:grid-cols-3">
        <HistoryBreakdown title="Confidence" rows={confidenceRows} />
        <HistoryBreakdown title="SQZ" rows={squeezeRows} />
        <HistoryBreakdown title="Profile" rows={profileRows} />
      </div>

      {filteredSignals.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-8 text-center text-neutral-500 text-sm">
          No signals match this filter. History includes resolved + in-flight (TP1+) runners.
        </div>
      ) : (
        <div className="rounded-md border border-neutral-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="bg-neutral-900 text-neutral-400 text-left">
                <tr>
                  <th className="px-3 py-2 font-normal">Time</th>
                  <th className="px-3 py-2 font-normal">Symbol</th>
                  <th className="px-3 py-2 font-normal">Side</th>
                  <th className="px-3 py-2 font-normal">Regime</th>
                  <th className="px-3 py-2 font-normal">Type</th>
                  <th className="px-3 py-2 font-normal text-right">Entry</th>
                  <th className="px-3 py-2 font-normal text-right">SL</th>
                  <th className="px-3 py-2 font-normal text-right">TP1</th>
                  <th className="px-3 py-2 font-normal text-right">TP2</th>
                  <th className="px-3 py-2 font-normal text-right text-cyan-500" title="Swing target: 5× ATR">TP3</th>
                  <th className="px-3 py-2 font-normal text-center">Sqz</th>
                  <th className="px-3 py-2 font-normal">Outcome</th>
                  <th className="px-3 py-2 font-normal text-right" title="Time from signal to outcome">Duration</th>
                  <th className="px-3 py-2 font-normal text-right" title="Best price move in direction of trade (Maximum Favorable Excursion)">MFE</th>
                  <th className="px-3 py-2 font-normal text-right" title="Worst price move against trade (Maximum Adverse Excursion)">MAE</th>
                </tr>
              </thead>
              <tbody>
                {filteredSignals.map((row) => {
                  const isRunning = row.outcome === "active";
                  const durationMs = row.outcome_at
                    ? row.outcome_at - row.bar_time
                    : isRunning ? Date.now() - row.bar_time : null;
                  const mfe = row.max_favorable && row.entry_price
                    ? Math.abs(row.max_favorable) / row.entry_price * 100 : null;
                  const mae = row.max_adverse && row.entry_price
                    ? Math.abs(row.max_adverse)   / row.entry_price * 100 : null;
                  return (
                    <tr key={row.id} className={`border-t border-neutral-800 hover:bg-neutral-900/40 ${isRunning ? "bg-emerald-950/10" : ""}`}>
                      <td className="px-3 py-2 text-xs text-neutral-500 tabular-nums whitespace-nowrap">
                        {new Date(row.bar_time).toISOString().slice(5, 16).replace("T", " ")}
                      </td>
                      <td className="px-3 py-2 font-medium">
                        {row.symbol}
                        {row.watched && <span className="ml-1 text-amber-300 text-xs" title="Starred">★</span>}
                      </td>
                      <td className={`px-3 py-2 ${row.side === "long" ? "text-emerald-400" : "text-pink-400"}`}>
                        {row.side}
                      </td>
                      <td className="px-3 py-2 text-xs text-neutral-400">{row.regime ?? "—"}</td>
                      <td className="px-3 py-2">
                        <SignalTypeBadge type={row.signal_type as SignalType | undefined} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatPrice(row.entry_price)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-400 text-xs">
                        {row.sl ? formatPrice(row.sl) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-300 text-xs">
                        {row.tp1 ? formatPrice(row.tp1) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-400 text-xs">
                        {row.tp2 ? formatPrice(row.tp2) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-cyan-400 text-xs">
                        {row.tp3 ? formatPrice(row.tp3) : "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {row.squeeze_score !== null ? <SqueezeBadge score={row.squeeze_score} /> : <span className="text-neutral-600">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        {isRunning ? <RunningBadge bestTP={row.best_tp} /> : <OutcomeBadge outcome={row.outcome} />}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-neutral-400">
                        {durationMs ? formatDuration(durationMs) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-emerald-400">
                        {mfe !== null ? `+${mfe.toFixed(2)}%` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-red-400">
                        {mae !== null ? `−${mae.toFixed(2)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

interface HistoryPerfRow {
  label: string;
  total: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number;
  avgMfe: number | null;
  avgMae: number | null;
}

function historyConfidenceBucket(row: SignalLog): HistoryConfidenceFilter {
  const sqz = row.squeeze_score ?? 0;
  const score = row.z_level + Math.min(3, sqz);
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function historySqueezeBucket(row: SignalLog): string {
  const sqz = row.squeeze_score;
  if (sqz === null) return "none";
  if (sqz >= 5) return "5-6";
  if (sqz >= 3) return "3-4";
  if (sqz >= 1) return "1-2";
  return "0";
}

function historyPerformanceRows(
  rows: SignalLog[],
  bucketFor: (row: SignalLog) => string
): HistoryPerfRow[] {
  const grouped = new Map<string, SignalLog[]>();
  for (const row of rows) {
    const bucket = bucketFor(row);
    grouped.set(bucket, [...(grouped.get(bucket) ?? []), row]);
  }

  return Array.from(grouped.entries()).map(([label, group]) => {
    const resolved = group.filter((row) => row.outcome !== "active");
    const wins = resolved.filter((row) => row.outcome === "tp1" || row.outcome === "tp2" || row.outcome === "tp3").length;
    const losses = resolved.filter((row) => row.outcome === "sl").length;
    const mfeVals = resolved
      .filter((row) => row.max_favorable !== null && row.entry_price)
      .map((row) => Math.abs(row.max_favorable!) / row.entry_price * 100);
    const maeVals = resolved
      .filter((row) => row.max_adverse !== null && row.entry_price)
      .map((row) => Math.abs(row.max_adverse!) / row.entry_price * 100);
    return {
      label,
      total: group.length,
      resolved: resolved.length,
      wins,
      losses,
      winRate: resolved.length ? Math.round(wins / resolved.length * 100) : 0,
      avgMfe: mfeVals.length ? mfeVals.reduce((a, b) => a + b, 0) / mfeVals.length : null,
      avgMae: maeVals.length ? maeVals.reduce((a, b) => a + b, 0) / maeVals.length : null,
    };
  }).sort((a, b) => b.total - a.total);
}

function HistoryBreakdown({ title, rows }: { title: string; rows: HistoryPerfRow[] }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/30 overflow-hidden">
      <div className="px-3 py-2 text-xs uppercase tracking-wide text-neutral-500 border-b border-neutral-800">{title}</div>
      <table className="w-full text-xs">
        <thead className="text-neutral-500 text-left">
          <tr>
            <th className="px-3 py-2 font-normal">Bucket</th>
            <th className="px-2 py-2 font-normal text-right">N</th>
            <th className="px-2 py-2 font-normal text-right">Win</th>
            <th className="px-2 py-2 font-normal text-right">MFE</th>
            <th className="px-3 py-2 font-normal text-right">MAE</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 5).map((row) => (
            <tr key={row.label} className="border-t border-neutral-800">
              <td className="px-3 py-2 text-neutral-300">{row.label}</td>
              <td className="px-2 py-2 text-right tabular-nums text-neutral-400">{row.total}</td>
              <td className="px-2 py-2 text-right tabular-nums text-emerald-300">{row.resolved ? `${row.winRate}%` : "-"}</td>
              <td className="px-2 py-2 text-right tabular-nums text-emerald-400">{row.avgMfe !== null ? `${row.avgMfe.toFixed(2)}%` : "-"}</td>
              <td className="px-3 py-2 text-right tabular-nums text-red-400">{row.avgMae !== null ? `${row.avgMae.toFixed(2)}%` : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatPill({ label, value, color = "text-neutral-200", active = false, onClick }: { label: string; value: string; color?: string; active?: boolean; onClick?: () => void }) {
  if (onClick) {
    return (
      <button onClick={onClick} className={`px-3 py-1.5 rounded-md border text-left ${active ? "bg-neutral-100 border-neutral-100" : "bg-neutral-900 border-neutral-800"}`}>
        <span className={`text-xs ${active ? "text-neutral-600" : "text-neutral-500"}`}>{label} </span>
        <span className={`font-medium ${active ? "text-neutral-950" : color}`}>{value}</span>
      </button>
    );
  }
  return (
    <div className="px-3 py-1.5 rounded-md bg-neutral-900 border border-neutral-800">
      <span className="text-neutral-500 text-xs">{label} </span>
      <span className={`font-medium ${color}`}>{value}</span>
    </div>
  );
}

function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
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

function SignalTable({ signals, regime, watched, onWatch }: {
  signals: Signal[];
  regime?: MarketRegime;
  watched: Set<string>;
  onWatch: (id: string, holdDays: number) => void;
}) {
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
      <table className="w-full text-sm min-w-[1360px]">
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
            <th className="px-3 py-2 font-normal text-right" title="Close price of the trigger candle; used as planned entry">Entry</th>
            <th className="px-3 py-2 font-normal text-right" title="Current mark price">Now</th>
            {th("State", "Entry viability from current mark price versus entry, SL, and TP1.")}
            <th className="px-3 py-2 font-normal text-right" title="ATR targets: SL (1×) · TP1 (1.5×) · TP2 (3×) · TP3 cyan (5× swing)">Targets</th>
            <th className="px-3 py-2 font-normal text-right" title="How long ago the trigger bar closed">Age</th>
            {th("Time")}
            <th className="px-3 py-2 font-normal"></th>
          </tr>
        </thead>
        <tbody>
          {signals.map((s, i) => {
            const viability = entryViability(s);
            return (
              <tr
                key={`${s.symbol}-${s.timeframe}-${s.barTime}-${i}`}
                className={`border-t border-neutral-800 hover:bg-neutral-900/40 ${s.fromWatchlist ? "bg-amber-950/10" : ""}`}
              >
              <td className="px-3 py-2">
                <ScoreBadge score={confluenceScore(s)} />
              </td>
              <td className="px-3 py-2">
                <span className="font-medium">{s.symbol}</span>
                {s.fromWatchlist && (
                  <span className="ml-1.5 text-xs text-amber-400/70" title="This setup was on Radar before firing">★</span>
                )}
              </td>
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
              <td className="px-3 py-2 text-right tabular-nums text-neutral-400">
                {s.currentPrice !== undefined ? formatPrice(s.currentPrice) : "—"}
              </td>
              <td className="px-3 py-2">
                <EntryViabilityBadge viability={viability} />
              </td>
              <td className="px-3 py-2 text-right">
                <TargetsCell signal={s} />
              </td>
              <td className="px-3 py-2 text-right">
                <AgeBadge barTime={s.barTime} />
              </td>
              <td className="px-3 py-2 text-xs text-neutral-500 tabular-nums">
                {new Date(s.barTime).toISOString().slice(5, 16).replace("T", " ")}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                <a href={tradingViewUrl(s)} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300" title="Open on TradingView">
                  TV →
                </a>
                <a href={binanceFuturesUrl(s.symbol)} target="_blank" rel="noopener noreferrer"
                  className="ml-2 text-xs text-amber-400 hover:text-amber-300" title="Open Binance Futures chart">
                  BN
                </a>
                <WatchButton
                  id={`${s.symbol}-${s.timeframe}-${s.barTime}`}
                  isWatched={watched.has(`${s.symbol}-${s.timeframe}-${s.barTime}`)}
                  onWatch={onWatch}
                />
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function tradingViewUrl(s: Signal): string {
  return tradingViewSymbolUrl(s.symbol, s.timeframe);
}

function tradingViewSymbolUrl(symbol: string, timeframe: Timeframe): string {
  const interval =
    timeframe === "1h" ? "60" : timeframe === "4h" ? "240" : timeframe.replace("m", "");
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}.P&interval=${interval}`;
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

function entryViability(signal: Signal): EntryViability {
  const entry = signal.barClose;
  const current = signal.currentPrice;
  if (!current || !Number.isFinite(current) || entry <= 0) {
    return { status: "unknown", label: "no mark", detail: "Current mark price unavailable" };
  }

  const isLong = signal.side === "long";
  if (signal.sl !== undefined && (isLong ? current <= signal.sl : current >= signal.sl)) {
    return { status: "invalid", label: "SL crossed", detail: "Current mark price has crossed the planned stop" };
  }
  if (signal.tp1 !== undefined && (isLong ? current >= signal.tp1 : current <= signal.tp1)) {
    return { status: "late", label: "TP1 hit", detail: "Fresh entry is late because TP1 has already been reached" };
  }

  const atr =
    signal.atr1h ??
    (signal.sl !== undefined ? Math.abs(entry - signal.sl) : undefined) ??
    (signal.tp1 !== undefined ? Math.abs(signal.tp1 - entry) / 1.5 : undefined);
  const favorableMove = isLong ? current - entry : entry - current;
  const adverseMove = -favorableMove;
  const distancePct = Math.abs(current - entry) / entry * 100;

  if (atr && atr > 0) {
    const favorableAtr = favorableMove / atr;
    const adverseAtr = adverseMove / atr;
    if (favorableAtr > 0.5) {
      return {
        status: "late",
        label: "chasing",
        detail: `Moved ${favorableAtr.toFixed(2)} ATR toward target`,
      };
    }
    if (adverseAtr > 0.75) {
      return {
        status: "invalid",
        label: "near SL",
        detail: `Moved ${adverseAtr.toFixed(2)} ATR against entry`,
      };
    }
    return {
      status: "viable",
      label: favorableMove < 0 ? "better px" : "viable",
      detail: `${distancePct.toFixed(2)}% from planned entry`,
    };
  }

  if (distancePct <= 0.75) {
    return { status: "viable", label: "viable", detail: `${distancePct.toFixed(2)}% from planned entry` };
  }
  return {
    status: favorableMove > 0 ? "late" : "invalid",
    label: favorableMove > 0 ? "chasing" : "drifted",
    detail: `${distancePct.toFixed(2)}% from planned entry`,
  };
}

function isEntryViable(signal: Signal): boolean {
  const s = entryViability(signal).status;
  // "unknown" = no mark price → can't judge, show it anyway
  return s === "viable" || s === "unknown";
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

function EntryViabilityBadge({ viability }: { viability: EntryViability }) {
  const styles =
    viability.status === "viable"  ? "bg-emerald-950/70 text-emerald-300 border-emerald-800/70" :
    viability.status === "late"    ? "bg-amber-950/70 text-amber-300 border-amber-800/70" :
    viability.status === "invalid" ? "bg-red-950/70 text-red-300 border-red-800/70" :
                                      "bg-neutral-900 text-neutral-500 border-neutral-700";
  return (
    <span className={`inline-flex px-1.5 py-0.5 text-xs rounded border whitespace-nowrap ${styles}`} title={viability.detail}>
      {viability.label}
    </span>
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
      {s.tp3 !== undefined && (
        <>
          <span className="text-neutral-600">·</span>
          <span
            className={isLong ? "text-cyan-400" : "text-violet-400"}
            title={`TP3: ${formatPrice(s.tp3)} (5× ATR — swing target)`}
          >
            {formatPrice(s.tp3)}
          </span>
        </>
      )}
    </span>
  );
}

// Age of signal — shows how long ago the trigger bar was, color-coded by freshness.
function AgeBadge({ barTime }: { barTime: number }) {
  const ageMs = Date.now() - barTime;
  const mins  = Math.floor(ageMs / 60_000);
  const label = mins < 1 ? "< 1m" : `${mins}m`;
  // fresh → green, aging → amber, near-expiry → red (live window is ~30m)
  const cls =
    mins < 10 ? "text-emerald-400" :
    mins < 22 ? "text-amber-400"   : "text-red-400";
  return (
    <span className={`text-xs tabular-nums ${cls}`} title={`Signal triggered ${label} ago`}>
      {label} ago
    </span>
  );
}

// Watch button — inline hold-period selector that appears on first click.
function WatchButton({ id, isWatched, onWatch }: {
  id: string;
  isWatched: boolean;
  onWatch: (id: string, holdDays: number) => void;
}) {
  const [picking, setPicking] = useState(false);
  if (isWatched) {
    return <span className="ml-2 text-xs text-amber-300" title="Signal added to Tracked">★</span>;
  }
  if (picking) {
    return (
      <span className="ml-2 inline-flex gap-1 text-xs">
        {([1, 3, 5] as const).map((d) => (
          <button
            key={d}
            onClick={() => { onWatch(id, d); setPicking(false); }}
            className="px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-300 border border-amber-800/60 hover:bg-amber-800/60"
          >
            {d}d
          </button>
        ))}
        <button onClick={() => setPicking(false)} className="px-1 py-0.5 text-neutral-500 hover:text-neutral-300">✕</button>
      </span>
    );
  }
  return (
    <button
      onClick={() => setPicking(true)}
      className="ml-2 text-xs text-neutral-600 hover:text-amber-300 transition-colors"
      title="Add to Tracked"
    >
      ☆
    </button>
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

// ─── Guide Modal ──────────────────────────────────────────────────────────────

function GuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 overflow-y-auto" onClick={onClose}>
      <div
        className="relative mt-8 mb-8 w-full max-w-3xl rounded-lg border border-neutral-700 bg-neutral-900 text-sm text-neutral-300 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
          <h2 className="text-base font-medium text-neutral-100">How to use this screener</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200 text-lg leading-none">✕</button>
        </div>

        <div className="px-5 py-5 space-y-6">

          {/* Flow overview */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500 mb-3">Signal flow</h3>
            <div className="grid gap-3 sm:grid-cols-4">
              {(["Radar", "Entry", "Tracked", "History"] as const).map((tab, i) => (
                <div key={tab} className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-neutral-600">{i + 1}</span>
                    <span className="font-medium text-neutral-200">{tab}</span>
                    {i < 3 && <span className="text-neutral-700 text-xs">→</span>}
                  </div>
                  <p className="text-xs text-neutral-500">
                    {tab === "Radar" && "Pre-entry candidates near Market Profile levels. They show a provisional ATR trade plan before a z-score entry fires."}
                    {tab === "Entry" && "Signals that already fired and are still viable at current mark price. Toggle to audit late/invalid active signals."}
                    {tab === "Tracked" && "All active signals are monitored here automatically. Starred signals remain visible as manual bookmarks."}
                    {tab === "History" && "Resolved signals only: TP1/TP2/TP3, SL, or expiry. Win-rate stats do not include active trades."}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Lifecycle states */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500 mb-3">Trade lifecycle (Tracked)</h3>
            <div className="space-y-2">
              {[
                { badge: "Waiting", cls: "bg-neutral-900 text-neutral-400 border-neutral-700", desc: "Signal is active, price hasn't reached any TP yet." },
                { badge: "TP1 ✓ Running →TP2", cls: "bg-emerald-900 text-emerald-300 border-emerald-700", desc: "TP1 hit. SL assumed moved to break-even. Still tracking toward TP2." },
                { badge: "TP2 ✓ Running →TP3", cls: "bg-emerald-600 text-white border-emerald-500", desc: "TP2 hit. Partial profit locked. Tracking TP3 swing target (5× ATR)." },
                { badge: "TP3 ✓", cls: "bg-emerald-400 text-neutral-900 border-emerald-300", desc: "Full swing target hit. Trade done." },
                { badge: "SL ✗", cls: "bg-red-950 text-red-400 border-red-800", desc: "Stopped out. If SL hit after TP1 was already hit, outcome is TP1 (break-even)." },
              ].map((row) => (
                <div key={row.badge} className="flex items-center gap-3">
                  <span className={`shrink-0 inline-flex px-1.5 py-0.5 text-xs rounded border ${row.cls}`}>{row.badge}</span>
                  <span className="text-xs text-neutral-500">{row.desc}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Entry viability */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500 mb-3">Entry viability</h3>
            <div className="space-y-2 text-xs text-neutral-500">
              <p>Entry defaults to setups that are still actionable at the current Binance mark price. Use Entry: All to audit signals that are active but no longer good fresh entries.</p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                <div><span className="text-emerald-300 w-20 inline-block">viable</span><span>close enough to planned entry</span></div>
                <div><span className="text-emerald-300 w-20 inline-block">better px</span><span>pulled back beyond planned entry, not near SL</span></div>
                <div><span className="text-amber-300 w-20 inline-block">chasing</span><span>moved more than 0.5 ATR toward target</span></div>
                <div><span className="text-amber-300 w-20 inline-block">TP1 hit</span><span>fresh entry is late; monitor in Tracked</span></div>
                <div><span className="text-red-300 w-20 inline-block">near SL</span><span>moved more than 0.75 ATR against entry</span></div>
                <div><span className="text-red-300 w-20 inline-block">SL crossed</span><span>planned stop already crossed</span></div>
              </div>
            </div>
          </section>

          {/* Targets */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500 mb-3">ATR-based targets (1H, 14-period)</h3>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <div><span className="text-neutral-400 w-10 inline-block">SL</span><span className="text-neutral-500">entry ∓ 1× ATR — stop loss</span></div>
              <div><span className="text-neutral-400 w-10 inline-block">TP1</span><span className="text-neutral-500">entry ± 1.5× ATR — quick target</span></div>
              <div><span className="text-neutral-400 w-10 inline-block">TP2</span><span className="text-neutral-500">entry ± 3× ATR — mid target</span></div>
              <div><span className="text-cyan-600 w-10 inline-block">TP3</span><span className="text-neutral-500">entry ± 5× ATR — swing target (3-5d)</span></div>
            </div>
          </section>

          {/* Regime */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500 mb-3">Market regime (BTC 4H)</h3>
            <div className="space-y-1 text-xs">
              <div><span className="text-red-400 w-20 inline-block">FLUSH</span><span className="text-neutral-500">BTC dumped ≥2% from 12h high → look for long bounces at MP support. Filters auto-switch to Long / Bounce / Score≥2.</span></div>
              <div><span className="text-emerald-400 w-20 inline-block">BREAKOUT</span><span className="text-neutral-500">BTC pumped ≥2% open→close → look for continuation longs. Filters auto-switch to Long / Continuation.</span></div>
              <div><span className="text-neutral-400 w-20 inline-block">NEUTRAL</span><span className="text-neutral-500">No strong directional bias. All signal types visible.</span></div>
            </div>
          </section>

          {/* Confluence score */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500 mb-3">Confluence / Squeeze score (0–6)</h3>
            <p className="text-xs text-neutral-500 mb-2">Higher = more factors aligning for a squeeze/bounce. Each factor contributes 0–2 points:</p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-xs text-neutral-500">
              <div>L/S positioning (crowded shorts = +2)</div>
              <div>Funding rate magnitude (high FR = +2)</div>
              <div>OI rising (new money entering = +1)</div>
              <div>Relative strength vs BTC (+1)</div>
            </div>
          </section>

          {/* Z badge */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500 mb-3">Volume Z-score</h3>
            <div className="flex gap-4 text-xs">
              <div><span className="inline-block px-1.5 py-0.5 rounded border bg-neutral-900 text-neutral-400 border-neutral-800 mr-1.5">— 2.0</span>Normal spike</div>
              <div><span className="inline-block px-1.5 py-0.5 rounded border bg-blue-950 text-blue-300 border-blue-900 mr-1.5">LG 3.5</span>Large spike</div>
              <div><span className="inline-block px-1.5 py-0.5 rounded border bg-emerald-950 text-emerald-300 border-emerald-900 mr-1.5">EX 5.2</span>Extreme spike — highest conviction</div>
            </div>
          </section>

          <p className="text-xs text-neutral-600 border-t border-neutral-800 pt-4">
            Scans run every 15 minutes via Vercel cron. Entry only shows recent viable signals by default; Tracked monitors all active signals until TP/SL/expiry. Data is Binance USDT-M futures only.
          </p>
        </div>
      </div>
    </div>
  );
}
