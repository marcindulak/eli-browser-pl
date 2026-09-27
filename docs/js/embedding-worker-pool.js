// FR-026: a pool of embedding workers (embedding-worker.js) that take batches from one shared queue.

/**
 * Picks the number of embedding workers: half of the reported cores, rounded down, at least 1,
 * unless the page address asked for a number between 1 and the reported cores. The half is a
 * guess, because phone measurements were not deterministic (REQUIREMENTS.md, Embeddings Computation).
 * @param {number} reportedCores - navigator.hardwareConcurrency.
 * @param {string|null} requestedCount - the `embedding_workers` page parameter, null when absent.
 * @returns {number} the worker count.
 */
export function getEmbeddingWorkerCount(reportedCores, requestedCount) {
  const cores = Number.isInteger(reportedCores) && reportedCores > 0 ? reportedCores : 1;
  // A strict pattern, so that no other text reaches Number(): a crafted link cannot start many workers.
  if (requestedCount !== null && /^[1-9]\d*$/.test(requestedCount) && Number(requestedCount) <= cores) {
    return Number(requestedCount);
  }
  return Math.max(1, Math.floor(cores / 2));
}

/**
 * Downloads each URL once for all the workers, because started together they would otherwise each
 * download their own copy: a browser cache does not reliably serve concurrent requests, and the
 * Cache API exists only in secure contexts.
 * @returns {{download: Function, clear: Function}} `download(url, integrity)` resolves with the response's
 *   status, headers and bytes, and rejects when the request fails or the file does not match `integrity`.
 *   `clear()` drops the bytes, which are needed only while the workers load.
 */
function createDownloadBroker() {
  const downloads = new Map();
  return {
    download(url, integrity) {
      if (!downloads.has(url)) {
        console.info(`Embeddings: downloading ${url}`);
        downloads.set(url, fetch(url, integrity ? { integrity } : undefined).then(async (response) => ({
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
          body: await response.arrayBuffer(),
        })));
      }
      return downloads.get(url);
    },
    clear: () => downloads.clear(),
  };
}

/**
 * Connects the page to a worker: answers the worker's download requests through the broker, and sends
 * the worker requests of its own. A worker has at most one request in flight.
 * @returns {Function} `request(message)` posts the message, when there is one, and resolves with the
 *   worker's next reply, rejected on a failure message or an error event.
 */
function connectWorker(worker, broker) {
  let pending = null;
  const settle = (outcome, value) => {
    if (!pending) return;
    const request = pending;
    pending = null;
    request[outcome](value);
  };
  worker.onmessage = async ({ data }) => {
    if (data.type === 'download') {
      let answer;
      try {
        answer = { ...(await broker.download(data.url, data.integrity)), type: 'downloaded', id: data.id };
      } catch (error) {
        answer = { type: 'downloaded', id: data.id, error: String(error && error.message ? error.message : error) };
      }
      worker.postMessage(answer);
    } else if (data.type === 'failed') {
      settle('reject', new Error(data.message));
    } else {
      settle('resolve', data);
    }
  };
  worker.onerror = (event) => settle('reject', new Error(event.message || 'embedding worker error'));
  worker.onmessageerror = () => settle('reject', new Error('embedding worker message could not be read'));
  return (message) => new Promise((resolve, reject) => {
    pending = { resolve, reject };
    if (message) worker.postMessage(message);
  });
}

/**
 * Starts the workers, each loading the model, and resolves when all are ready.
 * @param {number} workerCount - from getEmbeddingWorkerCount().
 * @returns {Promise<{embedBatches: Function, close: Function}>}
 *   `embedBatches(batches, onBatchEmbedded)` embeds arrays of texts, idle workers taking the next
 *   batch, and resolves with one array of vectors per batch, in the order of the batches.
 *   `onBatchEmbedded(vectorsOfBatch)` is called as each batch finishes. A failing worker closes the
 *   pool and rejects the call. `close()` stops the workers.
 */
export async function createEmbeddingWorkerPool(workerCount) {
  const broker = createDownloadBroker();
  const workers = Array.from({ length: workerCount }, () => new Worker(new URL('./embedding-worker.js', import.meta.url), { type: 'module' }));
  const requests = workers.map((worker) => connectWorker(worker, broker));
  let isClosed = false;
  const close = () => {
    isClosed = true;
    workers.forEach((worker) => worker.terminate());
  };
  try {
    await Promise.all(requests.map((request) => request()));
  } catch (error) {
    close();
    throw error;
  } finally {
    broker.clear();
  }

  async function embedBatchesNow(batches, onBatchEmbedded) {
    if (isClosed) throw new Error('The embedding workers were stopped');
    const embeddedBatches = new Array(batches.length);
    let nextBatchIndex = 0;
    try {
      await Promise.all(requests.map(async (request, workerIndex) => {
        while (nextBatchIndex < batches.length) {
          const batchIndex = nextBatchIndex++;
          const { batchSize, dimension, vectors } = await request({ texts: batches[batchIndex] });
          embeddedBatches[batchIndex] = Array.from({ length: batchSize }, (_, i) => vectors.slice(i * dimension, (i + 1) * dimension));
          console.info(`Embeddings: worker ${workerIndex} embedded a batch of ${batchSize} texts`);
          onBatchEmbedded(embeddedBatches[batchIndex]);
        }
      }));
    } catch (error) {
      console.error('Embeddings: a worker failed, stopping the workers', error);
      close();
      throw error;
    }
    return embeddedBatches;
  }

  // The workers take one request at a time, so overlapping calls (a superseded act's build, a query) wait their turn.
  let previousCall = Promise.resolve();
  const embedBatches = (batches, onBatchEmbedded) => {
    const call = previousCall.catch(() => {}).then(() => embedBatchesNow(batches, onBatchEmbedded));
    previousCall = call;
    return call;
  };
  return { embedBatches, close };
}
