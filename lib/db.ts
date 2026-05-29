import { neon } from "@neondatabase/serverless";
import type { Signal } from "./types";

const SIGNAL_RETENTION_DAYS = Math.max(
  1,
  parseInt(process.env.SIGNAL_RETENTION_DAYS ?? "14", 10) || 14
);

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

// ─── Schema ──────────────────────────────────────────────────────────────────
export async function ensureSchema() {
  const sql = getDb();
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS signal_log (
      id               TEXT PRIMARY KEY,
      symbol           TEXT NOT NULL,
      timeframe        TEXT NOT NULL,
      side             TEXT NOT NULL,
      signal_type      TEXT,
      regime           TEXT,
      entry_price      REAL NOT NULL,
      tp1              REAL,
      tp2              REAL,
      tp3              REAL,
      sl               REAL,
      trigger_level    TEXT,
      z_level          INTEGER,
      z_score          REAL,
      squeeze_score    INTEGER,
      funding_rate     REAL,
      long_short_ratio REAL,
      bar_time         BIGINT NOT NULL,
      scanned_at       BIGINT NOT NULL,
      outcome          TEXT NOT NULL DEFAULT 'active',
      outcome_at       BIGINT,
      outcome_price    REAL,
      max_favorable    REAL,
      max_adverse      REAL,
      -- watchlist fields
      watched          BOOLEAN NOT NULL DEFAULT FALSE,
      watch_expires_at BIGINT,
      -- lifecycle tracking: highest TP reached while signal is still active
      best_tp          TEXT,
      -- which magnet each TP snapped to: 'atr', 'vwap_daily', 'vwap_weekly'
      tp2_source       TEXT,
      tp3_source       TEXT,
      -- manual paper trade fields: set when user logs a trade from the Entry tab
      paper_traded_at  BIGINT,
      paper_entry      REAL
    )
  `;
  // Migrations for existing tables
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS signal_type TEXT`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS regime TEXT`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS tp1 REAL`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS tp2 REAL`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS tp3 REAL`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS sl REAL`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS trigger_level TEXT`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS z_level INTEGER`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS z_score REAL`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS squeeze_score INTEGER`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS funding_rate REAL`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS long_short_ratio REAL`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'active'`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS outcome_at BIGINT`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS outcome_price REAL`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS max_favorable REAL`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS max_adverse REAL`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS watched BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS watch_expires_at BIGINT`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS best_tp TEXT`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS tp2_source TEXT`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS tp3_source TEXT`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS paper_traded_at BIGINT`;
  await sql`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS paper_entry REAL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sl_outcome  ON signal_log(outcome)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sl_bar_time ON signal_log(bar_time DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sl_symbol   ON signal_log(symbol)`;
}

// ─── Write path ───────────────────────────────────────────────────────────────
export async function insertSignal(s: Signal, scannedAt: number, regime?: string): Promise<boolean> {
  const sql = getDb();
  if (!sql) return false;
  const rows = await sql`
    INSERT INTO signal_log
      (id, symbol, timeframe, side, signal_type, regime, entry_price,
       tp1, tp2, tp3, sl, trigger_level, z_level, z_score, squeeze_score,
       funding_rate, long_short_ratio, bar_time, scanned_at,
       tp2_source, tp3_source)
    VALUES (
      ${`${s.symbol}-${s.timeframe}-${s.barTime}`},
      ${s.symbol}, ${s.timeframe}, ${s.side},
      ${s.signalType ?? null}, ${regime ?? null},
      ${s.barClose},
      ${s.tp1 ?? null}, ${s.tp2 ?? null}, ${s.tp3 ?? null}, ${s.sl ?? null},
      ${s.triggerLevel}, ${s.zLevel}, ${s.zScore},
      ${s.squeezeScore ?? null},
      ${s.fundingRate ?? null}, ${s.longShortRatio ?? null},
      ${s.barTime}, ${scannedAt},
      ${s.tp2Source ?? null}, ${s.tp3Source ?? null}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  ` as Array<{ id: string }>;
  return rows.length > 0;
}

// ─── Watchlist ─────────────────────────────────────────────────────────────────
export async function markAsWatched(id: string, holdDays = 3) {
  const sql = getDb();
  if (!sql) return;
  const expiresAt = Date.now() + holdDays * 24 * 60 * 60_000;
  await sql`
    UPDATE signal_log
    SET watched = TRUE, watch_expires_at = ${expiresAt}
    WHERE id = ${id}
  `;
}

// ─── Outcome types ────────────────────────────────────────────────────────────
export type Outcome = "active" | "tp1" | "tp2" | "tp3" | "sl" | "expired";

export interface SignalLog {
  id: string;
  symbol: string;
  timeframe: string;
  side: "long" | "short";
  signal_type: string | null;
  regime: string | null;
  entry_price: number;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  sl: number | null;
  trigger_level: string;
  z_level: number;
  z_score: number;
  squeeze_score: number | null;
  funding_rate: number | null;
  long_short_ratio: number | null;
  bar_time: number;
  scanned_at: number;
  outcome: Outcome;
  outcome_at: number | null;
  outcome_price: number | null;
  max_favorable: number | null;
  max_adverse: number | null;
  watched: boolean;
  watch_expires_at: number | null;
  best_tp: string | null;
  tp2_source: string | null;
  tp3_source: string | null;
  paper_traded_at: number | null;
  paper_entry: number | null;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toOutcome(value: unknown): Outcome {
  return value === "tp1" || value === "tp2" || value === "tp3" || value === "sl" || value === "expired" || value === "active"
    ? value
    : "active";
}

function normalizeSignalLog(row: unknown): SignalLog {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    symbol: String(r.symbol ?? ""),
    timeframe: String(r.timeframe ?? ""),
    side: r.side === "short" ? "short" : "long",
    signal_type: r.signal_type == null ? null : String(r.signal_type),
    regime: r.regime == null ? null : String(r.regime),
    entry_price: toNumber(r.entry_price),
    tp1: toNullableNumber(r.tp1),
    tp2: toNullableNumber(r.tp2),
    tp3: toNullableNumber(r.tp3),
    sl: toNullableNumber(r.sl),
    trigger_level: String(r.trigger_level ?? ""),
    z_level: toNumber(r.z_level),
    z_score: toNumber(r.z_score),
    squeeze_score: toNullableNumber(r.squeeze_score),
    funding_rate: toNullableNumber(r.funding_rate),
    long_short_ratio: toNullableNumber(r.long_short_ratio),
    bar_time: toNumber(r.bar_time),
    scanned_at: toNumber(r.scanned_at),
    outcome: toOutcome(r.outcome),
    outcome_at: toNullableNumber(r.outcome_at),
    outcome_price: toNullableNumber(r.outcome_price),
    max_favorable: toNullableNumber(r.max_favorable),
    max_adverse: toNullableNumber(r.max_adverse),
    watched: Boolean(r.watched),
    watch_expires_at: toNullableNumber(r.watch_expires_at),
    best_tp: r.best_tp == null ? null : String(r.best_tp),
    tp2_source: r.tp2_source == null ? null : String(r.tp2_source),
    tp3_source: r.tp3_source == null ? null : String(r.tp3_source),
    paper_traded_at: toNullableNumber(r.paper_traded_at),
    paper_entry: toNullableNumber(r.paper_entry),
  };
}

// ─── Outcome check helpers ────────────────────────────────────────────────────
export async function getActiveSignals(): Promise<SignalLog[]> {
  const sql = getDb();
  if (!sql) return [];
  const cutoff = Date.now() - 15 * 60_000;
  const rows = await sql`
    SELECT * FROM signal_log
    WHERE outcome = 'active' AND bar_time < ${cutoff}
    ORDER BY bar_time ASC
  `;
  return rows.map(normalizeSignalLog);
}

export async function updateOutcome(
  id: string,
  outcome: Outcome,
  outcomeAt: number,
  outcomePrice: number,
  maxFavorable: number,
  maxAdverse: number,
) {
  const sql = getDb();
  if (!sql) return;
  await sql`
    UPDATE signal_log
    SET outcome = ${outcome}, outcome_at = ${outcomeAt},
        outcome_price = ${outcomePrice},
        max_favorable = ${maxFavorable}, max_adverse = ${maxAdverse}
    WHERE id = ${id}
  `;
}

// Update best_tp without finalizing the outcome — signal stays "active" for re-checking.
export async function updateBestTP(id: string, bestTP: string) {
  const sql = getDb();
  if (!sql) return;
  await sql`UPDATE signal_log SET best_tp = ${bestTP} WHERE id = ${id} AND outcome = 'active'`;
}

// Expire non-watched signals after 72h, watched signals after their custom window.
export async function expireOldSignals() {
  const sql = getDb();
  if (!sql) return;
  const cutoff72h = Date.now() - 72 * 60 * 60_000;
  const now = Date.now();
  // Regular (unwatched) signals: expire after 72h.
  // If best_tp was set (TP1/TP2 hit while running), lock in that outcome instead of "expired".
  await sql`
    UPDATE signal_log
    SET outcome = COALESCE(best_tp, 'expired'), outcome_at = ${now}
    WHERE outcome = 'active'
      AND watched = FALSE
      AND bar_time < ${cutoff72h}
  `;
  // Watched signals: expire when their custom watch window closes
  await sql`
    UPDATE signal_log
    SET outcome = COALESCE(best_tp, 'expired'), outcome_at = ${now}
    WHERE outcome = 'active'
      AND watched = TRUE
      AND watch_expires_at IS NOT NULL
      AND watch_expires_at < ${now}
  `;
}

// Keep Neon storage bounded. Active signals are already expired after 72h, so
// deleting by bar_time is safe once the retention window has passed.
export async function pruneOldSignals(): Promise<number> {
  const sql = getDb();
  if (!sql) return 0;
  const cutoff = Date.now() - SIGNAL_RETENTION_DAYS * 24 * 60 * 60_000;
  const rows = await sql`
    DELETE FROM signal_log
    WHERE bar_time < ${cutoff}
    RETURNING id
  ` as Array<{ id: string }>;
  return rows.length;
}

// Returns all signals that still need monitoring. Active signals are included
// automatically; watched resolved signals remain visible as manual bookmarks.
// Paper-traded signals (paper_traded_at set) are always included regardless of outcome.
export async function getTrackedSignals(): Promise<SignalLog[]> {
  const sql = getDb();
  if (!sql) return [];
  const cutoff7d = Date.now() - 7 * 24 * 60 * 60_000;
  const rows = await sql`
    SELECT * FROM signal_log
    WHERE outcome = 'active'
       OR watched = TRUE
       OR (paper_traded_at IS NOT NULL AND bar_time > ${cutoff7d})
    ORDER BY
      CASE WHEN outcome = 'active' THEN 0 ELSE 1 END,
      bar_time DESC
    LIMIT 150
  ` as unknown[];
  return (rows as unknown[]).map(normalizeSignalLog);
}

export async function markAsPaperTrade(id: string, entryPrice: number): Promise<void> {
  const sql = getDb();
  if (!sql) return;
  await sql`
    UPDATE signal_log
    SET paper_traded_at = ${Date.now()}, paper_entry = ${entryPrice}
    WHERE id = ${id}
  `;
}

export async function getWatchedSignals(): Promise<SignalLog[]> {
  return getTrackedSignals();
}

// ─── Read path ────────────────────────────────────────────────────────────────
export interface HistoryResult {
  signals: SignalLog[];
  stats: {
    total: number;
    active: number;
    running: number;       // active signals that already hit ≥ TP1 (in-flight wins)
    tp3: number;
    tp2: number;
    tp1: number;
    sl: number;
    expired: number;
    tp3Rate: number;
    tp2Rate: number;
    tp1Rate: number;
    slRate: number;
    winRate: number;           // (tp1+tp2+tp3) / resolved — confirmed only
    provisionalWinRate: number; // (tp1+tp2+tp3+running) / (resolved+running)
  };
}

// History includes resolved signals AND in-flight running ones (active with best_tp set),
// so users can see TP1/TP2 that were hit but haven't locked-in via trailing SL yet.
export async function getSignalHistory(limit = 200): Promise<HistoryResult> {
  const sql = getDb();
  const empty: HistoryResult = {
    signals: [],
    stats: { total: 0, active: 0, running: 0, tp3: 0, tp2: 0, tp1: 0, sl: 0, expired: 0, tp3Rate: 0, tp2Rate: 0, tp1Rate: 0, slRate: 0, winRate: 0, provisionalWinRate: 0 },
  };
  if (!sql) return empty;

  const [rows, counts, runningRow] = await Promise.all([
    sql`
      SELECT * FROM signal_log
      WHERE outcome <> 'active' OR best_tp IS NOT NULL
      ORDER BY
        CASE WHEN outcome = 'active' THEN 0 ELSE 1 END,
        COALESCE(outcome_at, bar_time) DESC
      LIMIT ${limit}
    ` as Promise<unknown[]>,
    sql`
      SELECT outcome, COUNT(*)::int AS n
      FROM signal_log
      WHERE outcome <> 'active'
      GROUP BY outcome
    ` as Promise<unknown[]>,
    sql`
      SELECT COUNT(*)::int AS n FROM signal_log
      WHERE outcome = 'active' AND best_tp IS NOT NULL
    ` as Promise<unknown[]>,
  ]);

  const cm = Object.fromEntries(
    (counts as Array<{ outcome: string; n: unknown }>).map((r) => [r.outcome, toNumber(r.n)])
  );
  const tp3     = cm["tp3"] ?? 0;
  const tp2     = cm["tp2"] ?? 0;
  const tp1     = cm["tp1"] ?? 0;
  const sl      = cm["sl"]  ?? 0;
  const exp     = cm["expired"] ?? 0;
  const running = toNumber((runningRow[0] as Record<string, unknown>)?.n ?? 0);
  const resolved = tp3 + tp2 + tp1 + sl + exp;
  const totalWithRunning = resolved + running;

  return {
    signals: rows.map(normalizeSignalLog),
    stats: {
      total:   resolved,
      active:  0,
      running,
      tp3, tp2, tp1, sl, expired: exp,
      tp3Rate: resolved ? Math.round(tp3 / resolved * 100) : 0,
      tp2Rate: resolved ? Math.round(tp2 / resolved * 100) : 0,
      tp1Rate: resolved ? Math.round(tp1 / resolved * 100) : 0,
      slRate:  resolved ? Math.round(sl  / resolved * 100) : 0,
      winRate: resolved ? Math.round((tp1 + tp2 + tp3) / resolved * 100) : 0,
      provisionalWinRate: totalWithRunning ? Math.round((tp1 + tp2 + tp3 + running) / totalWithRunning * 100) : 0,
    },
  };
}
