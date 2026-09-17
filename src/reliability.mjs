import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const context = new AsyncLocalStorage();
export class Semaphore {
  constructor(limit, maxWaiting = 8) { this.limit = limit; this.maxWaiting = maxWaiting; this.active = 0; this.waiters = []; }
  async acquire(signal) {
    signal?.throwIfAborted();
    if (this.active < this.limit) { this.active++; return this.releaseHandle(); }
    if (this.waiters.length >= this.maxWaiting) throw Object.assign(new Error('Search queue full; use local search.'), { code: 'QUEUE_FULL' });
    return new Promise((resolve, reject) => {
      const waiter = { resolve, signal, abort: () => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(signal.reason);
      }};
      this.waiters.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
  }
  releaseHandle() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.signal?.removeEventListener('abort', waiter.abort);
        waiter.resolve(this.releaseHandle());
      } else this.active--;
    };
  }
}
const searches = new Semaphore(3);
export function searchContext(task, state) { return context.run(state, task); }
export function currentRequest() { return context.getStore(); }
export function recordUpstreamError(error) { const state = context.getStore(); if (state) state.lastError = error; }

// Fixed fields only: never log query, paths, credentials, payloads or error messages.
export function diagnostic(event, fields = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), event,
    requestId: context.getStore()?.id, ...fields }) + '\n';
  process.stderr.write(line);
  const file = process.env.FC_LOG_FILE;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    try { if (statSync(file).size > 5 * 1024 * 1024) renameSync(file, file + '.1'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    appendFileSync(file, line);
  } catch { process.stderr.write('{"event":"log_write_failed"}\n'); }
}

export function lastUpstreamError(clear = false) {
  const state = context.getStore();
  const error = state?.lastError;
  if (clear && state) state.lastError = undefined;
  return error;
}

export function requestSignal(timeoutMs) {
  const signal = context.getStore()?.signal;
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

export function requireExecutionBudget(deadlineAt = currentRequest()?.deadlineAt, now = Date.now()) {
  if (deadlineAt !== undefined && deadlineAt - now < 10000) {
    throw Object.assign(new Error('Busy: less than 10 seconds remain in the shared search budget; retrieval was not started.'), { code: 'SEARCH_BUDGET_INSUFFICIENT' });
  }
}

export async function runSearch(task, signal) {
  const started = Date.now();
  const deadline = requestSignal(50000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return context.run({ id: randomUUID(), signal: combined, deadlineAt: started + 50000 }, async () => {
    diagnostic('queued', { pending: searches.active + searches.waiters.length + 1 });
    let release;
    try {
      release = await searches.acquire(combined);
      combined.throwIfAborted();
      requireExecutionBudget();
      diagnostic('started', { queueMs: Date.now() - started, active: searches.active });
      const result = await task();
      combined.throwIfAborted();
      diagnostic('finished', { outcome: /^\s*(?:Error\b|\[Error\])/.test(result) ? 'error' : 'success', elapsedMs: Date.now() - started });
      return result;
    } catch (e) {
      if (combined.aborted) {
        const cancelled = signal?.aborted;
        e = Object.assign(new Error(cancelled ? 'Search cancelled by caller.' :
          release ? 'Search execution reached the shared 50-second deadline.' : 'Search queue reached the shared 50-second deadline.'), {
          code: cancelled ? 'SEARCH_CANCELLED' : release ? 'SEARCH_EXECUTION_TIMEOUT' : 'SEARCH_QUEUE_TIMEOUT',
        });
      }
      diagnostic('finished', { outcome: combined.aborted || e.name === 'TimeoutError' ? 'cancelled_or_timeout' : 'error',
        errorCode: /^SEARCH_[A-Z_]+$/.test(e.code || '') ? e.code : undefined, elapsedMs: Date.now() - started });
      throw e;
    } finally { release?.(); }
  });
}

export async function retryRequest(operation, { maxRetries = 2, sleep = delay, random = Math.random } = {}) {
  const state = context.getStore();
  const callId = state ? (state.calls = (state.calls || 0) + 1) : undefined;
  for (let attempt = 0; ; attempt++) {
    const signal = context.getStore()?.signal;
    signal?.throwIfAborted();
    const start = Date.now();
    try {
      const result = await operation();
      diagnostic('upstream', { callId, attempt: attempt + 1, outcome: 'success', elapsedMs: Date.now() - start });
      return result;
    } catch (e) {
      if (state) state.lastError = e;
      const transient = ['resource_exhausted', 'unavailable', 'internal', 'aborted'].includes(e.rpcCode)
        || e.status === 429 || [500, 502, 503, 504].includes(e.status)
        || (e instanceof TypeError && !e.status && !e.rpcCode);
      const retry = transient && attempt < maxRetries && !signal?.aborted;
      diagnostic('upstream', { callId, attempt: attempt + 1, outcome: 'error', status: e.status,
        rpcCode: e.rpcCode, traceId: e.traceId, elapsedMs: Date.now() - start, retry });
      if (!retry) {
        throw e;
      }
      const waitMs = Math.max(e.retryAfterMs || 0, 1000 * 2 ** attempt + Math.floor(random() * 500));
      diagnostic('backoff', { callId, attempt: attempt + 1, waitMs });
      await sleep(waitMs, undefined, { signal });
    }
  }
}
