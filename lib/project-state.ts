// Repository-level operational kill switch.
//
// Keep this hardcoded so pausing/resuming the project only requires a code
// deploy; no Vercel, cron, database, Redis, or Discord settings need changing.
export const PROJECT_PAUSED = true;

export const PROJECT_PAUSED_AT = "2026-07-27T00:00:00+07:00";
