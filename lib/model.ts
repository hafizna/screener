export const MODEL_VERSION = process.env.MODEL_VERSION ?? "v1";

export const MODEL_PARAMS = {
  detector: "market_profile_zscore",
  zScore: {
    requireExtreme: false,
    minLevel: 2,
  },
  profile: {
    toleranceTicks: 2,
    watchToleranceMultiplier: 2,
  },
  atrTargets: {
    tp1: 1.5,
    tp2: 3.0,
    tp3: 5.0,
    sl: 1.0,
    period: 14,
    timeframe: "1h",
  },
  windows: {
    recentSignalBars: Number(process.env.RECENT_SIGNAL_BARS ?? 8),
    recentSignalBars1h: Number(process.env.RECENT_SIGNAL_BARS_1H ?? 4),
    watchlistLimit: Number(process.env.WATCHLIST_LIMIT ?? 30),
    outcomeTimeoutHours: 72,
  },
  ranking: [
    "biasScore4h",
    "biasScore1h",
    "frBias",
    "deltaBias",
    "oiBias",
    "lsBias",
    "rsBias",
    "zLevel",
    "absZScore",
  ],
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export const MODEL_PARAMS_JSON = stableStringify(MODEL_PARAMS);
export const MODEL_PARAMS_HASH = hashString(MODEL_PARAMS_JSON);

function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
