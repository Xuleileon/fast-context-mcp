import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { diagnostic, requestSignal, lastUpstreamError } from './reliability.mjs';

const exec = promisify(execFile);
const fingerprint = key => createHash('sha256').update(key).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

export async function loadWamAccounts(executable = process.env.FC_WAM_EXE) {
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
  } catch {
    // execFile errors can contain credential-bearing stdout. Never propagate them.
    throw fail('WAM_UNAVAILABLE: open WAM and log in, then refresh account information');
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
        return !excluded.has(a.fingerprint) && !s?.blocked && !(s?.cooldownUntil > now);
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
  async run(accounts, task, { getFailure = () => undefined, signal } = {}) {
    const excluded = new Set();
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const account = this.select(accounts, excluded);
      let result, error;
      try { result = await task(account.apiKey); } catch (e) { error = e; }
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
    }
  }
}

let pool;
export async function withWamAccount(task) {
  if (!process.env.FC_WAM_EXE) return task(undefined);
  pool ||= new AccountPool({ file: process.env.FC_WAM_STATE_FILE || join(process.env.LOCALAPPDATA || process.cwd(), 'fast-context-mcp', 'account-state.json') });
  const accounts = await loadWamAccounts();
  return pool.run(accounts, key => { lastUpstreamError(true); return task(key); }, { getFailure: lastUpstreamError, signal: requestSignal(110000) });
}
