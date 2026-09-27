const QUERY_PREFIX = '[query]: ';
const EMBEDDING_BATCH_SIZE = 16;
// A call of the model pads its texts to the longest one, and its memory grows with the number of texts
// times the square of that length, in characters. In a Chromium with one worker a call failed with
// std::bad_alloc from about 280 million and worked up to about 230 million (REQUIREMENTS.md, Embeddings
// Computation). The budget is a guess with a margin for phones, which were not measured.
const EMBEDDING_MEMORY_BUDGET = 100_000_000;

/**
 * Splits the texts into groups for single calls of the model, longest text first.
 * A group holds at most EMBEDDING_BATCH_SIZE texts, and fewer when the memory its longest text needs
 * would exceed EMBEDDING_MEMORY_BUDGET. A text that exceeds it alone still gets a group of its own.
 * Neighbours in the order have similar lengths, which keeps the padding small, and the longest text
 * comes first, so a text that does not fit fails the build at once.
 * @param {Array<string>} texts
 * @returns {Array<Array<number>>} indexes into `texts`, each index in exactly one group.
 */
function groupTextsByLength(texts) {
  // Equal lengths keep their order, because Array.prototype.sort is stable.
  const indexes = texts.map((_, i) => i).sort((a, b) => texts[b].length - texts[a].length);
  const groups = [];
  for (const index of indexes) {
    const group = groups.at(-1);
    // The first text of a group is its longest.
    const fits = group
      && group.length < EMBEDDING_BATCH_SIZE
      && (group.length + 1) * texts[group[0]].length ** 2 <= EMBEDDING_MEMORY_BUDGET;
    if (fits) {
      group.push(index);
    } else {
      groups.push([index]);
    }
  }
  return groups;
}

/**
 * Embeds texts in groups of similar length, which the pool's workers take as they become free (FR-026).
 * The vectors are L2-normalized, so a dot product of two vectors is their cosine similarity.
 * @param {{embedBatches: Function}} pool - returned by createEmbeddingWorkerPool().
 * @param {Array<string>} texts
 * @param {(embeddedCount: number, totalCount: number) => void} [onProgress] - called after each group.
 * @returns {Promise<Array<Float32Array>>} `vectors[i]` embeds `texts[i]`, whatever the order of the groups.
 */
async function embedTexts(pool, texts, onProgress = () => {}) {
  const groups = groupTextsByLength(texts);
  let embeddedCount = 0;
  const embeddedGroups = await pool.embedBatches(groups.map((group) => group.map((index) => texts[index])), (vectorsOfGroup) => {
    embeddedCount += vectorsOfGroup.length;
    onProgress(embeddedCount, texts.length);
  });
  const vectors = new Array(texts.length);
  groups.forEach((group, groupIndex) => {
    group.forEach((textIndex, position) => {
      vectors[textIndex] = embeddedGroups[groupIndex][position];
    });
  });
  return vectors;
}

/**
 * Embeds every provision's text (no prefix: the model only prefixes queries).
 * @param {{embedBatches: Function}} pool - returned by createEmbeddingWorkerPool().
 * @param {Array<{text: string}>} records - provision records, e.g. extractProvisionsFromActText()'s output.
 * @param {(embeddedCount: number, totalCount: number) => void} [onProgress] - called after each batch.
 * @returns {Promise<{records: Array<object>, vectors: Array<Float32Array>}>} `vectors[i]` embeds `records[i]`.
 */
export async function buildEmbeddingIndex(pool, records, onProgress) {
  return { records, vectors: await embedTexts(pool, records.map((record) => record.text), onProgress) };
}

/**
 * Ranks every provision by cosine similarity to the query, most similar first.
 * The query is one batch, so one worker embeds it; the ranking runs on the calling thread.
 * @param {{embedBatches: Function}} pool - returned by createEmbeddingWorkerPool().
 * @param {{records: Array<object>, vectors: Array<Float32Array>}} index - returned by buildEmbeddingIndex().
 * @param {string} query - free text, embedded with the model's query prefix.
 * @returns {Promise<Array<object>>} all provision records, each with an added `score` (cosine similarity).
 */
export async function searchEmbeddingIndex(pool, index, query) {
  const [queryVector] = await embedTexts(pool, [QUERY_PREFIX + query]);
  return index.records
    .map((record, i) => ({ ...record, score: index.vectors[i].reduce((sum, value, j) => sum + value * queryVector[j], 0) }))
    .sort((a, b) => b.score - a.score);
}
