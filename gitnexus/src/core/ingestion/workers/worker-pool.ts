import { Worker } from 'node:worker_threads';
import os from 'node:os';

export interface WorkerPool {
  /**
   * Dispatch items across workers. Items are split into chunks (one per worker),
   * each worker processes its chunk via sub-batches to limit peak memory,
   * and results are concatenated back in order.
   */
  dispatch<TInput, TResult>(items: TInput[], onProgress?: (filesProcessed: number) => void): Promise<TResult[]>;

  /** Terminate all workers. Must be called when done. */
  terminate(): Promise<void>;

  /** Number of workers in the pool */
  readonly size: number;
}

/**
 * Max files to send to a worker in a single postMessage.
 * Keeps structured-clone memory bounded per sub-batch.
 */
const SUB_BATCH_SIZE = 1500;

/** Per sub-batch timeout. If a single sub-batch takes longer than this,
 *  likely a pathological file (e.g. minified 50MB JS). Fail fast. */
const SUB_BATCH_TIMEOUT_MS = 30_000;

const estimateItemWeight = (item: unknown): number => {
  if (item && typeof item === 'object') {
    const content = (item as { content?: unknown }).content;
    if (typeof content === 'string') return Math.max(content.length, 1);
    const size = (item as { size?: unknown }).size;
    if (typeof size === 'number' && Number.isFinite(size)) return Math.max(size, 1);
  }
  return 1;
};

const mergeWorkerResult = <TResult>(target: TResult | null, chunk: TResult): TResult => {
  if (target === null) return chunk;

  if (
    typeof target === 'object' && target !== null &&
    typeof chunk === 'object' && chunk !== null &&
    !Array.isArray(target) && !Array.isArray(chunk)
  ) {
    const next = target as Record<string, unknown>;
    for (const [key, value] of Object.entries(chunk as Record<string, unknown>)) {
      const existing = next[key];
      if (Array.isArray(existing) && Array.isArray(value)) {
        existing.push(...value);
      } else if (typeof existing === 'number' && typeof value === 'number') {
        next[key] = existing + value;
      } else {
        next[key] = value;
      }
    }
    return target;
  }

  if (Array.isArray(target) && Array.isArray(chunk)) {
    target.push(...chunk);
    return target;
  }

  return chunk;
};

/**
 * Create a pool of worker threads.
 */
export const createWorkerPool = (workerUrl: URL, poolSize?: number): WorkerPool => {
  const size = poolSize ?? Math.min(8, Math.max(1, os.cpus().length - 1));
  const workers: Worker[] = [];
  const execArgv = workerUrl.pathname.endsWith('.ts') ? ['--import', 'tsx'] : undefined;

  for (let i = 0; i < size; i++) {
    workers.push(new Worker(workerUrl, { execArgv }));
  }

  const dispatch = <TInput, TResult>(items: TInput[], onProgress?: (filesProcessed: number) => void): Promise<TResult[]> => {
    if (items.length === 0) return Promise.resolve([]);

    const chunkCount = Math.min(size, items.length);
    const chunks: TInput[][] = Array.from({ length: chunkCount }, () => []);
    const chunkWeights = new Array(chunkCount).fill(0);

    const weightedItems = items
      .map(item => ({ item, weight: estimateItemWeight(item) }))
      .sort((a, b) => b.weight - a.weight);

    for (const { item, weight } of weightedItems) {
      let targetIdx = 0;
      for (let i = 1; i < chunkCount; i++) {
        if (chunkWeights[i] < chunkWeights[targetIdx]) {
          targetIdx = i;
        }
      }
      chunks[targetIdx].push(item);
      chunkWeights[targetIdx] += weight;
    }

    const workerProgress = new Array(chunks.length).fill(0);

    const promises = chunks.map((chunk, i) => {
      const worker = workers[i];
      return new Promise<TResult>((resolve, reject) => {
        let settled = false;
        let aggregatedResult: TResult | null = null;
        let subBatchTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (subBatchTimer) clearTimeout(subBatchTimer);
          worker.removeListener('message', handler);
          worker.removeListener('error', errorHandler);
          worker.removeListener('exit', exitHandler);
        };

        const resetSubBatchTimer = () => {
          if (subBatchTimer) clearTimeout(subBatchTimer);
          subBatchTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(new Error(`Worker ${i} sub-batch timed out after ${SUB_BATCH_TIMEOUT_MS / 1000}s (chunk: ${chunk.length} items).`));
            }
          }, SUB_BATCH_TIMEOUT_MS);
        };

        let subBatchIdx = 0;

        const sendNextSubBatch = () => {
          const start = subBatchIdx * SUB_BATCH_SIZE;
          if (start >= chunk.length) {
            worker.postMessage({ type: 'flush' });
            return;
          }
          const subBatch = chunk.slice(start, start + SUB_BATCH_SIZE);
          subBatchIdx++;
          resetSubBatchTimer();
          worker.postMessage({ type: 'sub-batch', files: subBatch });
        };

        const handler = (msg: any) => {
          if (settled) return;
          if (msg && msg.type === 'progress') {
            workerProgress[i] = msg.filesProcessed;
            if (onProgress) {
              const total = workerProgress.reduce((a, b) => a + b, 0);
              onProgress(total);
            }
          } else if (msg && msg.type === 'chunk-result') {
            aggregatedResult = mergeWorkerResult(aggregatedResult, msg.data as TResult);
          } else if (msg && msg.type === 'sub-batch-done') {
            sendNextSubBatch();
          } else if (msg && msg.type === 'flush-done') {
            settled = true;
            cleanup();
            resolve((aggregatedResult ?? ([] as unknown)) as TResult);
          } else if (msg && msg.type === 'error') {
            settled = true;
            cleanup();
            reject(new Error(`Worker ${i} error: ${msg.error}`));
          } else if (msg && msg.type === 'result') {
            settled = true;
            cleanup();
            resolve(msg.data);
          } else {
            settled = true;
            cleanup();
            resolve(msg);
          }
        };

        const errorHandler = (err: any) => {
          if (!settled) { settled = true; cleanup(); reject(err); }
        };

        const exitHandler = (code: number) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error(`Worker ${i} exited with code ${code}. Likely OOM or native addon failure.`));
          }
        };

        worker.on('message', handler);
        worker.once('error', errorHandler);
        worker.once('exit', exitHandler);
        sendNextSubBatch();
      });
    });

    return Promise.all(promises);
  };

  const terminate = async (): Promise<void> => {
    await Promise.all(workers.map(w => w.terminate()));
    workers.length = 0;
  };

  return { dispatch, terminate, size };
};
