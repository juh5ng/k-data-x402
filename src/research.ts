import { fetchNewReports, type ResearchRow } from "./sources/research";
import { translateKoToEn } from "./lib/translate";
import { summarizeReportMeta } from "./lib/summarize";

/**
 * Hourly ingest of Korean sell-side research listings.
 *
 * The archive is the product. Any given day's listing is public and free, but
 * the sequence of target prices and ratings a house has published for a ticker
 * over months cannot be reconstructed after the fact from anywhere — the site
 * only ever shows a recent window. Every tick that runs makes that series
 * longer, and every tick that is missed is a permanent hole. Same logic as the
 * premium archive in archive.ts, applied to equities.
 */

/** New reports translated + summarized per tick. Leftovers roll into the next hour. */
const PROCESS_BATCH = 10;
/** Concurrent model calls, matching lib/translate.ts. */
const CONCURRENCY = 4;

interface PendingRow {
  report_idx: number;
  published_date: string;
  ticker: string | null;
  company: string | null;
  title: string;
  target_price: number | null;
  rating: string | null;
  rating_raw: string | null;
  analyst: string | null;
  broker: string | null;
}

/**
 * Creates the table on first run so a fresh deploy self-heals, matching
 * ensureSchema() in archive.ts. Statements are single-line because D1's exec()
 * splits on newlines.
 *
 * summary_detail_en and pdf_processed are unused today. They are declared now
 * because CREATE TABLE IF NOT EXISTS cannot alter a table that already exists,
 * so adding PDF-derived summaries later would otherwise need a migration.
 */
export async function ensureResearchSchema(db: D1Database): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS research_reports (report_idx INTEGER PRIMARY KEY, published_date TEXT NOT NULL, ingested_at INTEGER NOT NULL, category TEXT NOT NULL, ticker TEXT, company TEXT, title TEXT NOT NULL, title_en TEXT, target_price INTEGER, rating TEXT, rating_raw TEXT, analyst TEXT, broker TEXT, summary_en TEXT, summary_detail_en TEXT, pdf_processed INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0, source_url TEXT NOT NULL)",
  );
  await db.exec(
    "CREATE INDEX IF NOT EXISTS idx_research_ticker_date ON research_reports (ticker, published_date)",
  );
  await db.exec("CREATE INDEX IF NOT EXISTS idx_research_date ON research_reports (published_date)");
  await db.exec(
    "CREATE INDEX IF NOT EXISTS idx_research_unprocessed ON research_reports (processed) WHERE processed = 0",
  );
}

async function insertRows(db: D1Database, rows: ResearchRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const ingestedAt = Math.floor(Date.now() / 1000);
  // OR IGNORE, not OR REPLACE: a report already in the table has a summary that
  // cost a model call, and re-listing it must not throw that away.
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO research_reports
       (report_idx, published_date, ingested_at, category, ticker, company, title,
        target_price, rating, rating_raw, analyst, broker, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch(
    rows.map(r =>
      stmt.bind(
        r.report_idx,
        r.published_date,
        ingestedAt,
        r.category,
        r.ticker,
        r.company,
        r.title,
        r.target_price,
        r.rating,
        r.rating_raw,
        r.analyst,
        r.broker,
        r.source_url,
      ),
    ),
  );
  return rows.length;
}

/**
 * Translates and summarizes up to `limit` unprocessed rows.
 *
 * A row is marked processed even when the model returns null: a null summary
 * degrades one field, while an unprocessed row would be retried every hour
 * forever. The facts are what is being sold; the summary is the convenience.
 */
async function processPending(db: D1Database, ai: Ai, limit: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT report_idx, published_date, ticker, company, title, target_price,
              rating, rating_raw, analyst, broker
         FROM research_reports
        WHERE processed = 0
        ORDER BY report_idx DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<PendingRow>();

  if (results.length === 0) return 0;

  const titlesEn = await translateKoToEn(ai, results.map(r => r.title));

  const summaries: (string | null)[] = new Array(results.length).fill(null);
  for (let i = 0; i < results.length; i += CONCURRENCY) {
    const slice = results.slice(i, i + CONCURRENCY);
    const done = await Promise.all(slice.map(r => summarizeReportMeta(ai, r)));
    done.forEach((v, j) => (summaries[i + j] = v));
  }

  const stmt = db.prepare(
    "UPDATE research_reports SET title_en = ?, summary_en = ?, processed = 1 WHERE report_idx = ?",
  );
  await db.batch(results.map((r, i) => stmt.bind(titlesEn[i], summaries[i], r.report_idx)));
  return results.length;
}

/**
 * One ingest tick: pull anything published since the newest report already
 * held, store the facts, then translate and summarize a bounded batch.
 */
export async function runResearchTick(
  db: D1Database,
  ai: Ai,
): Promise<{ inserted: number; summarized: number; pending: number }> {
  await ensureResearchSchema(db);

  const maxRow = await db
    .prepare("SELECT max(report_idx) AS max_idx FROM research_reports")
    .first<{ max_idx: number | null }>();

  const rows = await fetchNewReports(maxRow?.max_idx ?? 0);
  const inserted = await insertRows(db, rows);
  const summarized = await processPending(db, ai, PROCESS_BATCH);

  const pendingRow = await db
    .prepare("SELECT count(*) AS n FROM research_reports WHERE processed = 0")
    .first<{ n: number }>();

  return { inserted, summarized, pending: pendingRow?.n ?? 0 };
}
