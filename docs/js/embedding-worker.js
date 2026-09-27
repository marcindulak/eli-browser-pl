// FR-026: one single-thread embedding session in its own Web Worker. Messages in: {texts}, once the
// worker has posted {type: 'ready'}; {type: 'downloaded', ...}, the page's answer to a download request.
// Messages out: {type: 'ready'}, {type: 'embedded', batchSize, dimension, vectors} (the vectors of the
// batch, row after row), {type: 'failed', message}, {type: 'download', id, url, integrity}.
// Workers share nothing and exchange messages only, so no cross-origin isolation is needed.
import { MODEL_FILE_NAME, MODEL_ID } from './embeddings-model.js';

// A worker does not use the page's import map, so the library's SHA-384 pin is checked here instead:
// the page fetches the file with the integrity value, which rejects a mismatch, and the worker imports
// the bytes from a blob.
// Keep the URL in sync with features/steps/embeddings-search-steps.js and scripts/download_embeddings_runtime.sh.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';
const TRANSFORMERS_INTEGRITY = 'sha384-qgXJ7dcf8bYoYbel57c9rhOd7qRdLSraaF9XvjXERQll0Pf5e/HV8CDccvn3xgTp';

// transformers.js's default binary lacks the GatherBlockQuantized kernel the INT4 model needs.
// The version must match transformers.js's dependency and scripts/download_embeddings_runtime.sh.
const ONNXRUNTIME_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist';

/** Resolvers of the downloads this worker waits for, by request id. */
const pendingDownloads = new Map();
let nextDownloadId = 0;
/** Set once the model is loaded: embeds an array of texts and posts the result. */
let embedTexts = null;

self.onmessage = ({ data }) => {
  if (data.type === 'downloaded') {
    pendingDownloads.get(data.id)(data);
    pendingDownloads.delete(data.id);
  } else {
    embedTexts(data.texts);
  }
};

function postFailure(error) {
  self.postMessage({ type: 'failed', message: String(error && error.message ? error.message : error) });
}

/**
 * Downloads a file through the page, which downloads each URL once for all the workers.
 * @param {string} url
 * @param {string} [integrity] - SHA-384 value the page checks the file against.
 * @returns {Promise<Response>} an HTTP error status arrives as a Response, a failed request as a rejection.
 */
async function downloadThroughPage(url, integrity) {
  const id = nextDownloadId++;
  const answered = new Promise((resolve) => pendingDownloads.set(id, resolve));
  self.postMessage({ type: 'download', id, url, integrity });
  const answer = await answered;
  if (answer.error) throw new TypeError(answer.error);
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: answer.headers });
}

/** Imports transformers.js from bytes the page has verified against the pinned hash. */
async function importTransformers() {
  const response = await downloadThroughPage(TRANSFORMERS_URL, TRANSFORMERS_INTEGRITY);
  if (!response.ok) throw new Error(`transformers.js: HTTP ${response.status}`);
  const blobUrl = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'text/javascript' }));
  try {
    return await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

try {
  const { env, pipeline } = await importTransformers();
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  // Every download of the library goes through env.fetch, so each file is downloaded once for all workers.
  // A request with a Range header is a size probe, which the page does not need to share.
  env.fetch = (url, init) => (init?.headers?.has?.('Range') ? fetch(url, init) : downloadThroughPage(new URL(url, self.location.href).href));
  // Makes transformers.js load the ONNX Runtime files through env.fetch too. By default it does so only
  // where the Cache API exists, and elsewhere each worker would download the 14 MB WASM binary itself.
  env.useWasmCache = true;
  // Inference runs in this worker already, and a single thread needs no cross-origin isolation.
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.numThreads = 1;
  // A path, not a full URL: transformers.js 4.3.0 fails to load the tokenizer from an absolute URL.
  env.localModelPath = new URL('../hub/', import.meta.url).pathname;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${ONNXRUNTIME_URL}/ort-wasm-simd-threaded.mjs`,
    wasm: `${ONNXRUNTIME_URL}/ort-wasm-simd-threaded.wasm`,
  };
  // dtype 'fp32' selects no file-name suffix, so model_file_name is used as given.
  const extractor = await pipeline('feature-extraction', MODEL_ID, { model_file_name: MODEL_FILE_NAME, dtype: 'fp32', device: 'wasm' });

  embedTexts = async (texts) => {
    try {
      // CLS pooling and L2 normalization, so a dot product of two vectors is their cosine similarity.
      const output = await extractor(texts, { pooling: 'cls', normalize: true });
      const [batchSize, dimension] = output.dims;
      // A copy, so that its buffer can be transferred instead of copied again.
      const vectors = new Float32Array(output.data);
      self.postMessage({ type: 'embedded', batchSize, dimension, vectors }, [vectors.buffer]);
    } catch (error) {
      postFailure(error);
    }
  };
  self.postMessage({ type: 'ready' });
} catch (error) {
  postFailure(error);
}
