export const RUN_SCHEMA = "CREATE TABLE IF NOT EXISTS collector_runs (run_id TEXT PRIMARY KEY, collector TEXT NOT NULL, scheduled_at INTEGER, started_at TEXT NOT NULL, completed_at TEXT, expected_json TEXT NOT NULL, observed_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK(status IN ('running','success','partial','failure')), rows_written INTEGER NOT NULL DEFAULT 0, error_code TEXT, schema_version INTEGER NOT NULL DEFAULT 1)";

export async function startCollection(db: D1Database, collector: string, expected: string[], scheduledAt?: number) {
  await db.exec(RUN_SCHEMA);
  const run = { id: crypto.randomUUID(), startedAt: new Date().toISOString() };
  await db.prepare("INSERT INTO collector_runs (run_id,collector,scheduled_at,started_at,expected_json,status) VALUES (?,?,?,?,?,'running')")
    .bind(run.id, collector, scheduledAt ?? null, run.startedAt, JSON.stringify(expected)).run();
  return run;
}

export async function failCollection(db: D1Database, runId: string, errorCode: string) {
  // Never persist raw exceptions, request URLs, headers or credentials.
  await db.prepare("UPDATE collector_runs SET completed_at=?,status='failure',error_code=? WHERE run_id=?")
    .bind(new Date().toISOString(), errorCode, runId).run();
}

export function validTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}
