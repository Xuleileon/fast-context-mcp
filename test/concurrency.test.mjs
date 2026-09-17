import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountPool } from '../src/wam-accounts.mjs';
import { workerSearch } from '../src/worker-search.mjs';
import { Semaphore, runSearch, requireExecutionBudget } from '../src/reliability.mjs';

const accounts = ['a', 'b', 'c'].map(accountId => ({ accountId, apiKey: `fake-${accountId}` }));
test('account leases are exclusive across concurrent requests and released on cancellation', async () => {
  const pool = new AccountPool({ log: () => {} });
  let release;
  const gate = new Promise(r => { release = r; });
  const keys = new Set();
  const jobs = accounts.map(() => pool.run(accounts, async key => {
    assert.equal(keys.has(key), false); keys.add(key); await gate; return 'ok';
  }));
  await delay(10); assert.equal(keys.size, 3); assert.equal(pool.busy.size, 3);
  const c = new AbortController(); let called = false;
  const cancelled = assert.rejects(pool.run(accounts, async () => { called = true; }, { signal: c.signal }));
  c.abort(); await cancelled; assert.equal(called, false); assert.equal(pool.waiters.size, 0);
  release(); await Promise.all(jobs); assert.equal(pool.busy.size, 0);
  const active = new AbortController();
  const aborted = pool.run(accounts, async () => {
    active.abort(); return 'ok';
  }, { signal: active.signal });
  await assert.rejects(aborted); assert.equal(pool.busy.size, 0);
  assert.equal(await pool.run(accounts, async () => 'recovered'), 'recovered');
});

test('limited request never steals busy account; waits for healthy lease then fails over once', async () => {
  const pool = new AccountPool({ log: () => {} });
  let release; const gate = new Promise(r => { release = r; });
  const first = pool.run(accounts.slice(0, 2), async key => { assert.equal(key, 'fake-a'); await gate; return 'ok'; });
  await delay(5);
  const calls = [];
  const second = pool.run(accounts.slice(0, 2), async key => {
    calls.push(key);
    if (key === 'fake-b') throw { status: 429 };
    return 'recovered';
  });
  await delay(10); assert.deepEqual(calls, ['fake-b']);
  release(); await first; assert.equal(await second, 'recovered');
  assert.deepEqual(calls, ['fake-b', 'fake-a']); assert.equal(pool.busy.size, 0);
});

test('queue admission is bounded and cancelled waiter does not consume a permit', async () => {
  const semaphore = new Semaphore(1, 1);
  const release = await semaphore.acquire();
  const c = new AbortController();
  const waiting = assert.rejects(semaphore.acquire(c.signal));
  await assert.rejects(semaphore.acquire(), { code: 'QUEUE_FULL' });
  c.abort(); await waiting; release();
  const next = await semaphore.acquire(); assert.equal(semaphore.active, 1); next(); next();
  assert.equal(semaphore.active, 0);
});

test('CPU-blocked worker cannot block cancellation or an independent result', async () => {
  const blocked = new URL('data:text/javascript,while(true){}');
  const fast = new URL('data:text/javascript,import {parentPort} from "node:worker_threads";parentPort.postMessage({result:"ok"})');
  const controller = new AbortController();
  const started = Date.now();
  const cancelled = assert.rejects(workerSearch({}, { url: blocked, signal: controller.signal }));
  assert.equal(await workerSearch({}, { url: fast }), 'ok');
  controller.abort(); await cancelled;
  assert.ok(Date.now() - started < 3000);
});

test('fourth request survives more than ten seconds of queuing and starts after release', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const jobs = Array.from({ length: 3 }, () => runSearch(async () => { await gate; return 'ok'; }));
  await delay(10);
  let fourthStarted = false;
  const fourth = runSearch(async () => { fourthStarted = true; return 'fourth'; });
  try {
    await delay(10500);
    assert.equal(fourthStarted, false);
  } finally { release(); }
  assert.equal(await fourth, 'fourth');
  await Promise.all(jobs);
});

test('insufficient remaining budget rejects before starting retrieval', () => {
  assert.throws(() => requireExecutionBudget(49999, 40000), { code: 'SEARCH_BUDGET_INSUFFICIENT' });
  assert.doesNotThrow(() => requireExecutionBudget(50000, 40000));
});
