import test from 'node:test';
import assert from 'node:assert/strict';
import { getGlobalUsdPrice } from '../src/sources/global';
import { validTimestamp } from '../src/collection';

test('source adapter preserves Coinbase trade timestamp and actual fetch timestamp',async()=>{
 const prior=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({price:'2',time:'2026-11-12T00:01:02Z'}));
 try {const q=await getGlobalUsdPrice('FIXTURE_A');assert.equal(q?.source_as_of,'2026-11-12T00:01:02.000Z');assert.equal(q?.source,'coinbase-exchange');assert.ok(q?.fetched_at);}
 finally {globalThis.fetch=prior;}
});
test('Kraken fallback records provider without inventing a last-trade timestamp',async()=>{
 const prior=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return calls===1?new Response('',{status:503}):new Response(JSON.stringify({result:{X:{c:['3','1']}}}));};
 try {const q=await getGlobalUsdPrice('FIXTURE_B');assert.equal(q?.source,'kraken');assert.equal(q?.source_as_of,null);assert.equal(calls,2);}
 finally {globalThis.fetch=prior;}
});
test('unknown timestamp stays null and a cached quote retains its fetch time',async()=>{
 assert.equal(validTimestamp('2026-11-12'),null);assert.equal(validTimestamp('invalid'),null);
 const prior=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({price:'4',time:'invalid'}));};
 try {const a=await getGlobalUsdPrice('FIXTURE_C'),b=await getGlobalUsdPrice('FIXTURE_C');assert.equal(a?.source_as_of,null);assert.equal(a?.fetched_at,b?.fetched_at);assert.equal(calls,1);}
 finally {globalThis.fetch=prior;}
});
