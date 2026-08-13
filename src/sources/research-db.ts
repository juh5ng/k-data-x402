/**
 * Queries over the research archive.
 *
 * The listing site shows a rolling recent window and nothing else, so the
 * sequence of target prices and ratings a house has published for a ticker is
 * not retrievable after the fact from any free source. That series — and the
 * consensus and revision history built from it — is what these endpoints sell.
 * Live listings are the cheap part; the accumulated history is the moat.
 */

const WINDOW_DAYS: Record<string, number> = { "30d": 30, "90d": 90, "180d": 180, "365d": 365 };
/** Caps the raw series on a heavily-covered ticker; the revision log is never truncated. */
const MAX_SERIES = 200;

function resolveWindow(w?: string): { label: string; days: number } {
  const label = w && WINDOW_DAYS[w] ? w : "90d";
  return { label, days: WINDOW_DAYS[label] };
}

/** published_date is stored as YYYY-MM-DD, so string comparison is date comparison. */
function cutoffDate(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

/** 6-digit KRX code; anything else can never match a row. */
function normalizeTicker(raw: string): string {
  return raw.replace(/[^\d]/g, "").slice(0, 6);
}

const REPORT_COLUMNS = `report_idx, published_date, ticker, company, title, title_en,
       summary_en, target_price, rating, rating_raw, analyst, broker, source_url`;

export interface ResearchItem {
  report_idx: number;
  published_date: string;
  ticker: string | null;
  company: string | null;
  title: string;
  title_en: string | null;
  summary_en: string | null;
  target_price: number | null;
  rating: string | null;
  rating_raw: string | null;
  analyst: string | null;
  broker: string | null;
  source_url: string;
}

/** Newest research across all covered companies. */
export async function getLatestResearch(
  db: D1Database,
  limit = 20,
): Promise<{ count: number; items: ResearchItem[]; as_of: string }> {
  const { results } = await db
    .prepare(`SELECT ${REPORT_COLUMNS} FROM research_reports ORDER BY report_idx DESC LIMIT ?`)
    .bind(Math.min(Math.max(limit, 1), 50))
    .all<ResearchItem>();

  return { count: results.length, items: results, as_of: new Date().toISOString() };
}

/** Every archived report for one company, newest first. */
export async function getCompanyResearch(
  db: D1Database,
  ticker: string,
  limit = 20,
): Promise<{
  ticker: string;
  company: string | null;
  count: number;
  first_recorded: string | null;
  items: ResearchItem[];
  as_of: string;
} | null> {
  const code = normalizeTicker(ticker);
  if (code.length !== 6) return null;

  const { results } = await db
    .prepare(
      `SELECT ${REPORT_COLUMNS} FROM research_reports
        WHERE ticker = ? ORDER BY report_idx DESC LIMIT ?`,
    )
    .bind(code, Math.min(Math.max(limit, 1), 50))
    .all<ResearchItem>();

  if (results.length === 0) return null;

  const firstRow = await db
    .prepare("SELECT min(published_date) AS first_date FROM research_reports WHERE ticker = ?")
    .bind(code)
    .first<{ first_date: string | null }>();

  return {
    ticker: code,
    company: results.find(r => r.company)?.company ?? null,
    count: results.length,
    first_recorded: firstRow?.first_date ?? null,
    items: results,
    as_of: new Date().toISOString(),
  };
}

const RATING_RANK: Record<string, number> = { Sell: 1, Hold: 2, Buy: 3 };

interface SeriesRow {
  report_idx: number;
  published_date: string;
  broker: string | null;
  analyst: string | null;
  target_price: number | null;
  rating: string | null;
}

export interface RevisionEvent {
  published_date: string;
  broker: string | null;
  analyst: string | null;
  target_price: number | null;
  prev_target_price: number | null;
  target_change_pct: number | null;
  /** "raised" | "cut" when this house moved its own target, else null. */
  target_direction: string | null;
  rating: string | null;
  prev_rating: string | null;
  /** "upgrade" | "downgrade" when this house moved its own rating, else null. */
  rating_direction: string | null;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * Consensus and revision history for one ticker.
 *
 * Consensus is computed from each house's *latest* view inside the window, not
 * from every report — a house that publishes weekly would otherwise outvote one
 * that publishes quarterly. Revisions are detected per house against that same
 * house's previous report, so a new house initiating coverage is not mistaken
 * for an upgrade.
 */
export async function getConsensus(
  db: D1Database,
  ticker: string,
  window?: string,
): Promise<{
  ticker: string;
  company: string | null;
  window: string;
  reports_total: number;
  brokers: number;
  consensus: {
    mean_target: number | null;
    median_target: number | null;
    min_target: number | null;
    max_target: number | null;
    spread_pct: number | null;
    ratings: Record<string, number>;
  };
  changes: RevisionEvent[];
  series: SeriesRow[];
  first_recorded: string | null;
  as_of: string;
} | null> {
  const code = normalizeTicker(ticker);
  if (code.length !== 6) return null;
  const { label, days } = resolveWindow(window);

  const { results } = await db
    .prepare(
      `SELECT report_idx, published_date, broker, analyst, target_price, rating
         FROM research_reports
        WHERE ticker = ? AND published_date >= ?
        ORDER BY published_date ASC, report_idx ASC`,
    )
    .bind(code, cutoffDate(days))
    .all<SeriesRow>();

  if (results.length === 0) return null;

  // Walk each house's own sequence: latest view for the consensus, and any move
  // against its previous report for the revision log.
  const latestByBroker = new Map<string, { target: number | null; rating: string | null }>();
  const changes: RevisionEvent[] = [];

  for (const row of results) {
    const key = row.broker ?? "unknown";
    const prev = latestByBroker.get(key);
    const prevTarget = prev?.target ?? null;
    const prevRating = prev?.rating ?? null;

    const targetMoved =
      row.target_price !== null && prevTarget !== null && row.target_price !== prevTarget;
    const ratingMoved =
      row.rating !== null &&
      prevRating !== null &&
      row.rating !== prevRating &&
      RATING_RANK[row.rating] !== undefined &&
      RATING_RANK[prevRating] !== undefined;

    if (targetMoved || ratingMoved) {
      changes.push({
        published_date: row.published_date,
        broker: row.broker,
        analyst: row.analyst,
        target_price: row.target_price,
        prev_target_price: targetMoved ? prevTarget : null,
        target_change_pct: targetMoved
          ? +(((row.target_price! - prevTarget!) / prevTarget!) * 100).toFixed(2)
          : null,
        target_direction: targetMoved ? (row.target_price! > prevTarget! ? "raised" : "cut") : null,
        rating: row.rating,
        prev_rating: ratingMoved ? prevRating : null,
        rating_direction: ratingMoved
          ? RATING_RANK[row.rating!] > RATING_RANK[prevRating!]
            ? "upgrade"
            : "downgrade"
          : null,
      });
    }

    latestByBroker.set(key, {
      target: row.target_price ?? prevTarget,
      rating: row.rating ?? prevRating,
    });
  }

  const targets = [...latestByBroker.values()]
    .map(v => v.target)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);

  const ratings: Record<string, number> = {};
  for (const v of latestByBroker.values()) if (v.rating) ratings[v.rating] = (ratings[v.rating] ?? 0) + 1;

  const mean = targets.length ? targets.reduce((s, v) => s + v, 0) / targets.length : null;

  const companyRow = await db
    .prepare(
      "SELECT company, min(published_date) AS first_date FROM research_reports WHERE ticker = ?",
    )
    .bind(code)
    .first<{ company: string | null; first_date: string | null }>();

  return {
    ticker: code,
    company: companyRow?.company ?? null,
    window: label,
    reports_total: results.length,
    brokers: latestByBroker.size,
    consensus: {
      mean_target: mean === null ? null : Math.round(mean),
      median_target: targets.length ? Math.round(median(targets)) : null,
      min_target: targets.length ? targets[0] : null,
      max_target: targets.length ? targets[targets.length - 1] : null,
      // How far apart the houses are — a wide spread means the "consensus"
      // number is hiding real disagreement.
      spread_pct:
        mean && targets.length > 1
          ? +(((targets[targets.length - 1] - targets[0]) / mean) * 100).toFixed(2)
          : null,
      ratings,
    },
    changes: changes.reverse(),
    series: results.reverse().slice(0, MAX_SERIES),
    first_recorded: companyRow?.first_date ?? null,
    as_of: new Date().toISOString(),
  };
}
