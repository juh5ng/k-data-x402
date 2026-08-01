/**
 * Queries over the premium archive.
 *
 * This is the part of the catalogue no competitor can serve: both of the other
 * Korean-data x402 sellers publish live snapshots only, so history — and the
 * percentile context built from it — cannot be reproduced from any free source.
 */

export type Basis = "usdt" | "official";

const WINDOWS: Record<string, number> = {
  "1h": 3600,
  "6h": 6 * 3600,
  "24h": 24 * 3600,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
  "90d": 90 * 86400,
};

function resolveWindow(w?: string): { label: string; seconds: number } {
  const label = w && WINDOWS[w] ? w : "24h";
  return { label, seconds: WINDOWS[label] };
}

function basisColumn(basis: Basis): string {
  return basis === "official" ? "premium_official_pct" : "premium_usdt_pct";
}

export interface HistoryPoint {
  ts: string;
  upbit_krw: number;
  global_usd: number;
  premium_official_pct: number;
  premium_usdt_pct: number | null;
}

export async function getPremiumHistory(
  db: D1Database,
  symbol: string,
  window?: string,
  maxPoints = 500,
): Promise<{
  symbol: string;
  window: string;
  points: number;
  first_recorded: string | null;
  series: HistoryPoint[];
  as_of: string;
}> {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const { label, seconds } = resolveWindow(window);
  const since = Math.floor(Date.now() / 1000) - seconds;
  const limit = Math.min(Math.max(maxPoints, 1), 2000);

  const { results } = await db
    .prepare(
      `SELECT ts, upbit_krw, global_usd, premium_official_pct, premium_usdt_pct
         FROM premium_snapshots
        WHERE symbol = ? AND ts >= ?
        ORDER BY ts DESC
        LIMIT ?`,
    )
    .bind(sym, since, limit)
    .all<{
      ts: number;
      upbit_krw: number;
      global_usd: number;
      premium_official_pct: number;
      premium_usdt_pct: number | null;
    }>();

  const firstRow = await db
    .prepare("SELECT min(ts) AS first_ts FROM premium_snapshots WHERE symbol = ?")
    .bind(sym)
    .first<{ first_ts: number | null }>();

  return {
    symbol: sym,
    window: label,
    points: results.length,
    first_recorded: firstRow?.first_ts ? new Date(firstRow.first_ts * 1000).toISOString() : null,
    series: results
      .map(r => ({
        ts: new Date(r.ts * 1000).toISOString(),
        upbit_krw: r.upbit_krw,
        global_usd: r.global_usd,
        premium_official_pct: r.premium_official_pct,
        premium_usdt_pct: r.premium_usdt_pct,
      }))
      .reverse(),
    as_of: new Date().toISOString(),
  };
}

/**
 * Distribution of the premium over a window, plus where the latest reading
 * sits inside it. The percentile is the point: an agent can act on
 * "this is the 92nd percentile of the last 30 days" without holding any history
 * of its own.
 */
export async function getPremiumStats(
  db: D1Database,
  symbol: string,
  window?: string,
  basis: Basis = "usdt",
): Promise<{
  symbol: string;
  window: string;
  basis: Basis;
  basis_note: string;
  samples: number;
  current_pct: number | null;
  percentile: number | null;
  mean_pct: number | null;
  stdev_pct: number | null;
  zscore: number | null;
  min_pct: number | null;
  max_pct: number | null;
  median_pct: number | null;
  interpretation: string;
  as_of: string;
} | null> {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const { label, seconds } = resolveWindow(window);
  const since = Math.floor(Date.now() / 1000) - seconds;
  const col = basisColumn(basis);

  const { results } = await db
    .prepare(
      `SELECT ts, ${col} AS v
         FROM premium_snapshots
        WHERE symbol = ? AND ts >= ? AND ${col} IS NOT NULL
        ORDER BY ts ASC`,
    )
    .bind(sym, since)
    .all<{ ts: number; v: number }>();

  if (results.length === 0) return null;

  const values = results.map(r => r.v);
  const current = values[values.length - 1];
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdev = Math.sqrt(variance);
  const below = sorted.filter(v => v < current).length;
  const percentile = +((below / n) * 100).toFixed(1);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

  const round = (x: number) => +x.toFixed(4);
  const zscore = stdev > 0 ? round((current - mean) / stdev) : null;

  let interpretation: string;
  if (percentile >= 90) interpretation = "unusually high versus this window";
  else if (percentile >= 70) interpretation = "above typical";
  else if (percentile <= 10) interpretation = "unusually low versus this window";
  else if (percentile <= 30) interpretation = "below typical";
  else interpretation = "within the typical range";

  return {
    symbol: sym,
    window: label,
    basis,
    basis_note:
      basis === "usdt"
        ? "Premium measured against Upbit's KRW/USDT rate — the margin actually realizable."
        : "Premium measured against the official USD/KRW rate — the quoted figure, not tradeable.",
    samples: n,
    current_pct: round(current),
    percentile,
    mean_pct: round(mean),
    stdev_pct: round(stdev),
    zscore,
    min_pct: round(sorted[0]),
    max_pct: round(sorted[n - 1]),
    median_pct: round(median),
    interpretation,
    as_of: new Date().toISOString(),
  };
}
