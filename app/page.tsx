"use client";

import { useEffect, useMemo, useState } from "react";
import type { MarketRegime, ScanResult, Signal, SignalType, Timeframe } from "@/lib/types";
import type { HistoryResult, SignalLog, RadarLog, Outcome, SignalTraceSnapshot } from "@/lib/db";

type ApiResponse = (ScanResult & { stale: boolean; ageMs: number }) | {
  scannedAt: null;
  signals: [];
  stale: true;
  message: string;
};

type HistoryFilter = Outcome | "all" | "running";
type HistoryConfidenceFilter = "all" | "high" | "medium" | "low";
type MainTab = "board" | "history";
type BoardSideFilter = "all" | "long" | "short";
type EntryViabilityStatus = "viable" | "late" | "invalid" | "unknown";

interface EntryViability {
  status: EntryViabilityStatus;
  label: string;
  detail: string;
}


type BoardRadar = RadarLog & { current_price: number | null };
type BoardTrade = SignalLog & { current_price: number | null; trace?: SignalTraceSnapshot[] };
interface BoardData { radar: BoardRadar[]; tracked: BoardTrade[]; resolved: BoardTrade[] }

export default function DashboardPage() {
  const [tab, setTab] = useState<MainTab>("board");

  // ── Scan meta (for the regime banner + freshness line) ───────────────────────
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // ── History tab state ───────────────────────────────────────────────────────
  const [history, setHistory] = useState<HistoryResult | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [histErr, setHistErr] = useState<string | null>(null);

  // ── Lifecycle board state ─────────────────────────────────────────────────────
  const [board, setBoard] = useState<BoardData | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardErr, setBoardErr] = useState<string | null>(null);

  // Board side filter (auto-nudged by regime).
  const [sideFilter, setSideFilter] = useState<BoardSideFilter>("all");

  // Paper-traded signal ids: tracked per-session so the button updates immediately.
  const [papered, setPapered] = useState<Set<string>>(new Set());

  async function logPaperTrade(id: string, entryPrice: number) {
    setPapered((prev) => new Set(prev).add(id));
    await fetch("/api/paper-trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, entryPrice }),
    }).catch(() => {});
    loadBoard();
  }

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

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/signals", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as ApiResponse);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadBoard() {
    setBoardLoading(true);
    setBoardErr(null);
    try {
      const res = await fetch("/api/board", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setBoard((await res.json()) as BoardData);
    } catch (e) {
      setBoardErr((e as Error).message);
    } finally {
      setBoardLoading(false);
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

  // On mount: load scan meta + board, then auto-refresh both every 60s.
  useEffect(() => {
    refresh();
    loadBoard();
    const id = setInterval(() => { refresh(); loadBoard(); }, 60_000);
    return () => clearInterval(id);
  }, []);

  // Lazy-load history the first time the user opens that tab.
  useEffect(() => {
    if (tab === "history" && !history && !histLoading) loadHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Regime nudges the side filter to match the playbook (user can override).
  const regime = data && "regime" in data ? (data.regime as MarketRegime | undefined) : undefined;
  useEffect(() => {
    if (!regime) return;
    if (regime === "flush" || regime === "breakout") setSideFilter("long");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regime]);

  // ── Guide modal ─────────────────────────────────────────────────────────────
  const [showGuide, setShowGuide] = useState(false);

  const tabBtn = (id: MainTab, label: string, first = false) => (
    <button
      onClick={() => setTab(id)}
      className={`px-3 py-1.5 transition-colors ${first ? "" : "border-l border-neutral-700"} ${tab === id ? "bg-neutral-100 text-neutral-900" : "text-neutral-400 hover:text-neutral-200"}`}
    >
      {label}
    </button>
  );

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 px-3 py-4 sm:px-6 sm:py-6">
      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}
      <header className="mb-5 flex items-center justify-between gap-2 flex-wrap">
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
            {tabBtn("board", "Board", true)}
            {tabBtn("history", "History")}
          </div>
          <button
            onClick={() => { if (tab === "history") loadHistory(); else { refresh(); loadBoard(); } }}
            className="px-3 py-1.5 text-sm rounded-md border border-neutral-700 hover:border-neutral-500 transition-colors"
          >
            {(tab === "history" ? histLoading : boardLoading || loading) ? "Loading…" : "Refresh"}
          </button>
          {tab === "history" && history && history.signals.length > 0 && (
            <button
              onClick={() => downloadHistoryCsv(history.signals)}
              className="px-3 py-1.5 text-sm rounded-md border border-neutral-700 hover:border-neutral-500 transition-colors"
              title="Download all history rows as CSV (raw, ignores confidence filter)"
            >
              Download CSV
            </button>
          )}
        </div>
      </header>

      {tab === "history" && (
        <HistoryTab history={history} loading={histLoading} err={histErr} />
      )}

      {tab === "board" && (
        <>
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
                Last scan: {formatWibFull(data.scannedAt)} · {data.symbolsScanned} symbols
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

          {(err || boardErr) && (
            <div className="mb-4 px-3 py-2 rounded-md text-sm bg-red-950/40 border border-red-900/60 text-red-200">
              Error: {err ?? boardErr}
            </div>
          )}

          <LifecycleBoard
            board={board}
            loading={boardLoading}
            sideFilter={sideFilter}
            setSideFilter={setSideFilter}
            watched={watched}
            onWatch={watchSignal}
            papered={papered}
            onPaperTrade={logPaperTrade}
          />
        </>
      )}
    </main>
  );
}

// ─── Lifecycle Board ──────────────────────────────────────────────────────────
// One continuous view of every setup's journey: RADAR → FIRED → RUNNING →
// RESOLVED. Stacked sections on mobile, four columns on wide screens.

type BoardStage = "radar" | "fired" | "running" | "resolved";

function LifecycleBoard({
  board, loading, sideFilter, setSideFilter, watched, onWatch, papered, onPaperTrade,
}: {
  board: BoardData | null;
  loading: boolean;
  sideFilter: BoardSideFilter;
  setSideFilter: (s: BoardSideFilter) => void;
  watched: Set<string>;
  onWatch: (id: string, holdDays: number) => void;
  papered: Set<string>;
  onPaperTrade: (id: string, entryPrice: number) => void;
}) {
  const sideOk = (s: "long" | "short") => sideFilter === "all" || s === sideFilter;
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  const radar = (board?.radar ?? []).filter((r) => sideOk(r.side));
  const tracked = (board?.tracked ?? []).filter((t) => sideOk(t.side));
  const resolvedAll = (board?.resolved ?? []).filter((t) => sideOk(t.side));

  // Fired = active, no TP yet. Running = active, already hit ≥ TP1.
  const fired = tracked.filter((t) => t.outcome === "active" && t.best_tp == null);
  const running = tracked.filter((t) => t.outcome === "active" && t.best_tp != null);
  // A tracked row can also be resolved-but-starred/paper; fold those into resolved.
  const resolvedFromTracked = tracked.filter((t) => t.outcome !== "active");
  const resolvedIds = new Set(resolvedFromTracked.map((r) => r.id));
  const resolved = [...resolvedFromTracked, ...resolvedAll.filter((r) => !resolvedIds.has(r.id))];
  const traceable = [...running, ...fired, ...tracked.filter((t) => t.outcome !== "active")];
  // A starred ticker is the one the user picked to follow — it drives the trace panel
  // by default, ahead of whatever happens to be the newest runner.
  const isStarred = (t: BoardTrade) => t.watched || watched.has(t.id);
  const selectedTrace =
    traceable.find((t) => t.id === selectedTraceId) ??
    traceable.find(isStarred) ??
    running[0] ??
    fired[0] ??
    traceable[0] ??
    null;

  // Tickers offered in the trace switcher: every starred one, plus the current
  // selection if it was manually picked (via "trace") and isn't starred.
  const starredTraceable = traceable.filter(isStarred);
  const traceChoices = selectedTrace && !starredTraceable.some((t) => t.id === selectedTrace.id)
    ? [selectedTrace, ...starredTraceable]
    : starredTraceable;

  // Fired sorted: near-entry (most actionable) first.
  const firedSorted = [...fired].sort((a, b) => entryDistancePct(a) - entryDistancePct(b));

  useEffect(() => {
    if (!board) return;
    if (traceable.length === 0) {
      if (selectedTraceId !== null) setSelectedTraceId(null);
      return;
    }
    if (!selectedTraceId || !traceable.some((t) => t.id === selectedTraceId)) {
      const preferred = traceable.find(isStarred) ?? traceable[0];
      setSelectedTraceId(preferred.id);
    }
  }, [board, selectedTraceId, traceable, watched]);

  if (loading && !board) {
    return <div className="text-neutral-500 text-sm py-12 text-center">Loading board…</div>;
  }

  return (
    <div>
      <section className="mb-4 flex flex-wrap gap-2 items-center">
        <FilterGroup label="Side">
          {(["all", "long", "short"] as const).map((s) => (
            <Chip key={s} active={sideFilter === s} onClick={() => setSideFilter(s)}>{s}</Chip>
          ))}
        </FilterGroup>
        <span className="ml-auto text-xs text-neutral-600">
          radar→fired→running→trace · resolved lives in History · auto-refresh 60s
        </span>
      </section>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4 items-start">
        <BoardColumn stage="radar" title="Radar" count={radar.length} accent="text-amber-300"
          hint="Pre-signal candidates near MP levels. Not fired yet." defaultCollapsed={true}>
          {radar.length === 0
            ? <BoardEmpty text="No live radar candidates." />
            : radar.map((r) => <RadarCard key={r.id} row={r} />)}
        </BoardColumn>

        <BoardColumn stage="fired" title="Fired" count={firedSorted.length} accent="text-blue-300"
          hint="Z-score fired. Active, no TP hit yet — judge the entry here.">
          {firedSorted.length === 0
            ? <BoardEmpty text="Nothing freshly fired." />
            : firedSorted.map((t) => (
                <TradeCard key={t.id} row={t} stage="fired"
                  onSelectTrace={setSelectedTraceId}
                  watched={watched} onWatch={onWatch} papered={papered} onPaperTrade={onPaperTrade} />
              ))}
        </BoardColumn>

        <BoardColumn stage="running" title="Running" count={running.length} accent="text-emerald-300"
          hint="Already hit ≥ TP1. SL trails behind; let it run.">
          {running.length === 0
            ? <BoardEmpty text="No runners right now." />
            : running.map((t) => (
                <TradeCard key={t.id} row={t} stage="running"
                  onSelectTrace={setSelectedTraceId}
                  watched={watched} onWatch={onWatch} papered={papered} onPaperTrade={onPaperTrade} />
              ))}
        </BoardColumn>

        <BoardColumn stage="resolved" title="Trace" count={traceable.length} accent="text-cyan-300"
          hint="Selected ticker progress from entry across cron cycles. Resolved rows are in History.">
          <TraceSelector items={traceChoices} selectedId={selectedTrace?.id ?? null} starredIds={watched} onSelect={setSelectedTraceId} />
          <SignalTracePanel row={selectedTrace} resolvedCount={resolved.length} />
        </BoardColumn>
      </div>
    </div>
  );
}

function currentMovePct(row: Pick<SignalLog, "side" | "entry_price">, currentPrice?: number | null): number | null {
  if (currentPrice == null || row.entry_price <= 0) return null;
  const raw = (currentPrice - row.entry_price) / row.entry_price * 100;
  return row.side === "long" ? raw : -raw;
}

function formatSignedPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

// Tap-to-switch chips so multiple starred tickers are all reachable in the trace panel.
function TraceSelector({ items, selectedId, starredIds, onSelect }: {
  items: BoardTrade[]; selectedId: string | null; starredIds: Set<string>; onSelect: (id: string) => void;
}) {
  if (items.length < 2) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {items.map((t) => {
        const active = t.id === selectedId;
        const isStarred = t.watched || starredIds.has(t.id);
        const pct = currentMovePct(t, t.current_price) ?? t.trace?.[t.trace.length - 1]?.move_pct ?? null;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            title={`Trace ${t.symbol}`}
            className={`px-2 py-1 text-xs rounded-md border flex items-center gap-1 ${
              active
                ? "bg-cyan-500/15 border-cyan-700 text-cyan-200"
                : "bg-neutral-900 border-neutral-800 text-neutral-400 hover:border-neutral-700"
            }`}
          >
            {isStarred && <span className="text-amber-300">★</span>}
            <span className="font-medium">{t.symbol}</span>
            {pct !== null && (
              <span className={pct >= 0 ? "text-emerald-400" : "text-red-400"}>{formatSignedPct(pct)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function SignalTracePanel({ row, resolvedCount }: { row: BoardTrade | null; resolvedCount: number }) {
  if (!row) {
    return <BoardEmpty text={resolvedCount > 0 ? "No live ticker selected. Resolved signals are in History." : "No traceable ticker yet."} />;
  }
  const trace = row.trace ?? [];
  const currentPct = currentMovePct(row, row.current_price);
  const lastTrace = trace[trace.length - 1];
  const best = trace.length ? Math.max(...trace.map((t) => t.move_pct)) : null;
  const worst = trace.length ? Math.min(...trace.map((t) => t.move_pct)) : null;
  const latestPct = currentPct ?? lastTrace?.move_pct ?? null;
  const progressWidth = latestPct === null ? 50 : Math.max(0, Math.min(100, 50 + latestPct * 10));

  return (
    <div className="space-y-3">
      <CardShell className="border-cyan-900/40 bg-cyan-950/10">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] text-neutral-500">selected ticker</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="font-medium text-sm">{row.symbol}</span>
              <SideTag side={row.side} />
              <TradeLifecycleBadge signal={row} currentPrice={row.current_price} />
            </div>
          </div>
          {latestPct !== null && (
            <span className={`text-sm tabular-nums ${latestPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {formatSignedPct(latestPct)}
            </span>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <TraceMetric label="Entry" value={formatPrice(row.entry_price)} />
          <TraceMetric label="Now" value={row.current_price != null ? formatPrice(row.current_price) : "—"} />
          <TraceMetric label="Best" value={best !== null ? formatSignedPct(best) : "—"} tone="good" />
          <TraceMetric label="Worst" value={worst !== null ? formatSignedPct(worst) : "—"} tone="bad" />
        </div>

        <div className="mt-3 h-2 rounded bg-neutral-800 overflow-hidden" title="Center is entry; right is gain, left is loss. Scale is capped for readability.">
          <div className="relative h-full">
            <div className="absolute left-1/2 top-0 h-full w-px bg-neutral-500" />
            <div
              className={`absolute top-0 h-full ${latestPct !== null && latestPct >= 0 ? "bg-emerald-500" : "bg-red-500"}`}
              style={{
                left: latestPct !== null && latestPct >= 0 ? "50%" : `${progressWidth}%`,
                width: latestPct !== null ? `${Math.abs(progressWidth - 50)}%` : "0%",
              }}
            />
          </div>
        </div>
      </CardShell>

      {trace.length === 0 ? (
        <BoardEmpty text="No cron-cycle trace snapshots yet. The next scan will start filling this." />
      ) : trace.slice(-8).map((point) => (
        <CardShell key={`${point.signal_id}-${point.observed_at}`}>
          <div className="flex items-center justify-between">
            <span className="text-neutral-500 tabular-nums">{formatWib(point.observed_at)}</span>
            <span className={`tabular-nums ${point.move_pct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {formatSignedPct(point.move_pct)}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-neutral-600 tabular-nums">{formatPrice(point.price)}</div>
        </CardShell>
      ))}

      {resolvedCount > 0 && <div className="text-[10px] text-neutral-600 text-center">{resolvedCount} resolved row(s) moved to History.</div>}
    </div>
  );
}

function TraceMetric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const cls = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-neutral-300";
  return (
    <div>
      <div className="text-neutral-500">{label}</div>
      <div className={`mt-0.5 tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

// Distance of current price from planned entry, in %. Used to surface the
// most-actionable fired setups (closest to entry) first. Unknown price → far.
function entryDistancePct(row: BoardTrade): number {
  if (row.current_price == null || row.entry_price <= 0) return 1e9;
  return Math.abs(row.current_price - row.entry_price) / row.entry_price * 100;
}

function BoardColumn({ title, count, accent, hint, defaultCollapsed = false, children }: {
  stage: BoardStage; title: string; count: number; accent: string; hint: string;
  defaultCollapsed?: boolean; children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/20">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full px-3 py-2 border-b border-neutral-800 flex items-center justify-between"
        title={hint}
      >
        <span className={`text-sm font-medium ${accent}`}>{title}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-500 tabular-nums">{count}</span>
          <span className="text-xs text-neutral-600">{collapsed ? "▾" : "▴"}</span>
        </div>
      </button>
      {!collapsed && (
        <div className="p-2 space-y-2 max-h-[70vh] overflow-y-auto">
          {children}
        </div>
      )}
    </div>
  );
}

function BoardEmpty({ text }: { text: string }) {
  return <div className="py-6 text-center text-xs text-neutral-600">{text}</div>;
}

// Compact card shell shared by radar + trade cards.
function CardShell({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-md border border-neutral-800 bg-neutral-900/50 px-2.5 py-2 text-xs ${className}`}>
      {children}
    </div>
  );
}

function SideTag({ side }: { side: "long" | "short" }) {
  return <span className={side === "long" ? "text-emerald-400" : "text-pink-400"}>{side}</span>;
}

function RadarCard({ row }: { row: BoardRadar }) {
  const onRadarMs = Date.now() - row.first_seen_at;
  return (
    <CardShell className={row.state === "near_trigger" ? "border-amber-800/50" : ""}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-sm">{row.symbol}</span>
        <ScoreBadge score={row.score} />
      </div>
      <div className="flex items-center gap-2 text-neutral-400 mb-1.5 flex-wrap">
        <SideTag side={row.side} />
        <span className={`px-1 py-0.5 rounded border text-[10px] ${row.state === "near_trigger" ? "bg-amber-950/70 text-amber-300 border-amber-700/60" : "bg-neutral-900 text-neutral-400 border-neutral-700"}`}>
          {row.state === "near_trigger" ? "near" : "watch"}
        </span>
        {row.bias_window && <span className="text-[10px] text-neutral-500">{row.bias_window}</span>}
        <ZBadge level={(row.z_level as 1 | 2 | 3) || 1} z={row.z_score} />
      </div>
      <div className="flex justify-between text-neutral-500">
        <span>{row.trigger_level ?? "—"} {row.trigger_price != null ? formatPrice(row.trigger_price) : ""}</span>
        <span className="text-neutral-400">entry {row.entry_price != null ? formatPrice(row.entry_price) : "—"}</span>
      </div>
      <TargetRow sl={row.sl} tp1={row.tp1} tp2={row.tp2} tp3={row.tp3} side={row.side} />
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-neutral-500">
        <span title={`First seen ${formatWibFull(row.first_seen_at)}`}>📡 on radar {formatDuration(onRadarMs)}</span>
        {row.best_score > row.score && <span>peak +{row.best_score}</span>}
      </div>
    </CardShell>
  );
}

function TradeCard({ row, stage, watched, onWatch, papered, onPaperTrade, onSelectTrace }: {
  row: BoardTrade; stage: BoardStage;
  watched: Set<string>; onWatch: (id: string, holdDays: number) => void;
  papered: Set<string>; onPaperTrade: (id: string, entryPrice: number) => void;
  onSelectTrace?: (id: string) => void;
}) {
  const v = stage === "fired" ? boardViability(row) : null;
  const isResolved = row.outcome !== "active";
  const paperEntry = row.paper_entry;
  const closePx = isResolved ? row.outcome_price : row.current_price;
  const pnlBase = paperEntry ?? row.entry_price;
  const pnlPct = closePx != null && pnlBase > 0
    ? (closePx - pnlBase) / pnlBase * (row.side === "long" ? 1 : -1) * 100
    : null;
  const isPapered = paperEntry != null || papered.has(row.id);

  const ring =
    stage === "running" ? "border-emerald-900/50 bg-emerald-950/10"
    : v?.status === "viable" ? "border-emerald-900/40"
    : v?.status === "invalid" ? "border-red-900/40"
    : "";

  return (
    <CardShell className={ring}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-sm flex items-center gap-1">
          {row.symbol}
          {isPapered && <span className="text-emerald-400" title="Paper-traded">◈</span>}
          {row.watched && <span className="text-amber-300" title="Starred">★</span>}
        </span>
        {stage === "fired"
          ? <ZBadge level={(row.z_level as 1 | 2 | 3) || 1} z={row.z_score} />
          : <TradeLifecycleBadge signal={row} currentPrice={row.current_price} />}
      </div>

      <div className="flex items-center gap-2 text-neutral-400 mb-1.5 flex-wrap">
        <SideTag side={row.side} />
        <SignalTypeBadge type={row.signal_type as SignalType | undefined} />
        {row.squeeze_score != null && <SqueezeBadge score={row.squeeze_score} />}
        {stage === "fired" && <TradeLifecycleBadge signal={row} currentPrice={row.current_price} />}
      </div>

      <div className="flex justify-between text-neutral-500">
        <span>entry <span className="text-neutral-300">{formatPrice(paperEntry ?? row.entry_price)}</span></span>
        {row.current_price != null && !isResolved && (
          <span>now <span className="text-neutral-300">{formatPrice(row.current_price)}</span></span>
        )}
        {pnlPct != null && (
          <span className={pnlPct >= 0 ? "text-emerald-400" : "text-red-400"}>
            {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
          </span>
        )}
      </div>

      {v && (
        <div className="mt-1"><EntryViabilityBadge viability={{ status: v.status, label: v.label, detail: v.detail }} /></div>
      )}

      <TargetRow sl={row.sl} tp1={row.tp1} tp2={row.tp2} tp3={row.tp3} side={row.side} />

      <div className="mt-1.5 flex items-center justify-between text-[10px] text-neutral-500">
        <span>{formatWib(row.bar_time)}</span>
        {row.radar_first_seen != null && (
          <span title={`On radar ${formatDuration(row.bar_time - row.radar_first_seen)} before firing`}>
            📡→fire {formatDuration(row.bar_time - row.radar_first_seen)}
          </span>
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-3">
        <a href={tradingViewSymbolUrl(row.symbol, row.timeframe as Timeframe)} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">TV</a>
        <a href={binanceFuturesUrl(row.symbol)} target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:text-amber-300">BN</a>
        {(stage === "fired" || stage === "running") && !isPapered && (
          <PaperTradeQuickButton row={row} onPaperTrade={onPaperTrade} />
        )}
        {onSelectTrace && (
          <button onClick={() => onSelectTrace(row.id)} className="text-neutral-600 hover:text-cyan-300" title="Trace this ticker">trace</button>
        )}
        {(stage === "fired" || stage === "running") && !row.watched && !watched.has(row.id) && (
          <button onClick={() => { onWatch(row.id, 3); onSelectTrace?.(row.id); }} className="ml-auto text-neutral-600 hover:text-amber-300" title="Star & trace this ticker">☆</button>
        )}
      </div>
    </CardShell>
  );
}

// Inline price-confirm to log a paper trade straight from a board card.
function PaperTradeQuickButton({ row, onPaperTrade }: {
  row: BoardTrade; onPaperTrade: (id: string, entryPrice: number) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [priceStr, setPriceStr] = useState("");
  if (picking) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          type="number" step="any" autoFocus
          value={priceStr}
          onChange={(e) => setPriceStr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { const p = parseFloat(priceStr); if (p > 0) { onPaperTrade(row.id, p); setPicking(false); } }
            if (e.key === "Escape") setPicking(false);
          }}
          className="w-20 px-1 py-0.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-200 text-[11px] tabular-nums"
        />
        <button onClick={() => { const p = parseFloat(priceStr); if (p > 0) { onPaperTrade(row.id, p); setPicking(false); } }} className="text-emerald-400">✓</button>
        <button onClick={() => setPicking(false)} className="text-neutral-500">✕</button>
      </span>
    );
  }
  return (
    <button
      onClick={() => { setPriceStr(String(row.current_price ?? row.entry_price)); setPicking(true); }}
      className="text-neutral-600 hover:text-emerald-400"
      title="Log paper trade at this price"
    >
      ◈ paper
    </button>
  );
}

// Compact SL · TP1 · TP2 · TP3 row for cards.
function TargetRow({ sl, tp1, tp2, tp3, side }: {
  sl: number | null; tp1: number | null; tp2: number | null; tp3: number | null; side: "long" | "short";
}) {
  if (sl == null && tp1 == null) return null;
  const tpCls = side === "long" ? "text-emerald-400" : "text-pink-400";
  return (
    <div className="mt-1 flex gap-1.5 tabular-nums text-[11px] flex-wrap">
      <span className="text-red-400" title="Stop loss">{sl != null ? formatPrice(sl) : "—"}</span>
      <span className="text-neutral-700">·</span>
      <span className={tpCls} title="TP1">{tp1 != null ? formatPrice(tp1) : "—"}</span>
      <span className="text-neutral-700">·</span>
      <span className={tpCls} title="TP2">{tp2 != null ? formatPrice(tp2) : "—"}</span>
      <span className="text-neutral-700">·</span>
      <span className="text-cyan-500" title="TP3 swing">{tp3 != null ? formatPrice(tp3) : "—"}</span>
    </div>
  );
}

// Entry viability for a DB trade row, mirroring entryViability() for live signals
// but using |entry − sl| as the ATR/risk proxy.
function boardViability(row: BoardTrade): { status: EntryViabilityStatus; label: string; detail: string } {
  const entry = row.entry_price;
  const current = row.current_price;
  if (current == null || !Number.isFinite(current) || entry <= 0) {
    return { status: "unknown", label: "no mark", detail: "Mark price unavailable" };
  }
  const isLong = row.side === "long";
  if (row.sl != null && (isLong ? current <= row.sl : current >= row.sl)) {
    return { status: "invalid", label: "SL crossed", detail: "Price has crossed the planned stop" };
  }
  if (row.tp1 != null && (isLong ? current >= row.tp1 : current <= row.tp1)) {
    return { status: "late", label: "TP1 hit", detail: "Fresh entry is late — TP1 already reached" };
  }
  const risk = row.sl != null ? Math.abs(entry - row.sl) : 0;
  const favorable = isLong ? current - entry : entry - current;
  const distancePct = Math.abs(current - entry) / entry * 100;
  if (risk > 0) {
    if (favorable / risk > 0.5) return { status: "late", label: "chasing", detail: `Moved ${(favorable / risk).toFixed(2)}R toward target` };
    if (-favorable / risk > 0.75) return { status: "invalid", label: "near SL", detail: `Moved ${(-favorable / risk).toFixed(2)}R against entry` };
    return { status: "viable", label: favorable < 0 ? "better px" : "viable", detail: `${distancePct.toFixed(2)}% from entry` };
  }
  if (distancePct <= 0.75) return { status: "viable", label: "viable", detail: `${distancePct.toFixed(2)}% from entry` };
  return { status: favorable > 0 ? "late" : "invalid", label: favorable > 0 ? "chasing" : "drifted", detail: `${distancePct.toFixed(2)}% from entry` };
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
  const profileRows = historyPerformanceRows(signals, historyProfileBucket);
  // TP2 magnet source — lets us compare VWAP-anchored vs pure-ATR target performance.
  const tpSourceRows = historyPerformanceRows(signals, historyTpMagnetBucket);

  // New breakdown cards respect the confidence filter so they reflect the filtered subset.
  const confidenceSignals = confidenceFilter === "all"
    ? signals
    : signals.filter((r) => historyConfidenceBucket(r) === confidenceFilter);
  const timeOfDayRows = historyPerformanceRows(confidenceSignals, historyTimeOfDayBucket);
  const sideRows      = historyPerformanceRows(confidenceSignals, (row) => row.side);
  const regimeRows    = historyPerformanceRows(confidenceSignals, (row) => row.regime ?? "unknown");

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
        {(resolved > 0 || stats.running > 0) && (
          <StatPill
            label="Win rate"
            value={stats.running > 0 ? `${stats.provisionalWinRate}% (${stats.winRate}% conf.)` : `${stats.winRate}%`}
            color="text-amber-300"
          />
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

      <div className="mb-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
        <HistoryBreakdown title="Confidence" rows={confidenceRows} />
        <HistoryBreakdown title="SQZ" rows={squeezeRows} />
        <HistoryBreakdown title="Profile" rows={profileRows} />
        <HistoryBreakdown title="TP magnet" rows={tpSourceRows} />
        <HistoryBreakdown title="Time of day" rows={timeOfDayRows} />
        <HistoryBreakdown title="Side" rows={sideRows} />
        <HistoryBreakdown title="Regime" rows={regimeRows} />
      </div>

      <CrossTab signals={confidenceSignals} />

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
                  <th className="px-3 py-2 font-normal">Time (WIB)</th>
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
                        {formatWib(row.bar_time)}
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

function historyTimeOfDayBucket(row: SignalLog): string {
  // Non-overlapping WIB sessions: Asia 06-14, Europe 14-20, NY 20-06.
  const h = wibDate(row.bar_time).getUTCHours();
  if (h >= 6 && h < 14) return "Asia";
  if (h >= 14 && h < 20) return "Europe";
  return "NY";
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

function historyProfileBucket(row: SignalLog): string {
  return row.trigger_level || "unknown";
}

// ─── CSV export ───────────────────────────────────────────────────────────────
function wibTimestamp(ms: number): string {
  const d = wibDate(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function csvField(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Build + download the raw (unfiltered) history as CSV, client-side. Derivations
// reuse the same bucket helpers as the breakdown cards / cross-tab.
function downloadHistoryCsv(signals: SignalLog[]): void {
  const headers = [
    "timestamp_wib", "symbol", "side", "regime", "type", "confidence", "sqz_bucket",
    "profile", "tp_magnet", "entry", "sl", "tp1", "tp2", "tp3", "outcome",
    "duration_minutes", "mfe_pct", "mae_pct", "time_of_day_session",
  ];
  const num2 = (n: number) => Number(n.toFixed(2)); // dot decimal, no thousand separators
  const rows = signals.map((r) => {
    const endMs = r.outcome_at ?? (r.outcome === "active" ? Date.now() : null);
    const durationMin = endMs !== null ? Math.round((endMs - r.bar_time) / 60_000) : null;
    const mfe = r.max_favorable !== null && r.entry_price ? num2(Math.abs(r.max_favorable) / r.entry_price * 100) : null;
    const mae = r.max_adverse !== null && r.entry_price ? num2(Math.abs(r.max_adverse) / r.entry_price * 100) : null;
    return [
      wibTimestamp(r.bar_time),
      r.symbol,
      r.side,
      r.regime ?? "",
      r.signal_type ?? "",
      historyConfidenceBucket(r),
      historySqueezeBucket(r),
      historyProfileBucket(r),
      historyTpMagnetBucket(r),
      r.entry_price,
      r.sl,
      r.tp1,
      r.tp2,
      r.tp3,
      r.outcome,
      durationMin,
      mfe,
      mae,
      historyTimeOfDayBucket(r),
    ].map(csvField).join(",");
  });
  // UTF-8 BOM (﻿) so Excel reads Unicode correctly.
  const csv = "﻿" + [headers.join(","), ...rows].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mpz_screener_history_${wibTimestamp(Date.now()).slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function historyTpMagnetBucket(row: SignalLog): string {
  return row.tp2_source === "vwap_daily" ? "TP2 daily VWAP"
    : row.tp2_source === "vwap_weekly" ? "TP2 weekly VWAP"
    : "TP2 pure ATR";
}

// ─── Cross-tab analysis ───────────────────────────────────────────────────────
// Pivot any two breakdown dimensions against each other. Bucket functions are
// reused from the breakdown cards so a signal lands in the same bucket here.
type CrossTabDimKey = "confidence" | "sqz" | "profile" | "tpMagnet" | "timeOfDay" | "side" | "regime";

interface CrossTabDim {
  label: string;
  bucketFor: (row: SignalLog) => string;
  order: string[]; // preferred bucket ordering; unknown buckets are appended after.
}

// Dropdown order (and labels) per spec.
const CROSS_TAB_DIM_ORDER: CrossTabDimKey[] = ["confidence", "sqz", "profile", "tpMagnet", "timeOfDay", "side", "regime"];

const CROSS_TAB_DIMS: Record<CrossTabDimKey, CrossTabDim> = {
  confidence: { label: "Confidence", bucketFor: historyConfidenceBucket, order: ["high", "medium", "low"] },
  sqz:        { label: "SQZ", bucketFor: historySqueezeBucket, order: ["0", "1-2", "3-4", "5-6"] },
  // Real trigger_level values: POC, VAL, VAH, PREV_POC, PREV_VAL, PREV_VAH.
  profile:    { label: "Profile", bucketFor: historyProfileBucket, order: ["VAH", "VAL", "POC", "PREV_VAH", "PREV_VAL", "PREV_POC"] },
  tpMagnet:   { label: "TP Magnet", bucketFor: historyTpMagnetBucket, order: ["TP2 pure ATR", "TP2 weekly VWAP", "TP2 daily VWAP"] },
  timeOfDay:  { label: "Time of Day", bucketFor: historyTimeOfDayBucket, order: ["Asia", "Europe", "NY"] },
  side:       { label: "Side", bucketFor: (row) => row.side, order: ["long", "short"] },
  // Real regime values: neutral, flush, breakout (no "trend").
  regime:     { label: "Regime", bucketFor: (row) => row.regime ?? "unknown", order: ["neutral", "flush", "breakout"] },
};

// Win = TP1/TP2/TP3, Loss = SL, Expired = timed out. Win rate = wins / (wins+losses+expired),
// matching the breakdown cards & headline. Only "active" (running) trades are excluded.
interface CrossCell {
  wins: number;
  losses: number;
  expired: number;
  mfeSum: number; mfeN: number;
  maeSum: number; maeN: number;
}

function emptyCell(): CrossCell {
  return { wins: 0, losses: 0, expired: 0, mfeSum: 0, mfeN: 0, maeSum: 0, maeN: 0 };
}

function addToCell(cell: CrossCell, row: SignalLog): void {
  if (row.outcome === "active") return; // running trades aren't resolved yet
  if (row.outcome === "sl") cell.losses++;
  else if (row.outcome === "expired") cell.expired++;
  else cell.wins++; // tp1 / tp2 / tp3
  if (row.max_favorable !== null && row.entry_price) { cell.mfeSum += Math.abs(row.max_favorable) / row.entry_price * 100; cell.mfeN++; }
  if (row.max_adverse !== null && row.entry_price)   { cell.maeSum += Math.abs(row.max_adverse)   / row.entry_price * 100; cell.maeN++; }
}

function cellN(c: CrossCell): number { return c.wins + c.losses + c.expired; }
function cellWinRate(c: CrossCell): number | null { const n = cellN(c); return n ? Math.round(c.wins / n * 100) : null; }

function orderedBuckets(rows: SignalLog[], dim: CrossTabDim): string[] {
  const present = new Set<string>();
  for (const r of rows) present.add(dim.bucketFor(r));
  const ordered = dim.order.filter((b) => present.has(b));
  const extras = [...present].filter((b) => !dim.order.includes(b)).sort();
  return [...ordered, ...extras];
}

// Insufficient-sample threshold: below this we hide the win rate to avoid misleading reads.
const CROSS_TAB_MIN_N = 5;

function cellAvgMfe(c: CrossCell): number | null { return c.mfeN ? c.mfeSum / c.mfeN : null; }
function cellAvgMae(c: CrossCell): number | null { return c.maeN ? c.maeSum / c.maeN : null; }

function cellBgStyle(c: CrossCell): React.CSSProperties | undefined {
  const wr = cellWinRate(c);
  if (cellN(c) < CROSS_TAB_MIN_N || wr === null) return undefined;
  if (wr >= 55) return { backgroundColor: "rgba(34, 197, 94, 0.15)" };  // green
  if (wr <= 35) return { backgroundColor: "rgba(239, 68, 68, 0.15)" };  // red
  return undefined;
}

function cellTooltip(c: CrossCell): string | undefined {
  const n = cellN(c);
  if (n === 0) return undefined;
  const wr = cellWinRate(c);
  const mfe = cellAvgMfe(c);
  const mae = cellAvgMae(c);
  return `N=${n} | Win ${wr}% | ${c.wins}W ${c.losses}L ${c.expired}Exp | Avg MFE ${mfe !== null ? mfe.toFixed(2) : "—"}% | Avg MAE ${mae !== null ? mae.toFixed(2) : "—"}%`;
}

function CrossTab({ signals }: { signals: SignalLog[] }) {
  const [rowDim, setRowDim] = useState<CrossTabDimKey>("regime");
  const [colDim, setColDim] = useState<CrossTabDimKey>("side");
  const [selected, setSelected] = useState<{ rb: string; cb: string } | null>(null);

  // Row and column cannot be the same dimension.
  function nextOtherDim(exclude: CrossTabDimKey): CrossTabDimKey {
    return CROSS_TAB_DIM_ORDER.find((d) => d !== exclude) ?? "side";
  }
  function onRowChange(v: CrossTabDimKey) { setSelected(null); setRowDim(v); if (v === colDim) setColDim(nextOtherDim(v)); }
  function onColChange(v: CrossTabDimKey) { setSelected(null); setColDim(v === rowDim ? nextOtherDim(v) : v); }

  const pivot = useMemo(() => {
    const rDim = CROSS_TAB_DIMS[rowDim];
    const cDim = CROSS_TAB_DIMS[colDim];
    const rowBuckets = orderedBuckets(signals, rDim);
    const colBuckets = orderedBuckets(signals, cDim);
    const cells = new Map<string, CrossCell>();
    const rowTotals = new Map<string, CrossCell>();
    const colTotals = new Map<string, CrossCell>();
    const grand = emptyCell();
    for (const rb of rowBuckets) rowTotals.set(rb, emptyCell());
    for (const cb of colBuckets) colTotals.set(cb, emptyCell());
    for (const row of signals) {
      const rb = rDim.bucketFor(row);
      const cb = cDim.bucketFor(row);
      const key = `${rb} ${cb}`;
      let cell = cells.get(key);
      if (!cell) { cell = emptyCell(); cells.set(key, cell); }
      addToCell(cell, row);
      addToCell(rowTotals.get(rb)!, row);
      addToCell(colTotals.get(cb)!, row);
      addToCell(grand, row);
    }
    return { rowBuckets, colBuckets, cells, rowTotals, colTotals, grand };
  }, [signals, rowDim, colDim]);

  // Resolved trades (win/loss/expired, i.e. non-active) behind the clicked cell.
  const selectedTrades = useMemo(() => {
    if (!selected) return [];
    const rDim = CROSS_TAB_DIMS[rowDim];
    const cDim = CROSS_TAB_DIMS[colDim];
    return signals.filter((row) =>
      row.outcome !== "active" &&
      rDim.bucketFor(row) === selected.rb &&
      cDim.bucketFor(row) === selected.cb
    );
  }, [selected, signals, rowDim, colDim]);

  const dimSelect = (value: CrossTabDimKey, onChange: (v: CrossTabDimKey) => void) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as CrossTabDimKey)}
      className="min-h-[44px] rounded-md border border-neutral-700 bg-neutral-900 px-2 text-sm text-neutral-200 hover:border-neutral-500"
    >
      {CROSS_TAB_DIM_ORDER.map((k) => (
        <option key={k} value={k}>{CROSS_TAB_DIMS[k].label}</option>
      ))}
    </select>
  );

  const cellOf = (rb: string, cb: string) => pivot.cells.get(`${rb} ${cb}`) ?? emptyCell();

  const renderCell = (c: CrossCell) => {
    const n = cellN(c);
    const wr = cellWinRate(c);
    if (n < CROSS_TAB_MIN_N || wr === null) return <span className="text-neutral-600">—</span>;
    return (
      <div className="leading-tight">
        <div className="text-neutral-400 text-xs">N={n}</div>
        <div className="tabular-nums text-neutral-200">{wr}%</div>
      </div>
    );
  };

  const hasData = pivot.rowBuckets.length > 0 && pivot.colBuckets.length > 0 && cellN(pivot.grand) > 0;

  return (
    <div className="mb-4 rounded-md border border-neutral-800 bg-neutral-900/30 overflow-hidden">
      <div className="px-3 py-2 text-xs uppercase tracking-wide text-neutral-500 border-b border-neutral-800">
        Cross-tab analysis
      </div>
      <div className="flex flex-wrap items-center gap-3 px-3 py-3">
        <label className="flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
          Row dimension {dimSelect(rowDim, onRowChange)}
        </label>
        <label className="flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
          Column dimension {dimSelect(colDim, onColChange)}
        </label>
      </div>
      {!hasData ? (
        <div className="px-3 pb-6 pt-2 text-center text-neutral-500 text-sm">
          No data available for selected dimensions
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-sm">
            <thead className="text-neutral-500 text-left">
              <tr className="border-t border-neutral-800">
                <th className="px-3 py-2 font-normal sticky left-0 bg-neutral-900/60">
                  {CROSS_TAB_DIMS[rowDim].label} \ {CROSS_TAB_DIMS[colDim].label}
                </th>
                {pivot.colBuckets.map((cb) => (
                  <th key={cb} className="px-3 py-2 font-normal text-center whitespace-nowrap">{cb}</th>
                ))}
                <th className="px-3 py-2 font-medium text-center text-neutral-300 whitespace-nowrap">Total</th>
              </tr>
            </thead>
            <tbody>
              {pivot.rowBuckets.map((rb) => (
                <tr key={rb} className="border-t border-neutral-800">
                  <td className="px-3 py-2 text-neutral-300 whitespace-nowrap sticky left-0 bg-neutral-900/60">{rb}</td>
                  {pivot.colBuckets.map((cb) => {
                    const c = cellOf(rb, cb);
                    const clickable = cellN(c) > 0;
                    return (
                      <td
                        key={cb}
                        className={`px-3 py-2 text-center ${clickable ? "cursor-pointer hover:brightness-125" : ""}`}
                        style={cellBgStyle(c)}
                        title={cellTooltip(c)}
                        onClick={clickable ? () => setSelected({ rb, cb }) : undefined}
                      >
                        {renderCell(c)}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center bg-neutral-900/40" style={cellBgStyle(pivot.rowTotals.get(rb)!)} title={cellTooltip(pivot.rowTotals.get(rb)!)}>
                    {renderCell(pivot.rowTotals.get(rb)!)}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-neutral-700 bg-neutral-900/40">
                <td className="px-3 py-2 font-medium text-neutral-300 sticky left-0 bg-neutral-900/60">Total</td>
                {pivot.colBuckets.map((cb) => (
                  <td key={cb} className="px-3 py-2 text-center" style={cellBgStyle(pivot.colTotals.get(cb)!)} title={cellTooltip(pivot.colTotals.get(cb)!)}>
                    {renderCell(pivot.colTotals.get(cb)!)}
                  </td>
                ))}
                <td className="px-3 py-2 text-center font-medium" style={cellBgStyle(pivot.grand)} title={cellTooltip(pivot.grand)}>
                  {renderCell(pivot.grand)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <CrossTabCellModal
          title={`${CROSS_TAB_DIMS[rowDim].label}: ${selected.rb} × ${CROSS_TAB_DIMS[colDim].label}: ${selected.cb}`}
          trades={selectedTrades}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function CrossTabCellModal({ title, trades, onClose }: { title: string; trades: SignalLog[]; onClose: () => void }) {
  const wins = trades.filter((t) => t.outcome === "tp1" || t.outcome === "tp2" || t.outcome === "tp3").length;
  const losses = trades.filter((t) => t.outcome === "sl").length;
  const expired = trades.filter((t) => t.outcome === "expired").length;
  const n = wins + losses + expired;
  const wr = n ? Math.round(wins / n * 100) : null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-4 py-3">
          <div>
            <div className="text-sm font-medium text-neutral-200">{title}</div>
            <div className="text-xs text-neutral-500">N={n} · Win {wr !== null ? `${wr}%` : "—"} · {wins}W / {losses}L / {expired}Exp</div>
          </div>
          <button onClick={onClose} className="px-2 py-1 text-sm rounded-md border border-neutral-700 hover:border-neutral-500 text-neutral-400 hover:text-neutral-200">✕</button>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-neutral-900 text-neutral-500 text-left sticky top-0">
              <tr>
                <th className="px-3 py-2 font-normal">Time (WIB)</th>
                <th className="px-3 py-2 font-normal">Symbol</th>
                <th className="px-3 py-2 font-normal">Side</th>
                <th className="px-3 py-2 font-normal">Outcome</th>
                <th className="px-3 py-2 font-normal text-right">MFE</th>
                <th className="px-3 py-2 font-normal text-right">MAE</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((row) => {
                const mfe = row.max_favorable && row.entry_price ? Math.abs(row.max_favorable) / row.entry_price * 100 : null;
                const mae = row.max_adverse && row.entry_price ? Math.abs(row.max_adverse) / row.entry_price * 100 : null;
                return (
                  <tr key={row.id} className="border-t border-neutral-800">
                    <td className="px-3 py-2 text-neutral-500 tabular-nums whitespace-nowrap">{formatWib(row.bar_time)}</td>
                    <td className="px-3 py-2 font-medium">{row.symbol}</td>
                    <td className={`px-3 py-2 ${row.side === "long" ? "text-emerald-400" : "text-pink-400"}`}>{row.side}</td>
                    <td className="px-3 py-2"><OutcomeBadge outcome={row.outcome} /></td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-400">{mfe !== null ? `+${mfe.toFixed(2)}%` : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-400">{mae !== null ? `−${mae.toFixed(2)}%` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
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

// Intl.DateTimeFormat with named timezone is unreliable in some runtimes.
// Manual UTC+7 offset is simpler and always correct.
function wibDate(ms: number): Date {
  return new Date(ms + 7 * 60 * 60 * 1000);
}

function formatWib(ms: number): string {
  const d = wibDate(ms);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatWibFull(ms: number): string {
  const d = wibDate(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} WIB`;
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


// ─── Guide Modal ──────────────────────────────────────────────────────────────

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
      title={`Score ${sign}${score}`}
    >
      {sign}{score}
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

function tradingViewSymbolUrl(symbol: string, timeframe: Timeframe): string {
  const interval =
    timeframe === "1h" ? "60" : timeframe === "4h" ? "240" : timeframe.replace("m", "");
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}.P&interval=${interval}`;
}

function binanceFuturesUrl(symbol: string): string {
  return `https://www.binance.com/en/futures/${symbol}`;
}

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
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500 mb-3">Lifecycle board</h3>
            <p className="text-xs text-neutral-500 mb-3">Every setup flows left→right through one board. Nothing disappears: a candidate you saw on Radar can be traced all the way to its Resolved outcome. History keeps the full stats.</p>
            <div className="grid gap-3 sm:grid-cols-4">
              {([
                ["Radar", "Pre-signal candidates near Market Profile levels — a provisional ATR plan before the z-score fires. Shows how long each has been on radar."],
                ["Fired", "Z-score fired, trade is active and no TP hit yet. Viability badge tells you if it's still a good fresh entry at the current mark price."],
                ["Running", "Already hit ≥ TP1. SL trails behind (BE after TP1, TP1 after TP2). Let it run toward TP2/TP3."],
                ["Resolved", "Recently closed: TP / SL / expired. A 📡→fire tag shows the radar lead time. Full win-rate stats live in History."],
              ] as const).map(([stage, desc], i) => (
                <div key={stage} className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-neutral-600">{i + 1}</span>
                    <span className="font-medium text-neutral-200">{stage}</span>
                    {i < 3 && <span className="text-neutral-700 text-xs">→</span>}
                  </div>
                  <p className="text-xs text-neutral-500">{desc}</p>
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
