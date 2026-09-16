import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runSearch, retryRequest, requestSignal } from '../src/reliability.mjs';

test('three searches overlap; cancelled waiter never executes and slots recover', async () => {
  let release; const gate = new Promise(r => { release = r; });
  let active = 0, maximum = 0;
  const jobs = Array.from({length: 3}, () => runSearch(async () => {
    maximum = Math.max(maximum, ++active); await gate; active--; return 'ok';
  }));
  await delay(10);
  assert.equal(active, 3);
  const c = new AbortController();
  const cancelled = assert.rejects(runSearch(async () => { throw new Error('must not execute'); }, c.signal));
  let fourth = false;
  const next = runSearch(async () => { fourth = true; return 'ok'; });
  c.abort(); await cancelled; await delay(10); assert.equal(fourth, false);
  release(); await Promise.all([...jobs, next]); assert.equal(maximum, 3); assert.equal(fourth, true);
});

test('active cancellation aborts request and releases queue',async()=>{
 const c=new AbortController();
 const p=runSearch(async()=>{await delay(5000,undefined,{signal:requestSignal(5000)});return 'wrong'},c.signal);
 const rejected=assert.rejects(p);await delay(5);c.abort();await rejected;
 assert.equal(await runSearch(async()=>'next'),'next');
});
test('transient failure retries twice with Retry-After respected',async()=>{
 let calls=0;const waits=[];
 const r=await retryRequest(async()=>{if(++calls<3)throw Object.assign(new Error('secret'),{rpcCode:'unavailable',retryAfterMs:4000});return 'ok'},
 {sleep:async ms=>waits.push(ms),random:()=>0});
 assert.equal(r,'ok');assert.equal(calls,3);assert.deepEqual(waits,[4000,4000]);
});
test('authentication and timeout are not retried',async()=>{
 for(const e of [Object.assign(new Error('auth'),{status:401}),Object.assign(new Error('timeout'),{name:'TimeoutError'})]){
  let calls=0;await assert.rejects(retryRequest(async()=>{calls++;throw e}));assert.equal(calls,1);
 }
});
test('persistent transient failure bounded to three attempts',async()=>{
 let calls=0;await assert.rejects(retryRequest(async()=>{calls++;throw Object.assign(new Error('bad'),{status:503})},{sleep:async()=>{},random:()=>0}));
 assert.equal(calls,3);
});
import { search } from '../src/core.mjs';
import { connectFrameEncode } from '../src/protobuf.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real core retries HTTP 200 Connect exhaustion before any tool execution',async()=>{
 const root=mkdtempSync(join(tmpdir(),'fc-retry-'));
 writeFileSync(join(root,'index.ts'),'export const value = 1;');
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async url=>{
  if(!String(url).endsWith('GetDevstralStream'))return new Response(Buffer.alloc(0));
  calls++;
  if(calls===1)return new Response(connectFrameEncode(Buffer.from(JSON.stringify({error:{code:'resource_exhausted',message:'private account detail'}})),false));
  return new Response(Buffer.alloc(0));
 };
 try{
  const result=await search({query:'retry-contract',projectRoot:root,apiKey:'test-key',jwt:'test-jwt',maxTurns:1});
  assert.equal(calls,2);assert.equal(result.error,undefined);
 }finally{globalThis.fetch=original;rmSync(root,{recursive:true,force:true})}
});

test('one exhausted account does not pause unrelated searches', async () => {
 await assert.rejects(retryRequest(async()=>{throw Object.assign(new Error('quota'),{rpcCode:'resource_exhausted'})},{maxRetries:0}));
 assert.equal(await runSearch(async () => 'healthy'), 'healthy');
});
