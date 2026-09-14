import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runSearch, retryRequest, requestSignal } from '../src/reliability.mjs';

test('serialized searches; cancelling middle waiter never lets third overtake first', async () => {
  const order=[]; let release;
  const gate=new Promise(r=>{release=r});
  const first=runSearch(async()=>{order.push('first');await gate;order.push('end');return 'ok'});
  const c=new AbortController();
  const second=runSearch(async()=>{order.push('wrong');return 'ok'},c.signal);
  const rejected=assert.rejects(second);
  const third=runSearch(async()=>{order.push('third');return 'ok'});
  c.abort();await rejected;await delay(10);
  assert.deepEqual(order,['first']);release();await Promise.all([first,third]);
  assert.deepEqual(order,['first','end','third']);
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

test('exhaustion cools down the queue and cooldown remains cancellable',async()=>{
 await assert.rejects(retryRequest(async()=>{throw Object.assign(new Error('quota'),{rpcCode:'resource_exhausted'})},{maxRetries:0}));
 const c=new AbortController();let called=false;
 const p=runSearch(async()=>{called=true;return 'wrong'},c.signal);
 const rejected=assert.rejects(p);await delay(10);c.abort();await rejected;assert.equal(called,false);
});
