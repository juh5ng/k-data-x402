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

-- Korean sell-side research listings, written by the hourly cron in
-- src/research.ts and read by the /api/research/* endpoints. Mirrors
-- ensureResearchSchema() there, which is what actually runs.
--
-- The second compounding asset. Only the facts of each report are stored, plus
-- an English summary written here; the PDF belongs to the brokerage and is
-- never fetched or redistributed. The listing site shows a rolling recent
-- window, so the per-house sequence of target prices and ratings cannot be
-- rebuilt later from any free source — it is worth what it has accumulated.
CREATE TABLE IF NOT EXISTS research_reports (
  report_idx INTEGER PRIMARY KEY,   -- natural key from the source listing
  published_date TEXT NOT NULL,     -- YYYY-MM-DD, KST as published
  ingested_at INTEGER NOT NULL,     -- unix seconds
  category TEXT NOT NULL,           -- 'business' today; 산업/시장 later
  ticker TEXT,                      -- 6-digit KRX code, null for non-single-name reports
  company TEXT,
  title TEXT NOT NULL,              -- Korean, company/ticker prefix removed
  title_en TEXT,                    -- null when translation failed
  target_price INTEGER,             -- KRW (적정가격), null when not stated
  rating TEXT,                      -- normalized Buy | Hold | Sell
  rating_raw TEXT,                  -- as printed (매수, Trading Buy, Not Rated, …)
  analyst TEXT,
  broker TEXT,
  summary_en TEXT,                  -- written from the facts above, not the report body
  summary_detail_en TEXT,           -- reserved: PDF-derived summary (unused)
  pdf_processed INTEGER NOT NULL DEFAULT 0,  -- reserved: 0 pending, 1 done, -1 failed
  processed INTEGER NOT NULL DEFAULT 0,      -- translation + summary done
  source_url TEXT NOT NULL          -- attribution link back to the publisher
);

-- The per-ticker endpoints scan one company over a date window.
CREATE INDEX IF NOT EXISTS idx_research_ticker_date ON research_reports (ticker, published_date);
CREATE INDEX IF NOT EXISTS idx_research_date ON research_reports (published_date);
-- Partial: the ingest tick only ever asks for the unprocessed backlog.
CREATE INDEX IF NOT EXISTS idx_research_unprocessed ON research_reports (processed) WHERE processed = 0;

-- Sales ledger. Written by the x402 settlement hooks in src/index.ts (HTTP) and
-- src/mcp.ts (MCP); mirrors ensureReceiptsSchema() in src/receipts.ts, which is
-- what actually runs.
--
-- Needed because the on-chain transfer cannot say what was sold: catalogue
-- prices collide across endpoints ($0.005, $0.01, $0.05, $0.08 and $0.12 each
-- cover two routes), so an amount narrows a sale to a pair at best.
CREATE TABLE IF NOT EXISTS receipts (
  ts INTEGER NOT NULL,              -- unix seconds
  endpoint TEXT NOT NULL,           -- catalogue path, e.g. /api/research/consensus/:ticker
  transport TEXT NOT NULL,          -- 'http' | 'mcp'
  tool_name TEXT,                   -- MCP tool name, null over HTTP
  price_usd REAL,                   -- catalogue list price
  amount_atomic TEXT,               -- what the requirements charged (USDC, 6 decimals)
  payer TEXT,                       -- buyer wallet; repeat purchases are the metric that matters
  tx_hash TEXT,                     -- basescan.org/tx/<hash>
  network TEXT,
  success INTEGER NOT NULL,         -- failed settlements are recorded too: a run of them
  error_reason TEXT                 -- looks like "no customers" unless it is written down
);

CREATE INDEX IF NOT EXISTS idx_receipts_ts ON receipts (ts);
CREATE INDEX IF NOT EXISTS idx_receipts_endpoint ON receipts (endpoint, ts);
CREATE INDEX IF NOT EXISTS idx_receipts_payer ON receipts (payer);
