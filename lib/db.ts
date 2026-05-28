import { neon } from "@neondatabase/serverless";
import type { Signal } from "./types";

// Lazily create the client so missing DATABASE_URL doesn't break the build.
// All exported helpers return early (no-op) when DB is not configured.
function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

// ─── Schema ──────────────────────────────────────────────────────────────────
// Called once at startup of the scan cron. CREATE IF NOT EXISTS is idempotent
// and effectively free after the first run (Postgres caches the catalog check).
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
      max_adverse      REAL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_sl_outcome  ON signal_log(outcome)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sl_bar_time ON signal_log(bar_time DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sl_symbol   ON signal_log(symbol)`;
}

// ─── Write path ───────────────────────────────────────────────────────────────
// Insert a detected signal. Uses ON CONFLICT DO NOTHING so re-running a scan
// at the same barTime for the same symbol is safe.
export async function insertSignal(s: Signal, scannedAt: number, regime?: string) {
  const sql = getDb();
  if (!sql) return;
  await sql`
    INSERT INTO signal_log
      (id, symbol, timeframe, side, signal_type, regime, entry_price,
       tp1, tp2, sl, trigger_level, z_level, z_score, squeeze_score,
       funding_rate, long_short_ratio, bar_time, scanned_at)
    VALUES (
      ${`${s.symbol}-${s.timeframe}-${s.barTime}`},
      ${s.symbol}, ${s.timeframe}, ${s.side},
      ${s.signalType ?? null}, ${regime ?? null},
      ${s.barClose},
      ${s.tp1 ?? null}, ${s.tp2 ?? null}, ${s.sl ?? null},
      ${s.triggerLevel}, ${s.zLevel}, ${s.zScore},
      ${s.squeezeScore ?? null},
      ${s.fundingRate ?? null}, ${s.longShortRatio ?? null},
      ${s.barTime}, ${scannedAt}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

// ─── Outcome types ────────────────────────────────────────────────────────────
export type Outcome = "active" | "tp1" | "tp2" | "sl" | "expired";

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
}

// ─── Outcome check helpers ────────────────────────────────────────────────────
// Returns all active signals older than 1 bar (bar_time < now - 15m).
// We skip the most recent bar since it hasn't had time to develop yet.
export async function getActiveSignals(): Promise<SignalLog[]> {
  const sql = getDb();
  if (!sql) return [];
  const cutoff = Date.now() - 15 * 60_000;
  const rows = await sql`
    SELECT * FROM signal_log
    WHERE outcome = 'active' AND bar_time < ${cutoff}
    ORDER BY bar_time ASC
  `;
  return rows as unknown as SignalLog[];
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

// Mark signals that have been active > 24h as expired.
export async function expireOldSignals() {
  const sql = getDb();
  if (!sql) return;
  const cutoff = Date.now() - 24 * 60 * 60_000;
  await sql`
    UPDATE signal_log
    SET outcome = 'expired', outcome_at = ${Date.now()}
    WHERE outcome = 'active' AND bar_time < ${cutoff}
  `;
}

// ─── Read path ────────────────────────────────────────────────────────────────
export interface HistoryResult {
  signals: SignalLog[];
  stats: {
    total: number;
    active: number;
    tp2: number;
    tp1: number;
    sl: number;
    expired: number;
    tp2Rate: number;  // % of resolved signals
    tp1Rate: number;
    slRate: number;
  };
}

export async function getSignalHistory(limit = 200): Promise<HistoryResult> {
  const sql = getDb();
  if (!sql) return { signals: [], stats: { total: 0, active: 0, tp2: 0, tp1: 0, sl: 0, expired: 0, tp2Rate: 0, tp1Rate: 0, slRate: 0 } };

  const [rows, counts] = await Promise.all([
    sql`SELECT * FROM signal_log ORDER BY bar_time DESC LIMIT ${limit}` as Promise<unknown[]>,
    sql`
      SELECT outcome, COUNT(*)::int AS n
      FROM signal_log
      GROUP BY outcome
    ` as Promise<unknown[]>,
  ]);

  const cm = Object.fromEntries(
    (counts as Array<{ outcome: string; n: number }>).map((r) => [r.outcome, r.n])
  );
  const tp2 = cm["tp2"] ?? 0;
  const tp1 = cm["tp1"] ?? 0;
  const sl  = cm["sl"]  ?? 0;
  const exp = cm["expired"] ?? 0;
  const resolved = tp2 + tp1 + sl + exp;

  return {
    signals: rows as unknown as SignalLog[],
    stats: {
      total:   (cm["active"] ?? 0) + resolved,
      active:  cm["active"] ?? 0,
      tp2, tp1, sl, expired: exp,
      tp2Rate: resolved ? Math.round(tp2 / resolved * 100) : 0,
      tp1Rate: resolved ? Math.round(tp1 / resolved * 100) : 0,
      slRate:  resolved ? Math.round(sl  / resolved * 100) : 0,
    },
  };
}
