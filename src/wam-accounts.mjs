import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { diagnostic, requestSignal, lastUpstreamError, Semaphore, requireExecutionBudget } from './reliability.mjs';

const exec = promisify(execFile);
const fingerprint = key => createHash('sha256').update(key).digest('hex');
const fail = (code, message = code) => Object.assign(new Error(message), { code });

export function resolveWamExecutable(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.FC_WAM_EXE?.trim()) return env.FC_WAM_EXE;
  // Preserve explicit single-key setups; otherwise prefer the installed account manager.
  if (env.WINDSURF_API_KEY?.trim() || platform !== 'win32' || !env.LOCALAPPDATA) return undefined;
  const installed = join(env.LOCALAPPDATA, 'Programs', 'WindsurfAccountManager', 'windsurf-account-manager.exe');
  return exists(installed) ? installed : undefined;
}

export async function loadWamAccounts(executable = resolveWamExecutable()) {
  if (!executable) throw fail('WAM_NOT_CONFIGURED');
  try {
    const { stdout } = await exec(executable, ['--fast-context-credential'], {
      windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
      signal: requestSignal(10000),
    });
    const data = JSON.parse(stdout);
    if (!Array.isArray(data.accounts)) throw fail('WAM_INVALID_RESPONSE');
    const seen = new Set();
    return data.accounts.filter(a => {
      if (typeof a.accountId !== 'string' || !/^[0-9a-f-]{36}$/i.test(a.accountId)
          || typeof a.apiKey !== 'string' || !a.apiKey.trim()) return false;
      const id = fingerprint(a.apiKey);
      if (seen.has(id)) return false;
      seen.add(id); return true;
    });
  } catch (error) {
    let reason;
    try {
      const code = JSON.parse(error.stdout).error;
      if (['WAM_DATA_NOT_FOUND', 'WAM_STORAGE_ERROR', 'WAM_DATA_CONFIG_ERROR'].includes(code)) reason = code;
    } catch {}
    diagnostic('wam_bridge_error', { code: typeof error.code === 'number' ? error.code :
      ['ENOENT', 'EACCES', 'ABORT_ERR', 'WAM_INVALID_RESPONSE'].includes(error.code) ? error.code : 'BRIDGE_FAILED', reason,
      appDataPresent: !!process.env.APPDATA,
      databaseExists: !!process.env.APPDATA && existsSync(join(process.env.APPDATA, 'com.chao.windsurf-account-manager', 'accounts.db')) });
    // execFile errors can contain credential-bearing stdout. Never propagate them.
    if (reason === 'WAM_DATA_CONFIG_ERROR') {
      throw fail(reason, 'The configured WAM data directory is unavailable or invalid. Restore access to the existing account database; no fallback store was created.');
    }
    if (reason === 'WAM_DATA_NOT_FOUND') {
      throw fail(reason, 'WAM account database is not visible to the MCP process. Check the Windows user/profile and the gateway launcher environment.');
    }
    if (reason === 'WAM_STORAGE_ERROR') {
      throw fail(reason, 'WAM account storage could not be read. Check database access and the credential store in the same Windows user session.');
    }
    throw fail('WAM_UNAVAILABLE', 'WAM_UNAVAILABLE: the local credential bridge failed to run. Check the installed executable and gateway launcher environment.');
  }
}

export function classifyFailure(error, result) {
  if (!error && !/^\s*(?:Error\b|\[Error\])/.test(result || '')) return null;
  const code = error?.rpcCode || error?.details?.rpcCode;
  const status = error?.status || error?.details?.status;
  const text = typeof result === 'string' ? result : '';
  if (code === 'resource_exhausted' || status === 429 || /error_type=RATE_LIMITED|resource_exhausted|Rate limited/i.test(text)) return 'limited';
  if (code === 'permission_denied' || status === 403) return 'denied';
  if (code === 'unauthenticated' || status === 401 || /error_type=AUTH_ERROR/.test(text)) return 'auth';
  if ([502, 503, 504].includes(status) || code === 'unavailable'
      || (error instanceof TypeError && !status && !code)) return 'network';
  return 'other';
}

export class AccountPool {
  constructor({ file, now = Date.now, log = diagnostic } = {}) {
    this.file = file; this.now = now; this.log = log;
    this.busy = new Set(); this.waiters = new Set();
    this.state = { cooldownUntil: 0, accounts: {} };
    if (file) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (!Number.isFinite(saved.cooldownUntil) || !saved.accounts || typeof saved.accounts !== 'object') throw fail('WAM_STATE_INVALID');
        this.state = saved;
      } catch (e) { if (e.code !== 'ENOENT') throw fail('WAM_STATE_INVALID'); }
    }
  }
  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  select(accounts, excluded = new Set()) {
    const now = this.now();
    if (this.state.cooldownUntil > now) throw fail('WAM_POOL_COOLING_DOWN');
    const candidates = accounts.map(a => ({ ...a, fingerprint: fingerprint(a.apiKey) }))
      .filter(a => {
        const s = this.state.accounts[a.fingerprint];
        return !this.busy.has(a.fingerprint) && !excluded.has(a.fingerprint) && !s?.blocked && !(s?.cooldownUntil > now);
      }).sort((a, b) => (this.state.accounts[a.fingerprint]?.lastUsed || 0) - (this.state.accounts[b.fingerprint]?.lastUsed || 0)
        || a.accountId.localeCompare(b.accountId));
    const chosen = candidates[0];
    if (!chosen) throw fail(accounts.length ? 'WAM_NO_READY_ACCOUNT' : 'WAM_LOGIN_REQUIRED');
    this.state.accounts[chosen.fingerprint] = { ...this.state.accounts[chosen.fingerprint], lastUsed: now };
    this.save();
    this.log('account_selected', { accountId: chosen.accountId });
    return chosen;
  }
  report(account, kind, retryAfterMs = 0) {
    if (!kind) return;
    const state = this.state.accounts[account.fingerprint];
    if (kind === 'denied') state.blocked = true;
    else if (kind === 'auth') state.cooldownUntil = this.now() + 300000;
    else if (kind === 'limited') {
      const until = this.now() + Math.max(60000, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
      state.cooldownUntil = until;
    } else state.cooldownUntil = this.now() + 30000;
    this.save();
    this.log('account_result', { accountId: account.accountId, outcome: kind });
  }
  async acquire(accounts, excluded, signal) {
    while (true) {
      signal?.throwIfAborted();
      try {
        const account = this.select(accounts, excluded);
        this.busy.add(account.fingerprint);
        return account;
      } catch (e) {
        if (e.code !== 'WAM_NO_READY_ACCOUNT' || !accounts.some(a => {
          const id = fingerprint(a.apiKey), state = this.state.accounts[id];
          return !excluded.has(id) && this.busy.has(id) && !state?.blocked && !(state?.cooldownUntil > this.now());
        })) throw e;
      }
      await new Promise((resolve, reject) => {
        const done = () => { this.waiters.delete(done); signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { this.waiters.delete(done); reject(signal.reason); };
        this.waiters.add(done);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
  release(account) {
    this.busy.delete(account.fingerprint);
    for (const wake of [...this.waiters]) wake();
  }
  async run(accounts, task, { getFailure = () => undefined, signal } = {}) {
    const excluded = new Set();
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const account = await this.acquire(accounts, excluded, signal || requestSignal(50000));
      let result, error;
      try {
        signal?.throwIfAborted();
        requireExecutionBudget();
        try { result = await task(account.apiKey); } catch (e) { error = e; }
        if (signal?.aborted) throw error || signal.reason;
        const upstream = error || (/^\s*(?:Error\b|\[Error\])/.test(result || '') ? getFailure() : undefined);
        const kind = classifyFailure(upstream, result);
        this.report(account, kind, upstream?.retryAfterMs);
        // Read-only search only. No replay for permission or authentication errors.
        if (['network', 'limited'].includes(kind) && attempt === 0 && !signal?.aborted) {
          excluded.add(account.fingerprint);
          const ready = accounts.some(a => {
            const id = fingerprint(a.apiKey), s = this.state.accounts[id];
            return !excluded.has(id) && !s?.blocked && !(s?.cooldownUntil > this.now());
          });
          if (ready) { this.log('account_failover', { reason: kind }); continue; }
        }
        if (error) throw error;
        return result;
      } finally { this.release(account); }
    }
  }
}

let pool;
const singleAccount = new Semaphore(1);
export async function withWamAccount(task) {
  const executable = resolveWamExecutable();
  if (!executable) {
    diagnostic('account_mode', { mode: 'single' });
    const release = await singleAccount.acquire(requestSignal(50000));
    try { requireExecutionBudget(); return await task(undefined); } finally { release(); }
  }
  pool ||= new AccountPool({ file: process.env.FC_WAM_STATE_FILE || join(process.env.LOCALAPPDATA || process.cwd(), 'fast-context-mcp', 'account-state.json') });
  const accounts = await loadWamAccounts(executable);
  diagnostic('account_mode', { mode: 'pool', eligibleAccounts: accounts.length });
  return pool.run(accounts, key => { lastUpstreamError(true); return task(key); }, { getFailure: lastUpstreamError, signal: requestSignal(50000) });
}
