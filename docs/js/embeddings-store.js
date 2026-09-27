// FR-027: embeddings computed on the device are kept in IndexedDB between visits.
// One record per act holds all its vectors in one Float32Array, so a set is written and read as a unit.
import { EMBEDDINGS_VERSION, MODEL_FILE_NAME, MODEL_ID } from './embeddings-model.js';

/**
 * Name of the IndexedDB database. IndexedDB is scoped to the origin, not to the path, and GitHub Pages
 * serves every project of a user from one origin, so the name must not collide with another project's.
 */
export const DATABASE_NAME = 'eli-browser-pl-embeddings';

/** Name of the object store, whose records are keyed on the array in their `key` property. */
export const STORE_NAME = 'embeddings-sets';

/** Most acts kept at once. Storing one more removes the one stored longest ago. */
export const MAX_STORED_ACTS = 10;

const STORED_AT_INDEX_NAME = 'storedAt';
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/**
 * Hashes the provision texts, each preceded by its length, so that moving a boundary between two
 * texts changes the hash. It is FNV-1a with 64 bits of state, which is not cryptographic: it guards
 * against stale data, not against an attacker, and crypto.subtle exists only in secure contexts.
 * @param {Array<string>} texts - the texts of the provisions, in record order.
 * @returns {string} 16 hexadecimal digits.
 */
export function hashProvisionTexts(texts) {
  const mix = (hash, value) => BigInt.asUintN(64, (hash ^ BigInt(value)) * FNV_PRIME);
  let hash = FNV_OFFSET_BASIS;
  for (const text of texts) {
    hash = mix(hash, text.length);
    for (let i = 0; i < text.length; i++) {
      hash = mix(hash, text.charCodeAt(i));
    }
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Opens the database, creating the object store on the first use.
 * The caller closes it, so a later open at another version is never blocked by this page.
 * @returns {Promise<IDBDatabase>} rejected when IndexedDB is unavailable or the database cannot be opened.
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
      store.createIndex(STORED_AT_INDEX_NAME, STORED_AT_INDEX_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** @returns {Array<string>} the key of the set of an act under the current model, quantization and version. */
function buildKey(act) {
  return [act, MODEL_ID, MODEL_FILE_NAME, EMBEDDINGS_VERSION];
}

/**
 * Reads the saved embeddings set of an act, if it was computed from these texts.
 * @param {string} act - e.g. "DU/2024/1292".
 * @param {Array<string>} texts - the texts of the act's provisions, in record order.
 * @returns {Promise<Array<Float32Array>|null>} `vectors[i]` embeds `texts[i]`, or null when nothing is saved
 *   or the saved set does not fit the texts. Rejected when IndexedDB is unavailable.
 */
export async function loadEmbeddingsSet(act, texts) {
  const database = await openDatabase();
  try {
    const entry = await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(buildKey(act));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const { dimension, recordCount, textHash, vectors } = entry ?? {};
    const fits = entry
      && textHash === hashProvisionTexts(texts)
      && recordCount === texts.length
      && Number.isInteger(dimension) && dimension > 0
      && vectors instanceof Float32Array && vectors.length === recordCount * dimension;
    if (entry && !fits) {
      console.info(`Embeddings: the saved set of ${act} does not fit its provisions and is ignored`);
    }
    return fits ? texts.map((_, i) => vectors.subarray(i * dimension, (i + 1) * dimension)) : null;
  } finally {
    database.close();
  }
}

/**
 * Saves the embeddings set of an act, replacing every set saved for that act, and then removes the
 * sets stored longest ago while more than MAX_STORED_ACTS remain. All of it is one transaction, so a
 * failure (for example a quota error) leaves the earlier sets as they were.
 * @param {string} act - e.g. "DU/2024/1292".
 * @param {Array<string>} texts - the texts of the act's provisions, in record order.
 * @param {Array<Float32Array>} vectors - `vectors[i]` embeds `texts[i]`, all of the same length.
 * @returns {Promise<void>} rejected when IndexedDB is unavailable or the transaction fails.
 */
export async function saveEmbeddingsSet(act, texts, vectors) {
  const dimension = vectors[0]?.length ?? 0;
  const concatenatedVectors = new Float32Array(vectors.length * dimension);
  vectors.forEach((vector, i) => concatenatedVectors.set(vector, i * dimension));
  const entry = {
    key: buildKey(act),
    textHash: hashProvisionTexts(texts),
    recordCount: texts.length,
    dimension,
    vectors: concatenatedVectors,
    storedAt: Date.now(),
  };
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.oncomplete = resolve;
      // An aborted transaction (a quota error, for example) was rolled back as a whole.
      transaction.onabort = () => reject(transaction.error);
      const store = transaction.objectStore(STORE_NAME);
      // Array keys sort after strings, so [act, []] is above every key that starts with the act.
      store.delete(IDBKeyRange.bound([act], [act, []]));
      store.put(entry);
      store.count().onsuccess = (event) => {
        let excessCount = event.target.result - MAX_STORED_ACTS;
        if (excessCount <= 0) return;
        store.index(STORED_AT_INDEX_NAME).openKeyCursor().onsuccess = (cursorEvent) => {
          const cursor = cursorEvent.target.result;
          if (cursor && excessCount-- > 0) {
            store.delete(cursor.primaryKey);
            cursor.continue();
          }
        };
      };
    });
  } finally {
    database.close();
  }
}
