import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { currentRequest, requestSignal, recordUpstreamError } from './reliability.mjs';

export async function workerSearch(options, { url = new URL('./search-worker.mjs', import.meta.url), signal = requestSignal(50000) } = {}) {
  signal.throwIfAborted();
  const worker = new Worker(url, { workerData: {
    options, requestId: currentRequest()?.id,
    remainingMs: Math.max(1, (currentRequest()?.deadlineAt || Date.now() + 50000) - Date.now()),
  } });
  let onAbort;
  try {
    const message = await new Promise((resolve, reject) => {
      onAbort = () => { worker.postMessage('cancel'); reject(signal.reason); };
      signal.addEventListener('abort', onAbort, { once: true });
      worker.once('message', resolve);
      worker.once('error', () => reject(new Error('Search worker failed')));
      worker.once('exit', () => reject(new Error('Search worker exited before returning a result')));
      if (signal.aborted) onAbort();
    });
    signal.throwIfAborted();
    if (message.failed) throw new Error('Search worker failed');
    recordUpstreamError(message.failure);
    return message.result;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) await delay(100);
    // Account leases and concurrency slots must outlive their actual worker.
    await worker.terminate();
  }
}
