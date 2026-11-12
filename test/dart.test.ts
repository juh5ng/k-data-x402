import test from 'node:test';
import assert from 'node:assert/strict';
import {runDartTick} from '../src/dart';
import {memoryD1} from './ingestion.test';
const config={DART_ENABLED:'true',DART_API_KEY:'a'.repeat(40),DART_CORP_CODES:'00126380'};
const row={corp_code:'00126380',stock_code:'005930',rcept_no:'20261111000001',report_nm:'분기보고서',rcept_dt:'20261111'};
const response=(rows:any[],pages=1,page=1)=>new Response(JSON.stringify({status:'000',list:rows,total_page:pages,page_no:page}));
test('DART disabled means no requests and no schema writes',async()=>{
 const {db,sqlite}=memoryD1();assert.equal((await runDartTick(db,{}, {fetcher:async()=>{throw Error('must not call');}})).enabled,false);
 assert.equal(sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get()?.n,0);sqlite.close();
});
test('DART preserves all pages, immutable observation time and corrected receipts',async()=>{
 const {db,sqlite}=memoryD1();let called=0;
 const fetcher:typeof fetch=async(url)=>{called++;const u=new URL(String(url));assert.equal(u.searchParams.get('last_reprt_at'),'N');return u.searchParams.get('page_no')==='1'?response([row],2,1):response([{...row,rcept_no:'20261112000002',report_nm:'[정정]분기보고서'}],2,2);};
 const first=await runDartTick(db,config,{fetcher,now:()=>Date.parse('2026-11-12T00:00:00Z')});assert.equal(first.inserted,2);assert.equal(called,2);
 const replay=await runDartTick(db,config,{fetcher,now:()=>Date.parse('2026-11-12T01:00:00Z')});assert.equal(replay.inserted,0);
 const rows=sqlite.prepare('SELECT * FROM dart_filing_observations').all() as any[];
 assert.equal(rows[0].first_observed_at,'2026-11-12T00:00:00.000Z');assert.equal(rows[0].publication_date,'2026-11-11');
 assert.equal(rows[0].published_at,null);assert.equal(rows[1].previous_event_id,null);sqlite.close();
});
test('page cap marks partial; same-receipt metadata changes are separate observations',async()=>{
 const {db,sqlite}=memoryD1();
 assert.equal((await runDartTick(db,config,{fetcher:async()=>response([row],5),maxPages:1})).truncated,true);
 assert.equal(sqlite.prepare('SELECT status FROM collector_runs').get()?.status,'partial');
 await runDartTick(db,config,{fetcher:async()=>response([{...row,report_nm:'정정된 제목'}])});
 assert.equal(sqlite.prepare('SELECT count(*) n FROM dart_filing_observations').get()?.n,2);sqlite.close();
});
test('network errors never leak the API key and incomplete fetch is not committed',async()=>{
 const {db,sqlite}=memoryD1();
 await assert.rejects(runDartTick(db,config,{fetcher:async(url)=>{throw Error(String(url));}}),e=>!String(e).includes(config.DART_API_KEY));
 assert.equal(sqlite.prepare('SELECT error_code FROM collector_runs').get()?.error_code,'dart_transport_failure');sqlite.close();
});
test('invalid key/corp list is rejected before any request or database work',async()=>{
 const {db,sqlite}=memoryD1();await assert.rejects(runDartTick(db,{...config,DART_CORP_CODES:'005930'}),/dart_invalid_configuration/);
 assert.equal(sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get()?.n,0);sqlite.close();
});
test('invalid source date and HTTP/quota failures are explicit',async()=>{
 for(const fetcher of [async()=>response([{...row,rcept_dt:'20260230'}]),async()=>new Response('',{status:429}),async()=>new Response(JSON.stringify({status:'020',message:config.DART_API_KEY}))]){
  const {db,sqlite}=memoryD1();await assert.rejects(runDartTick(db,config,{fetcher}),e=>!String(e).includes(config.DART_API_KEY));
  assert.equal(sqlite.prepare('SELECT count(*) n FROM dart_filing_observations').get()?.n,0);assert.equal(sqlite.prepare('SELECT status FROM collector_runs').get()?.status,'failure');sqlite.close();
 }
});
test('weekday runs resume from successful coverage across weekends and long outages',async()=>{
 const {db,sqlite}=memoryD1();
 const none:typeof fetch=async()=>new Response(JSON.stringify({status:'013'}));
 await runDartTick(db,config,{fetcher:none,now:()=>Date.parse('2026-11-13T08:17:00Z')});
 let begin='';const inspect:typeof fetch=async(url)=>{begin=new URL(String(url)).searchParams.get('bgn_de')!;return none(url);};
 await runDartTick(db,config,{fetcher:inspect,now:()=>Date.parse('2026-11-16T08:17:00Z')});
 assert.ok(begin<='20261113','Monday must overlap Friday coverage');
 await runDartTick(db,config,{fetcher:inspect,now:()=>Date.parse('2026-12-01T08:17:00Z')});
 assert.ok(begin<='20261116','A long outage must resume the watermark, not two days ago');sqlite.close();
});
test('A to B to A transitions are preserved separately from repeated identical observations',async()=>{
 const {db,sqlite}=memoryD1();let offset=0;
 for(const title of ['A','B','A','A'])await runDartTick(db,config,{fetcher:async()=>response([{...row,report_nm:title}]),now:()=>Date.parse('2026-11-12T00:00:00Z')+(offset++)*1000});
 const rows=sqlite.prepare('SELECT report_name,revision_no FROM dart_filing_observations ORDER BY rowid').all() as any[];
 assert.deepEqual(rows.map(r=>r.report_name),['A','B','A']);assert.deepEqual(rows.map(r=>r.revision_no),[1,2,3]);sqlite.close();
});
test('no-data response after an advertised first page cannot silently commit',async()=>{
 const {db,sqlite}=memoryD1();let page=0;
 await assert.rejects(runDartTick(db,config,{fetcher:async()=>++page===1?response([row],2,1):new Response(JSON.stringify({status:'013'}))}));
 assert.equal(sqlite.prepare('SELECT count(*) n FROM dart_filing_observations').get()?.n,0);
 assert.equal(sqlite.prepare('SELECT status FROM collector_runs').get()?.status,'failure');sqlite.close();
});
test('a later identical observation prevents an older concurrent response from rewinding state',async()=>{
 const {db,sqlite}=memoryD1();
 for(const [title,time] of [['A','2026-11-12T00:00:00Z'],['A','2026-11-12T02:00:00Z'],['B','2026-11-12T01:00:00Z']])
  await runDartTick(db,config,{fetcher:async()=>response([{...row,report_nm:title}]),now:()=>Date.parse(time)});
 assert.equal(sqlite.prepare('SELECT count(*) n FROM dart_filing_observations').get()?.n,1);sqlite.close();
});
