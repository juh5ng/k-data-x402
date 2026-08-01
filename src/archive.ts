import { getKimchiPremium } from "./sources/kimchi";

/** Coins recorded on every tick. Widening this later is fine; narrowing loses history. */
const ARCHIVED_SYMBOLS = ["BTC", "ETH", "XRP", "SOL", "DOGE", "USDT"];

/**
 * One archive tick: snapshot the premium for every tracked symbol into D1.
 *
 * Called from the cron trigger. Cost is ~6 rows per run, ~1,700 rows/day at a
 * 5-minute cadence — an order of magnitude under D1's free write limit.
 */
export async function recordSnapshot(db: D1Database): Promise<number> {
  const report = await getKimchiPremium(ARCHIVED_SYMBOLS);
  if (report.entries.length === 0) return 0;

  const ts = Math.floor(Date.parse(report.as_of) / 1000);
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO premium_snapshots
       (ts, symbol, upbit_krw, global_usd, usdkrw_official, usdkrw_usdt,
        premium_official_pct, premium_usdt_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  await db.batch(
    report.entries.map(e =>
      stmt.bind(
        ts,
        e.ticker,
        e.upbit_krw,
        e.global_usd,
        report.usdkrw_official,
        report.usdkrw_usdt,
        e.premium_official_pct,
        e.premium_usdt_pct,
      ),
    ),
  );
  return report.entries.length;
}

/** Creates the table on first run so a fresh deploy self-heals without a manual migration. */
export async function ensureSchema(db: D1Database): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS premium_snapshots (ts INTEGER NOT NULL, symbol TEXT NOT NULL, upbit_krw REAL NOT NULL, global_usd REAL NOT NULL, usdkrw_official REAL NOT NULL, usdkrw_usdt REAL, premium_official_pct REAL NOT NULL, premium_usdt_pct REAL, PRIMARY KEY (ts, symbol))",
  );
  await db.exec("CREATE INDEX IF NOT EXISTS idx_symbol_ts ON premium_snapshots (symbol, ts)");
}
