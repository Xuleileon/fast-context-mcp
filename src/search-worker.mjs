import { parentPort, workerData } from 'node:worker_threads';
import { searchWithContent } from './core.mjs';
import { searchContext, lastUpstreamError } from './reliability.mjs';

const controller = new AbortController();
parentPort.on('message', message => { if (message === 'cancel') controller.abort(); });
await searchContext(async () => {
  try {
    const result = await searchWithContent(workerData.options);
    const error = lastUpstreamError();
    parentPort.postMessage({ result, failure: error && {
      status: error.status, rpcCode: error.rpcCode || (error instanceof TypeError ? 'unavailable' : undefined), retryAfterMs: error.retryAfterMs,
      details: error.details && { status: error.details.status, rpcCode: error.details.rpcCode },
    } });
  } catch {
    // Never serialize arbitrary exception text: it may contain request credentials.
    parentPort.postMessage({ failed: true });
  }
}, { id: workerData.requestId, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(workerData.remainingMs)]) });
