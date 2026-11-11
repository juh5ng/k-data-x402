import { startCollection, failCollection } from './collection';

export interface DartConfig { DART_ENABLED?: string; DART_API_KEY?: string; DART_CORP_CODES?: string }
interface Filing { corp_code: string; stock_code: string | null; report_name: string; receipt_no: string; publication_date: string }
export class DartError extends Error { constructor(public code: string) { super(code); } }
const DART_SCHEMA = "CREATE TABLE IF NOT EXISTS dart_filing_observations (event_id TEXT PRIMARY KEY,receipt_no TEXT NOT NULL,corp_code TEXT NOT NULL,stock_code TEXT,report_name TEXT NOT NULL,publication_date TEXT NOT NULL,published_at TEXT,publication_precision TEXT NOT NULL DEFAULT 'date',first_observed_at TEXT NOT NULL,payload_hash TEXT NOT NULL,revision_no INTEGER NOT NULL,previous_event_id TEXT,source_url TEXT NOT NULL,run_id TEXT NOT NULL,schema_version INTEGER NOT NULL DEFAULT 1,UNIQUE(receipt_no,revision_no))";

function dateOnly(value: unknown): string {
  if(typeof value!=='string'||!/^\d{8}$/.test(value)) throw new DartError('dart_invalid_date');
  const date=`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
  const parsed=Date.parse(date+'T00:00:00Z');
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==date) throw new DartError('dart_invalid_date');
  return date;
}
function normalize(row: any, corpCode: string): Filing {
  if(!row||row.corp_code!==corpCode||typeof row.rcept_no!=='string'||!/^\d{14}$/.test(row.rcept_no)
    ||typeof row.report_nm!=='string'||!row.report_nm.trim()||row.report_nm.length>1000
    ||(row.stock_code && !/^\d{6}$/.test(row.stock_code))) throw new DartError('dart_invalid_record');
  return {corp_code:corpCode,stock_code:row.stock_code||null,report_name:row.report_nm,receipt_no:row.rcept_no,publication_date:dateOnly(row.rcept_dt)};
}
function kstDate(ms: number) { return new Date(ms+9*3600_000).toISOString().slice(0,10).replaceAll('-',''); }

/** Internal-only collector. No new public API or cron is enabled by this module. */
export async function runDartTick(db: D1Database, config: DartConfig, deps: {fetcher?: typeof fetch; now?:()=>number; maxPages?:number; scheduledAt?:number} = {}) {
  if(config.DART_ENABLED!=='true') return {enabled:false,inserted:0,truncated:false};
  const codes=[...new Set((config.DART_CORP_CODES??'').split(',').map(x=>x.trim()).filter(Boolean))];
  if(!config.DART_API_KEY||!/^[a-zA-Z0-9]{40}$/.test(config.DART_API_KEY)||!codes.length||codes.length>10||codes.some(c=>!/^\d{8}$/.test(c))) throw new DartError('dart_invalid_configuration');
  const maxPages=deps.maxPages??3;
  if(!Number.isInteger(maxPages)||maxPages<1||maxPages>3)throw new DartError('dart_invalid_configuration');
  const now=deps.now??Date.now, fetcher=deps.fetcher??fetch;
  const begun=now(),endDate=kstDate(begun);
  await db.exec(DART_SCHEMA);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_dart_corp_date ON dart_filing_observations(corp_code,publication_date)');
  await db.exec('CREATE TABLE IF NOT EXISTS dart_filing_state (receipt_no TEXT PRIMARY KEY,event_id TEXT NOT NULL,payload_hash TEXT NOT NULL,revision_no INTEGER NOT NULL,observed_at TEXT NOT NULL)');
  await db.exec('CREATE TABLE IF NOT EXISTS dart_collector_coverage (corp_code TEXT PRIMARY KEY,covered_through_date TEXT NOT NULL,run_id TEXT NOT NULL)');
  const run=await startCollection(db,'dart',codes,deps.scheduledAt);
  const records:{row:Filing;observedAt:string}[]=[],observed:string[]=[];
  let truncated=false;
  let catchUpPending=false;
  const completeRanges:{code:string;end:string}[]=[];
  try {
    for(const code of codes) {
      const watermark=await db.prepare('SELECT covered_through_date FROM dart_collector_coverage WHERE corp_code=?').bind(code).first<{covered_through_date:string}>();
      // Resume the last fully searched date with one overlapping day. First
      // run covers seven calendar days; long outages catch up in bounded windows.
      const startMs=watermark?Date.parse(dateOnly(watermark.covered_through_date)+'T00:00:00Z')-86400_000:Date.parse(dateOnly(endDate)+'T00:00:00Z')-6*86400_000;
      const beginDate=new Date(startMs).toISOString().slice(0,10).replaceAll('-','');
      if(beginDate>endDate)throw new DartError('dart_invalid_watermark');
      const windowEnd=new Date(Math.min(startMs+6*86400_000,Date.parse(dateOnly(endDate)+'T00:00:00Z'))).toISOString().slice(0,10).replaceAll('-','');
      let rangeComplete=true,expectedPages:number|undefined;
      for(let page=1;page<=maxPages;page++) {
        const url=new URL('https://opendart.fss.or.kr/api/list.json');
        url.search=new URLSearchParams({crtfc_key:config.DART_API_KEY,corp_code:code,bgn_de:beginDate,end_de:windowEnd,last_reprt_at:'N',page_no:String(page),page_count:'100',sort:'date',sort_mth:'asc'}).toString();
        let response:Response;
        try { response=await fetcher(url.toString(),{signal:AbortSignal.timeout(12000),redirect:'error',headers:{accept:'application/json'}}); }
        catch { throw new DartError('dart_transport_failure'); }
        if(!response.ok) throw new DartError(`dart_http_${response.status}`);
        let body:any;
        try { body=await response.json(); } catch { throw new DartError('dart_invalid_response'); }
        if(body.status==='013') {
          if(page!==1)throw new DartError('dart_inconsistent_pagination');
          break;
        }
        if(body.status!=='000') throw new DartError(/^\d{3}$/.test(body.status)?`dart_api_${body.status}`:'dart_invalid_response');
        if(!Array.isArray(body.list)||!body.list.length||body.list.length>100||!Number.isInteger(body.total_page)||body.total_page<1
          ||(body.page_no!==undefined&&Number(body.page_no)!==page)) throw new DartError('dart_invalid_response');
        if(expectedPages!==undefined&&expectedPages!==body.total_page)throw new DartError('dart_inconsistent_pagination');
        expectedPages=body.total_page;
        const observedAt=new Date(now()).toISOString();
        for(const raw of body.list) records.push({row:normalize(raw,code),observedAt});
        if(page>=body.total_page)break;
        if(page===maxPages){truncated=true;rangeComplete=false;}
      }
      observed.push(code);
      if(rangeComplete){completeRanges.push({code,end:windowEnd});if(windowEnd<endDate)catchUpPending=true;}
    }
    const stmts:D1PreparedStatement[]=[];
    for(const {row,observedAt} of records){
      const bytes=new TextEncoder().encode(JSON.stringify(row));
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      const hash=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');
      const id=`${row.receipt_no}:${crypto.randomUUID()}`;
      // Compare the latest state, not all historical hashes: A -> B -> A is
      // three observations. An older concurrent response cannot rewind state.
      stmts.push(db.prepare("INSERT INTO dart_filing_observations (event_id,receipt_no,corp_code,stock_code,report_name,publication_date,first_observed_at,payload_hash,revision_no,previous_event_id,source_url,run_id) SELECT ?,?,?,?,?,?,?,?,COALESCE((SELECT revision_no+1 FROM dart_filing_state WHERE receipt_no=?),1),(SELECT event_id FROM dart_filing_state WHERE receipt_no=?),?,? WHERE NOT EXISTS (SELECT 1 FROM dart_filing_state WHERE receipt_no=? AND payload_hash=?) AND COALESCE((SELECT observed_at FROM dart_filing_state WHERE receipt_no=?),'')<=?")
        .bind(id,row.receipt_no,row.corp_code,row.stock_code,row.report_name,row.publication_date,observedAt,hash,row.receipt_no,row.receipt_no,`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${row.receipt_no}`,run.id,row.receipt_no,hash,row.receipt_no,observedAt));
      stmts.push(db.prepare("INSERT INTO dart_filing_state (receipt_no,event_id,payload_hash,revision_no,observed_at) SELECT receipt_no,event_id,payload_hash,revision_no,first_observed_at FROM dart_filing_observations WHERE event_id=? ON CONFLICT(receipt_no) DO UPDATE SET event_id=excluded.event_id,payload_hash=excluded.payload_hash,revision_no=excluded.revision_no,observed_at=excluded.observed_at").bind(id));
      // Even an identical payload is evidence that this state was still current
      // at a later fetch time. Preserve that freshness watermark without adding
      // a duplicate version, so an older concurrent response cannot win later.
      stmts.push(db.prepare('UPDATE dart_filing_state SET observed_at=? WHERE receipt_no=? AND payload_hash=? AND observed_at<?').bind(observedAt,row.receipt_no,hash,observedAt));
    }
    for(const range of completeRanges)stmts.push(db.prepare("INSERT INTO dart_collector_coverage (corp_code,covered_through_date,run_id) VALUES (?,?,?) ON CONFLICT(corp_code) DO UPDATE SET covered_through_date=excluded.covered_through_date,run_id=excluded.run_id WHERE excluded.covered_through_date>dart_collector_coverage.covered_through_date").bind(range.code,range.end,run.id));
    stmts.push(db.prepare("UPDATE collector_runs SET completed_at=?,observed_json=?,status=?,error_code=?,rows_written=(SELECT COUNT(*) FROM dart_filing_observations WHERE run_id=?) WHERE run_id=?")
      .bind(new Date(now()).toISOString(),JSON.stringify(observed),truncated||catchUpPending?'partial':'success',truncated?'page_limit':catchUpPending?'catch_up_pending':null,run.id,run.id));
    // D1 may limit the size of a batch; fail atomically instead of silently
    // accepting an incomplete run. Pilot cap stays at 10 corps x 3 x 100 rows.
    const result=await db.batch(stmts);
    return {enabled:true,inserted:result.slice(0,records.length*3).reduce((s,r,i)=>s+(i%3===0?r.meta.changes??0:0),0),truncated,catch_up_pending:catchUpPending};
  } catch(error) {
    const code=error instanceof DartError?error.code:'dart_storage_failure';
    await failCollection(db,run.id,code);
    throw new DartError(code);
  }
}
