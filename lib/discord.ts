// Discord webhook notifier for quality-gated fired signals.
//
// Fire-and-forget: a webhook failure must NEVER break the scan. We post only the
// signals that pass the same quality gate the dashboard uses (passesQualityGate
// below), so Discord stays a high-signal channel rather than echoing every fire.
//
// Set DISCORD_WEBHOOK_URL in the environment to enable. Absent = silently disabled.

import type { Signal } from "./types";

// Server-side mirror of app/page.tsx:passesQualityFilter, operating on the live
// Signal shape (camelCase) instead of the persisted SignalLog (snake_case).
// Keep the two in sync: drop sqz=0, drop bounce setups, drop high-conf breakout,
// require entry within 0.75% of weekly/monthly VWAP, and no long chasing above
// the monthly VWAP. VWAP checks are skipped when the columns are absent.
const QUALITY_VWAP_NEAR_PCT = 0.75;

export function passesQualityGate(s: Signal, regime?: string): boolean {
  if (s.squeezeScore == null || s.squeezeScore === 0) return false;
  if (s.signalType === "bounce") return false;
  // "high confidence" mirrors the dashboard bucket: squeezeScore >= 5.
  const highConfidence = (s.squeezeScore ?? 0) >= 5;
  if (highConfidence && regime === "breakout") return false;
  const dw = s.distVwapWeeklyPct;
  const dm = s.distVwapMonthlyPct;
  if (dw != null || dm != null) {
    const nearVwap =
      (dw != null && Math.abs(dw) <= QUALITY_VWAP_NEAR_PCT) ||
      (dm != null && Math.abs(dm) <= QUALITY_VWAP_NEAR_PCT);
    if (!nearVwap) return false;
    if (s.side === "long" && dm != null && dm > 0) return false;
  }
  return true;
}

function fmtPrice(n?: number): string {
  if (n == null) return "—";
  return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
}

// Build the Discord embed for one quality signal. Mirrors the board card: side,
// level it rejected from, regime, squeeze, entry/SL/TPs.
function buildEmbed(s: Signal, regime?: string) {
  const sideEmoji = s.side === "short" ? "🔴" : "🟢";
  const action = s.side === "short" ? "fade" : "bounce";
  const color = s.side === "short" ? 0xef4444 : 0x22c55e;
  const lines = [
    `**${action} ${s.triggerLevel}**  ·  regime: ${regime ?? "—"}  ·  sqz ${s.squeezeScore ?? "—"}/6`,
    `entry \`${fmtPrice(s.barClose)}\`  SL \`${fmtPrice(s.sl)}\``,
    `TP \`${fmtPrice(s.tp1)}\` · \`${fmtPrice(s.tp2)}\` · \`${fmtPrice(s.tp3)}\``,
  ];
  if (s.frBias) lines.push(`funding: ${s.frBias}`);
  return {
    title: `${sideEmoji} ${s.symbol} ${s.side.toUpperCase()} (${s.timeframe})`,
    description: lines.join("\n"),
    color,
    footer: { text: "MP+Z screener · quality signal" },
    timestamp: new Date(s.barTime).toISOString(),
  };
}

// Post the given quality signals to Discord. No-op if the webhook is unset.
// Batches up to 10 embeds per message (Discord's limit). Never throws.
export async function postQualitySignals(signals: Signal[], regime?: string): Promise<number> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url || signals.length === 0) return 0;
  const quality = signals.filter((s) => passesQualityGate(s, regime));
  if (quality.length === 0) return 0;

  let sent = 0;
  for (let i = 0; i < quality.length; i += 10) {
    const batch = quality.slice(i, i + 10);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "MP+Z Screener",
          embeds: batch.map((s) => buildEmbed(s, regime)),
        }),
      });
      if (res.ok) sent += batch.length;
      else console.warn("Discord webhook non-OK:", res.status);
    } catch (e) {
      console.warn("Discord webhook failed:", (e as Error).message);
    }
  }
  return sent;
}
