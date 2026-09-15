import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountPool, classifyFailure, loadWamAccounts } from '../src/wam-accounts.mjs';
const accounts = [{ accountId: 'a', apiKey: 'fake-a' }, { accountId: 'b', apiKey: 'fake-b' }];
const quiet = () => {};
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
test('resource exhausted is not replayed and cooldown persists without secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-pool-'));
  try {
    const file = join(dir, 'state.json');
    const pool = new AccountPool({ file, now: () => 1000, log: quiet });
    let calls = 0;
    await assert.rejects(pool.run(accounts, async () => {
      calls++;
      throw Object.assign(new Error('limited'), { rpcCode: 'resource_exhausted', retryAfterMs: 120000 });
    }));
    assert.equal(calls, 1);
    const restored = new AccountPool({ file, now: () => 62000, log: quiet });
    assert.throws(() => restored.select(accounts), /COOLING_DOWN/);
    assert.equal(readFileSync(file, 'utf8').includes('fake-'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('permission/auth failure cannot hop to another account', async () => {
  for (const status of [401, 403, 429]) {
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
