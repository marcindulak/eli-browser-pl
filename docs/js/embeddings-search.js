const MODEL_ID = 'OPI-PIB/PolDense-17M';
const MODEL_FILE_NAME = 'model_int4_with_embeddings';
const QUERY_PREFIX = '[query]: ';
const EMBEDDING_BATCH_SIZE = 16;

// transformers.js's default binary lacks the GatherBlockQuantized kernel the INT4 model needs.
// The version must match transformers.js's dependency and scripts/download_embeddings_runtime.sh.
const ONNXRUNTIME_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist';

/**
 * Loads the embedding model (FR-022), served from this site's own `hub/` directory.
 * @param {{env: object, pipeline: Function}} transformers - the `@huggingface/transformers`
 *   module, imported by the caller at its own top level (see REQUIREMENTS.md's Technical Choices).
 * @returns {Promise<Function>} an extractor to pass to buildEmbeddingIndex() and searchEmbeddingIndex().
 */
export function loadEmbeddingModel({ env, pipeline }) {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  // A path, not a full URL: transformers.js 4.3.0 fails to load the tokenizer from an absolute URL.
  env.localModelPath = new URL('../hub/', import.meta.url).pathname;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${ONNXRUNTIME_URL}/ort-wasm-simd-threaded.mjs`,
    wasm: `${ONNXRUNTIME_URL}/ort-wasm-simd-threaded.wasm`,
  };
  // dtype 'fp32' selects no file-name suffix, so model_file_name is used as given.
  return pipeline('feature-extraction', MODEL_ID, { model_file_name: MODEL_FILE_NAME, dtype: 'fp32', device: 'wasm' });
}

/**
 * Embeds texts with CLS pooling and L2 normalization, so a dot product of two
 * vectors is their cosine similarity. Batches bound peak memory, one forward pass each.
 */
async function embedTexts(extractor, texts) {
  const vectors = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const output = await extractor(texts.slice(start, start + EMBEDDING_BATCH_SIZE), { pooling: 'cls', normalize: true });
    const [batchSize, dimension] = output.dims;
    for (let i = 0; i < batchSize; i++) {
      vectors.push(output.data.slice(i * dimension, (i + 1) * dimension));
    }
  }
  return vectors;
}

/**
 * Embeds every provision's text (no prefix: the model only prefixes queries).
 * @param {Function} extractor - returned by loadEmbeddingModel().
 * @param {Array<{text: string}>} records - provision records, e.g. extractProvisionsFromActText()'s output.
 * @returns {Promise<{records: Array<object>, vectors: Array<Float32Array>}>} `vectors[i]` embeds `records[i]`.
 */
export async function buildEmbeddingIndex(extractor, records) {
  return { records, vectors: await embedTexts(extractor, records.map((record) => record.text)) };
}

/**
 * Ranks every provision by cosine similarity to the query, most similar first.
 * @param {Function} extractor - returned by loadEmbeddingModel().
 * @param {{records: Array<object>, vectors: Array<Float32Array>}} index - returned by buildEmbeddingIndex().
 * @param {string} query - free text, embedded with the model's query prefix.
 * @returns {Promise<Array<object>>} all provision records, each with an added `score` (cosine similarity).
 */
export async function searchEmbeddingIndex(extractor, index, query) {
  const [queryVector] = await embedTexts(extractor, [QUERY_PREFIX + query]);
  return index.records
    .map((record, i) => ({ ...record, score: index.vectors[i].reduce((sum, value, j) => sum + value * queryVector[j], 0) }))
    .sort((a, b) => b.score - a.score);
}
