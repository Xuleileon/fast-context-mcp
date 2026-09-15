import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const context = new AsyncLocalStorage();
let tail = Promise.resolve();
let pending = 0;
let cooldownUntil = 0;

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

export async function runSearch(task, signal) {
  if (pending >= 8) throw Object.assign(new Error('Search queue full; retry later.'), { code: 'QUEUE_FULL' });
  const started = Date.now();
  const deadline = requestSignal(110000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const previous = tail;
  let release;
  tail = new Promise(resolve => { release = resolve; });
  pending++;
  return context.run({ id: randomUUID(), signal: combined }, async () => {
    diagnostic('queued', { pending });
    let onAbort;
    try {
      await Promise.race([previous, new Promise((_, reject) => {
        onAbort = () => reject(combined.reason);
        combined.addEventListener('abort', onAbort, { once: true });
        if (combined.aborted) onAbort();
      })]);
      combined.throwIfAborted();
      const waitMs = Math.max(0, cooldownUntil - Date.now());
      diagnostic('started', { queueMs: Date.now() - started, cooldownMs: waitMs });
      if (waitMs) await delay(waitMs, undefined, { signal: combined });
      const result = await task();
      combined.throwIfAborted();
      const failed = /^\s*(?:Error\b|\[Error\])/.test(result);
      diagnostic('finished', { outcome: failed ? 'error' : 'success', elapsedMs: Date.now() - started });
      return result;
    } catch (e) {
      diagnostic('finished', { outcome: combined.aborted ? 'cancelled_or_timeout' : 'error', elapsedMs: Date.now() - started });
      throw e;
    } finally {
      combined.removeEventListener('abort', onAbort);
      // A cancelled waiter must not allow successors to overtake the running task.
      previous.finally(release);
      pending--;
    }
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
      const exhausted = e.rpcCode === 'resource_exhausted' || e.status === 429;
      const retry = transient && attempt < maxRetries && !signal?.aborted;
      diagnostic('upstream', { callId, attempt: attempt + 1, outcome: 'error', status: e.status,
        rpcCode: e.rpcCode, traceId: e.traceId, elapsedMs: Date.now() - start, retry });
      if (!retry) {
        if (exhausted) cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.max(30000, e.retryAfterMs || 0));
        throw e;
      }
      const waitMs = Math.max(e.retryAfterMs || 0, 1000 * 2 ** attempt + Math.floor(random() * 500));
      diagnostic('backoff', { callId, attempt: attempt + 1, waitMs });
      await sleep(waitMs, undefined, { signal });
    }
  }
}
