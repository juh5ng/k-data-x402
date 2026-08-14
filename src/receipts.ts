/**
 * Sales ledger.
 *
 * Until this existed the only record of a sale was the USDC transfer on Base,
 * and that cannot say *what* was sold: the catalogue prices collide across
 * endpoints ($0.005, $0.01, $0.05, $0.08 and $0.12 each cover two routes), so
 * an on-chain amount narrows a purchase to a pair at best. One row per
 * settlement is the only way to know which product earned the money.
 *
 * Everything here runs on the paid request path, which sets two rules:
 *
 * 1. It must never be able to break a purchase. Writes are wrapped and
 *    swallowed, and the settlement hooks that call them swallow throws of
 *    their own — a lost receipt costs a statistic, a thrown one would cost the
 *    customer the data they just paid for.
 * 2. It must not add round-trips. The schema check runs once per isolate
 *    rather than once per sale.
 */

/** Statements are single-line because D1's exec() splits on newlines. */
export async function ensureReceiptsSchema(db: D1Database): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS receipts (ts INTEGER NOT NULL, endpoint TEXT NOT NULL, transport TEXT NOT NULL, tool_name TEXT, price_usd REAL, amount_atomic TEXT, payer TEXT, tx_hash TEXT, network TEXT, success INTEGER NOT NULL, error_reason TEXT)",
  );
  await db.exec("CREATE INDEX IF NOT EXISTS idx_receipts_ts ON receipts (ts)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_receipts_endpoint ON receipts (endpoint, ts)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_receipts_payer ON receipts (payer)");
}

// Module scope, so the check costs one round-trip per isolate rather than one
// per purchase. A rejected promise is cleared so the next sale retries.
let schemaReady: Promise<void> | null = null;

export function ensureReceiptsOnce(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = ensureReceiptsSchema(db).catch(err => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

export interface ReceiptInput {
  /** Catalogue path, e.g. "/api/research/consensus/:ticker" — never the concrete request path. */
  endpoint: string;
  transport: "http" | "mcp";
  /** MCP tool name when the sale came over MCP. */
  tool_name?: string | null;
  /** Catalogue list price in USD. */
  price_usd: number | null;
  /** What the payment requirements actually charged, in atomic units (USDC has 6 decimals). */
  amount_atomic: string | null;
  payer: string | null;
  tx_hash: string | null;
  network: string | null;
  success: boolean;
  error_reason?: string | null;
}

/**
 * Appends one settlement to the ledger. Never throws.
 *
 * Failed settlements are recorded too — a run of them means buyers are trying
 * and not getting through, which looks identical to "no customers" unless it
 * is written down.
 */
export async function recordReceipt(db: D1Database, r: ReceiptInput): Promise<void> {
  try {
    await ensureReceiptsOnce(db);
    await db
      .prepare(
        `INSERT INTO receipts
           (ts, endpoint, transport, tool_name, price_usd, amount_atomic,
            payer, tx_hash, network, success, error_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        Math.floor(Date.now() / 1000),
        r.endpoint,
        r.transport,
        r.tool_name ?? null,
        r.price_usd,
        r.amount_atomic,
        r.payer,
        r.tx_hash,
        r.network,
        r.success ? 1 : 0,
        r.error_reason ?? null,
      )
      .run();
  } catch (err) {
    console.error("receipts: write failed:", err);
  }
}
