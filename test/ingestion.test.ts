import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { recordSnapshot, ensureSchema } from '../src/archive';
globalThis.fetch = async () => { throw new Error('Tests must not call external sources'); };

export function memoryD1() {
  const sqlite = new DatabaseSync(':memory:');
  let failBatch = false;
  const wrap = (sql: string, args: unknown[] = []): any => ({
    bind: (...values: unknown[]) => wrap(sql, values),
    all: async () => ({ results: sqlite.prepare(sql).all(...args as any[]) }),
    first: async () => sqlite.prepare(sql).get(...args as any[]) ?? null,
    run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args as any[]).changes) } }),
    sql, args,
  });
  const db: any = {
    prepare: (sql: string) => wrap(sql),
    exec: async (sql: string) => { sqlite.exec(sql); return {}; },
    batch: async (stmts: any[]) => {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const [i, s] of stmts.entries()) {
          if (failBatch && i === 1) throw new Error('fixture database failure');
          out.push(await s.run());
        }
        sqlite.exec('COMMIT'); return out;
      } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
  return { db, sqlite, setFailBatch: () => { failBatch = true; } };
}
const symbols = ['BTC','ETH','XRP','SOL','DOGE','USDT'];
export const report = (syms = symbols): any => ({
  as_of:'2026-11-12T00:00:00.000Z',usdkrw_official:1400,usdkrw_official_source:'frankfurter.dev (ECB)',
  fx_as_of:'2026-11-11',fx_fetched_at:'2026-11-11T23:59:59.000Z',usdkrw_usdt:1410,
  usdt_as_of:'2026-11-11T23:59:58.000Z',usdt_fetched_at:'2026-11-11T23:59:59.000Z',
  entries:syms.map(ticker=>({ticker,upbit_krw:1400,global_usd:1,global_usd_source:'coinbase-exchange',premium_official_pct:0,premium_usdt_pct:-0.709,
    upbit_as_of:'2026-11-11T23:59:58.000Z',upbit_fetched_at:'2026-11-11T23:59:59.000Z',global_as_of:'2026-11-11T23:59:57.000Z',global_fetched_at:'2026-11-11T23:59:59.000Z'})),
});
test('snapshot stores provenance and run without changing legacy columns',async()=>{
  const {db,sqlite}=memoryD1(); await ensureSchema(db);
  assert.equal(await recordSnapshot(db,{loadReport:async()=>report(),scheduledAt:1794441600000}),6);
  const p:any=sqlite.prepare('SELECT * FROM premium_snapshot_sources WHERE symbol=?').get('BTC');
  assert.equal(p.global_provider,'coinbase-exchange');assert.equal(p.fx_as_of,'2026-11-11');
  const r:any=sqlite.prepare('SELECT * FROM collector_runs').get();assert.equal(r.status,'success');assert.equal(r.rows_written,6);
  assert.equal(JSON.parse(r.observed_json).length,6);sqlite.close();
});
test('existing observations stay unknown and duplicate replay writes zero',async()=>{
  const {db,sqlite}=memoryD1();await ensureSchema(db);
  sqlite.exec("INSERT INTO premium_snapshots VALUES (1794441600,'BTC',42,1,1400,1410,0,0)");
  assert.equal(await recordSnapshot(db,{loadReport:async()=>report()}),5);
  assert.equal(sqlite.prepare("SELECT upbit_krw n FROM premium_snapshots WHERE symbol='BTC'").get()?.n,42);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM premium_snapshot_sources WHERE symbol='BTC'").get()?.n,0);
  assert.equal(await recordSnapshot(db,{loadReport:async()=>report()}),0);sqlite.close();
});
test('partial, empty and upstream failure remain distinguishable',async()=>{
  const {db,sqlite}=memoryD1();await ensureSchema(db);
  await recordSnapshot(db,{loadReport:async()=>report(['BTC'])});
  assert.equal(sqlite.prepare('SELECT status FROM collector_runs').get()?.status,'partial');
  assert.equal(await recordSnapshot(db,{loadReport:async()=>report([])}),0);
  await assert.rejects(recordSnapshot(db,{loadReport:async()=>{throw new Error('private upstream URL');}}));
  const statuses=sqlite.prepare('SELECT status,error_code FROM collector_runs ORDER BY rowid').all();
  assert.deepEqual(statuses.map((x:any)=>x.status),['partial','failure','failure']);
  assert.ok(!JSON.stringify(statuses).includes('private'));sqlite.close();
});
test('batch failure rolls back prices and sidecars and marks failed run',async()=>{
  const {db,sqlite,setFailBatch}=memoryD1();await ensureSchema(db);setFailBatch();
  await assert.rejects(recordSnapshot(db,{loadReport:async()=>report()}));
  assert.equal(sqlite.prepare('SELECT count(*) n FROM premium_snapshots').get()?.n,0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM premium_snapshot_sources').get()?.n,0);
  assert.equal(sqlite.prepare('SELECT status FROM collector_runs').get()?.status,'failure');sqlite.close();
});
