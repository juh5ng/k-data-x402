-- Time-series archive of the kimchi premium.
-- Written by the cron trigger in src/archive.ts, read by the /history and
-- /stats endpoints. Neither competitor sells history, so this table is the
-- product's only compounding asset — it is worth exactly as much as the number
-- of days it has been running.
CREATE TABLE IF NOT EXISTS premium_snapshots (
  ts INTEGER NOT NULL,              -- unix seconds
  symbol TEXT NOT NULL,
  upbit_krw REAL NOT NULL,
  global_usd REAL NOT NULL,
  usdkrw_official REAL NOT NULL,
  usdkrw_usdt REAL,                 -- Upbit KRW-USDT last price
  premium_official_pct REAL NOT NULL,
  premium_usdt_pct REAL,            -- null when the USDT market is unavailable
  PRIMARY KEY (ts, symbol)
);

-- History and stats both scan one symbol over a time window.
CREATE INDEX IF NOT EXISTS idx_symbol_ts ON premium_snapshots (symbol, ts);
