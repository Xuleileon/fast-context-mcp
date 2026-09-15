import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountPool, classifyFailure, loadWamAccounts, resolveWamExecutable, withWamAccount } from '../src/wam-accounts.mjs';
import { runSearch, lastUpstreamError } from '../src/reliability.mjs';
import { searchWithContent } from '../src/core.mjs';
import { connectFrameEncode, ProtobufEncoder } from '../src/protobuf.mjs';
const accounts = [{ accountId: 'a', apiKey: 'fake-a' }, { accountId: 'b', apiKey: 'fake-b' }];
const quiet = () => {};
test('missing launcher environment discovers installed WAM without overriding explicit credentials', () => {
  const env = { LOCALAPPDATA: 'C:/fixture' };
  const installed = join(env.LOCALAPPDATA, 'Programs', 'WindsurfAccountManager', 'windsurf-account-manager.exe');
  assert.equal(resolveWamExecutable(env, 'win32', p => p === installed), installed);
  assert.equal(resolveWamExecutable(env, 'win32', () => false), undefined);
  assert.equal(resolveWamExecutable(env, 'linux', () => true), undefined);
  assert.equal(resolveWamExecutable({ ...env, WINDSURF_API_KEY: 'explicit' }, 'win32', () => true), undefined);
  assert.equal(resolveWamExecutable({ ...env, FC_WAM_EXE: 'custom.exe', WINDSURF_API_KEY: 'explicit' }, 'win32', () => false), 'custom.exe');
});
test('oldest healthy account selected and cooldown skipped', () => {
  let now = 1000;
  const pool = new AccountPool({ now: () => now, log: quiet });
  const a = pool.select(accounts); now++;
  assert.equal(a.accountId, 'a');
  const b = pool.select(accounts); now++;
  assert.equal(b.accountId, 'b');
  pool.report(a, 'network');
  assert.equal(pool.select(accounts).accountId, 'b');
  now += 31000;
  assert.equal(pool.select(accounts).accountId, 'a');
});
test('network failover occurs once with same query task; success is never replayed', async () => {
  const pool = new AccountPool({ log: quiet });
  const calls = [];
  const result = await pool.run(accounts, async key => {
    calls.push(key);
    if (calls.length === 1) throw Object.assign(new Error('network'), { status: 503 });
    return 'Found file';
  }, { getFailure: () => ({ status: 503 }) });
  assert.equal(result, 'Found file');
  assert.deepEqual(calls, ['fake-a', 'fake-b']);
});
test('resource exhaustion rotates once and persists only the affected account cooldown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-pool-'));
  try {
    const file = join(dir, 'state.json');
    const pool = new AccountPool({ file, now: () => 1000, log: quiet });
    const calls = [];
    assert.equal(await pool.run(accounts, async key => {
      calls.push(key);
      if (key === 'fake-a') throw Object.assign(new Error('limited'), { rpcCode: 'resource_exhausted', retryAfterMs: 120000 });
      return 'Found file';
    }), 'Found file');
    assert.deepEqual(calls, ['fake-a', 'fake-b']);
    const restored = new AccountPool({ file, now: () => 62000, log: quiet });
    assert.equal(restored.select(accounts).accountId, 'b');
    assert.throws(() => restored.select([accounts[0]]), /NO_READY_ACCOUNT/);
    const expired = new AccountPool({ file, now: () => 121000, log: quiet });
    assert.equal(expired.select(accounts).accountId, 'a');
    assert.equal(readFileSync(file, 'utf8').includes('fake-'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('permission/auth failure cannot hop to another account', async () => {
  for (const status of [401, 403]) {
    const pool = new AccountPool({ log: quiet }); let calls = 0;
    await assert.rejects(pool.run(accounts, async () => { calls++; throw { status }; }));
    assert.equal(calls, 1);
  }
});
test('successful result ignores recovered upstream error', async () => {
  let calls = 0;
  const pool = new AccountPool({ log: quiet });
  assert.equal(await pool.run(accounts, async () => { calls++; return 'Found file'; }, { getFailure: () => ({ status: 503 }) }), 'Found file');
  assert.equal(calls, 1);
});
test('bridge error does not expose subprocess output', async () => {
  await assert.rejects(loadWamAccounts('nonexistent-wam-test.exe'), /WAM_UNAVAILABLE/);
  assert.equal(classifyFailure(undefined, 'Error: Rate limited, please try again later'), 'limited');
});

test('configured WAM failure never silently falls back to a single credential', async () => {
  const previous = process.env.FC_WAM_EXE;
  process.env.FC_WAM_EXE = 'nonexistent-wam-test.exe';
  let called = false;
  try {
    await assert.rejects(withWamAccount(() => { called = true; }), /WAM_UNAVAILABLE/);
    assert.equal(called, false);
  } finally {
    if (previous === undefined) delete process.env.FC_WAM_EXE;
    else process.env.FC_WAM_EXE = previous;
  }
});

test('wrapped HTTP auth and quota errors retain classification', () => {
  assert.equal(classifyFailure({code:'AUTH_ERROR',details:{status:401}}), 'auth');
  assert.equal(classifyFailure({code:'AUTH_ERROR',details:{status:403}}), 'denied');
  assert.equal(classifyFailure({code:'RATE_LIMITED',details:{status:429}}), 'limited');
});

test('quota error variants rotate and log the limited reason', async () => {
  for (const failure of [{ status: 429 }, { details: { status: 429 } }, { details: { rpcCode: 'resource_exhausted' } }]) {
    const events = [];
    const pool = new AccountPool({ log: (event, fields) => events.push({ event, ...fields }) });
    const calls = [];
    assert.equal(await pool.run(accounts, async key => {
      calls.push(key);
      if (key === 'fake-a') throw failure;
      return 'Found file';
    }), 'Found file');
    assert.deepEqual(calls, ['fake-a', 'fake-b']);
    assert.ok(events.some(e => e.event === 'account_failover' && e.reason === 'limited'));
  }
});
test('error strings rotate while successful content mentioning exhaustion does not', async () => {
  for (const message of ['Error: resource_exhausted', 'Error: Rate limited, please try again later', 'Error: upstream failure']) {
    const pool = new AccountPool({ log: quiet });
    const calls = [];
    assert.equal(await pool.run(accounts, async key => {
      calls.push(key);
      return key === 'fake-a' ? message : 'Found resource_exhausted handler';
    }, { getFailure: () => ({ rpcCode: 'resource_exhausted' }) }), 'Found resource_exhausted handler');
    assert.deepEqual(calls, ['fake-a', 'fake-b']);
  }
});
test('persistent exhaustion tries at most two accounts and cools each for at least 60 seconds', async () => {
  let now = 1000;
  const pool = new AccountPool({ now: () => now, log: quiet });
  const calls = [];
  const error = Object.assign(new Error('limited'), { rpcCode: 'resource_exhausted' });
  const three = [...accounts, { accountId: 'c', apiKey: 'fake-c' }];
  await assert.rejects(pool.run(three, async key => { calls.push(key); throw error; }), e => e === error);
  assert.deepEqual(calls, ['fake-a', 'fake-b']);
  now = 60999;
  assert.throws(() => pool.select(accounts), /NO_READY_ACCOUNT/);
  assert.equal(pool.select(three).accountId, 'c');
  now = 61000;
  assert.equal(pool.select(accounts).accountId, 'a');
});
test('exhaustion without a ready alternative preserves the original failure', async () => {
  const pool = new AccountPool({ log: quiet });
  pool.report(pool.select([accounts[1]]), 'denied');
  const error = Object.assign(new Error('limited'), { rpcCode: 'resource_exhausted' });
  let calls = 0;
  await assert.rejects(pool.run(accounts, async () => { calls++; throw error; }), e => e === error);
  assert.equal(calls, 1);
});
test('cancellation prevents quota failover', async () => {
  const pool = new AccountPool({ log: quiet });
  const controller = new AbortController();
  let calls = 0;
  const error = Object.assign(new Error('limited'), { rpcCode: 'resource_exhausted' });
  await assert.rejects(pool.run(accounts, async () => {
    calls++; controller.abort(); throw error;
  }, { signal: controller.signal }), e => e === error);
  assert.equal(calls, 1);
});
test('real search retries Connect exhaustion then rotates through the error-string boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-wam-search-'));
  writeFileSync(join(root, 'index.ts'), 'export const value = 1;');
  const original = globalThis.fetch;
  let streamCalls = 0;
  const calls = [];
  const events = [];
  const pool = new AccountPool({ log: (event, fields) => events.push({ event, ...fields }) });
  globalThis.fetch = async url => {
    if (String(url).endsWith('GetUserJwt')) return new Response(new ProtobufEncoder().writeString(1, 'eyJtest.fake.jwt').toBuffer());
    if (!String(url).endsWith('GetDevstralStream')) return new Response(Buffer.alloc(0));
    streamCalls++;
    if (calls.at(-1) === 'fake-a') return new Response(connectFrameEncode(Buffer.from(JSON.stringify({
      error: { code: 'resource_exhausted', message: 'private upstream detail' },
    })), false));
    return new Response(Buffer.alloc(0));
  };
  try {
    const result = await runSearch(() => pool.run(accounts, key => {
      calls.push(key);
      lastUpstreamError(true);
      return searchWithContent({ query: 'wam-exhaustion-contract', projectRoot: root, apiKey: key, maxTurns: 1 });
    }, { getFailure: lastUpstreamError }));
    assert.deepEqual(calls, ['fake-a', 'fake-b']);
    assert.equal(streamCalls, 4);
    assert.doesNotMatch(result, /^Error/);
    assert.ok(events.some(e => e.event === 'account_failover' && e.reason === 'limited'));
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});
