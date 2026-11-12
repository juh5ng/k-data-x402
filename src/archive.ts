import { getKimchiPremium } from "./sources/kimchi";
import { startCollection, failCollection } from './collection';

/** Coins recorded on every tick. Widening this later is fine; narrowing loses history. */
const ARCHIVED_SYMBOLS = ["BTC", "ETH", "XRP", "SOL", "DOGE", "USDT"];

/**
 * One archive tick: snapshot the premium for every tracked symbol into D1.
 *
 * Called from the cron trigger. Cost is ~6 rows per run, ~1,700 rows/day at a
 * 5-minute cadence — an order of magnitude under D1's free write limit.
 */
export async function recordSnapshot(db: D1Database, options: { loadReport?: typeof getKimchiPremium; scheduledAt?: number } = {}): Promise<number> {
  await ensureSchema(db);
  const run = await startCollection(db, 'premium', ARCHIVED_SYMBOLS, options.scheduledAt);
  let failureCode = 'upstream_failure';
  try {
    const report = await (options.loadReport ?? getKimchiPremium)(ARCHIVED_SYMBOLS);
    const ts = Math.floor(Date.parse(report.as_of) / 1000);
    failureCode = 'invalid_report';
    const observed = report.entries.map(e => e.ticker);
    const positive = (v: number) => Number.isFinite(v) && v > 0;
    if (!Number.isSafeInteger(ts) || ts <= 0 || !positive(report.usdkrw_official)
      || new Set(observed).size !== observed.length || observed.some(s => !ARCHIVED_SYMBOLS.includes(s))
      || (report.usdkrw_usdt !== null && !positive(report.usdkrw_usdt))
      || report.entries.some(e => !positive(e.upbit_krw) || !positive(e.global_usd) || !Number.isFinite(e.premium_official_pct)
        || (e.premium_usdt_pct !== null && !Number.isFinite(e.premium_usdt_pct))
        || ((report.usdkrw_usdt === null) !== (e.premium_usdt_pct === null)))) throw new Error('Invalid premium observation');
    const status = !observed.length ? 'failure' : observed.length < ARCHIVED_SYMBOLS.length ? 'partial' : 'success';
    const stmts: D1PreparedStatement[] = [];
    for (const e of report.entries) {
      // Metadata is inserted BEFORE the price, only when its legacy key is absent.
      // The complete batch is atomic. Existing rows never gain guessed provenance.
      stmts.push(db.prepare(`INSERT OR IGNORE INTO premium_snapshot_sources (ts,symbol,run_id,global_provider,fx_provider,fx_as_of,fx_fetched_at,upbit_as_of,upbit_fetched_at,global_as_of,global_fetched_at,usdt_as_of,usdt_fetched_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM premium_snapshots WHERE ts=? AND symbol=?)`)
        .bind(ts,e.ticker,run.id,e.global_usd_source,report.usdkrw_official_source,report.fx_as_of??null,report.fx_fetched_at??null,e.upbit_as_of??null,e.upbit_fetched_at??null,e.global_as_of??null,e.global_fetched_at??null,report.usdt_as_of??null,report.usdt_fetched_at??null,ts,e.ticker));
      stmts.push(db.prepare("INSERT OR IGNORE INTO premium_snapshots (ts,symbol,upbit_krw,global_usd,usdkrw_official,usdkrw_usdt,premium_official_pct,premium_usdt_pct) VALUES (?,?,?,?,?,?,?,?)")
        .bind(ts,e.ticker,e.upbit_krw,e.global_usd,report.usdkrw_official,report.usdkrw_usdt,e.premium_official_pct,e.premium_usdt_pct));
    }
    stmts.push(db.prepare("UPDATE collector_runs SET completed_at=?,observed_json=?,status=?,error_code=?,rows_written=(SELECT COUNT(*) FROM premium_snapshot_sources WHERE run_id=?) WHERE run_id=?")
      .bind(new Date().toISOString(),JSON.stringify(observed),status,status==='failure'?'no_observations':null,run.id,run.id));
    failureCode = 'storage_failure';
    const results = await db.batch(stmts);
    return results.slice(0,-1).reduce((n,r,i) => n + (i%2===1 ? r.meta.changes??0 : 0),0);
  } catch {
    await failCollection(db,run.id,failureCode);
    throw new Error(`premium_collector:${failureCode}`);
  }
}

/** Creates the table on first run so a fresh deploy self-heals without a manual migration. */
export async function ensureSchema(db: D1Database): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS premium_snapshots (ts INTEGER NOT NULL, symbol TEXT NOT NULL, upbit_krw REAL NOT NULL, global_usd REAL NOT NULL, usdkrw_official REAL NOT NULL, usdkrw_usdt REAL, premium_official_pct REAL NOT NULL, premium_usdt_pct REAL, PRIMARY KEY (ts, symbol))",
  );
  await db.exec("CREATE INDEX IF NOT EXISTS idx_symbol_ts ON premium_snapshots (symbol, ts)");
  await db.exec("CREATE TABLE IF NOT EXISTS premium_snapshot_sources (ts INTEGER NOT NULL,symbol TEXT NOT NULL,run_id TEXT NOT NULL,global_provider TEXT,fx_provider TEXT,fx_as_of TEXT,fx_fetched_at TEXT,upbit_as_of TEXT,upbit_fetched_at TEXT,global_as_of TEXT,global_fetched_at TEXT,usdt_as_of TEXT,usdt_fetched_at TEXT,schema_version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(ts,symbol))");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_snapshot_source_run ON premium_snapshot_sources(run_id)");
}

