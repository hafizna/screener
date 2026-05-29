"use client";

import { useEffect, useState } from "react";
import type { MarketRegime, ScanResult, Signal, SignalType, Timeframe } from "@/lib/types";
import type { HistoryResult, SignalLog, RadarLog, Outcome } from "@/lib/db";

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
type BoardTrade = SignalLog & { current_price: number | null };
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

  // Fired sorted: near-entry (most actionable) first.
  const firedSorted = [...fired].sort((a, b) => entryDistancePct(a) - entryDistancePct(b));

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
          radar→fired→running→resolved · auto-refresh 60s
        </span>
      </section>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4 items-start">
        <BoardColumn stage="radar" title="Radar" count={radar.length} accent="text-amber-300"
          hint="Pre-signal candidates near MP levels. Not fired yet.">
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
                  watched={watched} onWatch={onWatch} papered={papered} onPaperTrade={onPaperTrade} />
              ))}
        </BoardColumn>

        <BoardColumn stage="running" title="Running" count={running.length} accent="text-emerald-300"
          hint="Already hit ≥ TP1. SL trails behind; let it run.">
          {running.length === 0
            ? <BoardEmpty text="No runners right now." />
            : running.map((t) => (
                <TradeCard key={t.id} row={t} stage="running"
                  watched={watched} onWatch={onWatch} papered={papered} onPaperTrade={onPaperTrade} />
              ))}
        </BoardColumn>

        <BoardColumn stage="resolved" title="Resolved" count={resolved.length} accent="text-neutral-400"
          hint="Recently closed: TP / SL / expired. Full stats in History.">
          {resolved.length === 0
            ? <BoardEmpty text="No resolved trades yet." />
            : resolved.map((t) => (
                <TradeCard key={t.id} row={t} stage="resolved"
                  watched={watched} onWatch={onWatch} papered={papered} onPaperTrade={onPaperTrade} />
              ))}
        </BoardColumn>
      </div>
    </div>
  );
}

// Distance of current price from planned entry, in %. Used to surface the
// most-actionable fired setups (closest to entry) first. Unknown price → far.
function entryDistancePct(row: BoardTrade): number {
  if (row.current_price == null || row.entry_price <= 0) return 1e9;
  return Math.abs(row.current_price - row.entry_price) / row.entry_price * 100;
}

function BoardColumn({ title, count, accent, hint, children }: {
  stage: BoardStage; title: string; count: number; accent: string; hint: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/20">
      <div className="px-3 py-2 border-b border-neutral-800 flex items-center justify-between" title={hint}>
        <span className={`text-sm font-medium ${accent}`}>{title}</span>
        <span className="text-xs text-neutral-500 tabular-nums">{count}</span>
      </div>
      <div className="p-2 space-y-2 max-h-[70vh] overflow-y-auto">
        {children}
      </div>
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

function TradeCard({ row, stage, watched, onWatch, papered, onPaperTrade }: {
  row: BoardTrade; stage: BoardStage;
  watched: Set<string>; onWatch: (id: string, holdDays: number) => void;
  papered: Set<string>; onPaperTrade: (id: string, entryPrice: number) => void;
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
        {(stage === "fired" || stage === "running") && !row.watched && !watched.has(row.id) && (
          <button onClick={() => onWatch(row.id, 3)} className="ml-auto text-neutral-600 hover:text-amber-300" title="Star (keep tracking)">☆</button>
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
  const profileRows = historyPerformanceRows(signals, (row) => row.trigger_level || "unknown");
  // TP2 magnet source — lets us compare VWAP-anchored vs pure-ATR target performance.
  const tpSourceRows = historyPerformanceRows(signals, (row) =>
    row.tp2_source === "vwap_daily" ? "TP2 daily VWAP"
    : row.tp2_source === "vwap_weekly" ? "TP2 weekly VWAP"
    : "TP2 pure ATR"
  );

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
