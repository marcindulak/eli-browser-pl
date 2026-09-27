import { parseActReferenceFromUrl } from './act-reference-parser.js';
import { validateActReference } from './act-reference-validator.js';
import { loadAct } from './act-metadata-checker.js';
import { flattenToRecords } from './act-provision-extractor.js';
import { parseLoadedAct } from './act-text-sources.js';
import { buildSearchIndex, searchIndex } from './act-search-index.js';
import { toFtsQuery } from './search-query.js';
import { renderSearchResults } from './search-results.js';
import { appendSegments, renderBrowseView } from './browse-view.js';
import { DEFAULT_ACT_URL } from './default-act.js';
import { createEmbeddingWorkerPool, getEmbeddingWorkerCount } from './embedding-worker-pool.js';
import { buildEmbeddingIndex, searchEmbeddingIndex } from './embeddings-search.js';
import { loadEmbeddingsSet, saveEmbeddingsSet } from './embeddings-store.js';

// Top-level import, not a shared helper: WebKit fails SRI integrity checks on
// this CDN import when it's transitive (REQUIREMENTS.md Technical Choices).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const actUrlForm = document.getElementById('act-url-form');
const actUrlField = document.getElementById('act-url');
const parsedReferenceElement = document.getElementById('parsed-reference');
const errorMessageElement = document.getElementById('error-message');
const retryButton = document.getElementById('retry');
const browseViewContainer = document.getElementById('browse-view');
const searchQueryField = document.getElementById('search-query');
const searchResultsContainer = document.getElementById('search-results');
const actTitleElement = document.getElementById('act-title');
const sourceNoticeElement = document.getElementById('source-notice');
const backToTopButton = document.getElementById('back-to-top');
const stickyHeader = document.getElementById('sticky-header');
const bm25MethodRadio = document.getElementById('search-method-bm25');
const embeddingsMethodRadio = document.getElementById('search-method-embeddings');
const embeddingsStatusElement = document.getElementById('embeddings-status');
const consentDialog = document.getElementById('embeddings-consent');
const searchMethodButton = document.getElementById('search-method-button');
const searchMethodCurrent = document.getElementById('search-method-current');
const searchMethodPanel = document.getElementById('search-method');

// The heavy embeddings option is offered only to links carrying `?search_enabled=bm25,emb`.
// BM25 is always available, so only "emb" is looked for.
const pageParameters = new URLSearchParams(window.location.search);
const enabledSearchMethods = (pageParameters.get('search_enabled') ?? '').split(',');
embeddingsMethodRadio.parentElement.hidden = !enabledSearchMethods.includes('emb');

function setSearchMethodPanelOpen(isOpen) {
  searchMethodPanel.hidden = !isOpen;
  searchMethodButton.setAttribute('aria-expanded', String(isOpen));
}

searchMethodButton.addEventListener('click', () => setSearchMethodPanelOpen(searchMethodPanel.hidden));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !searchMethodPanel.hidden) {
    setSearchMethodPanelOpen(false);
    searchMethodButton.focus();
  }
});

document.addEventListener('click', (event) => {
  if (searchMethodPanel.hidden) return;
  if (!searchMethodPanel.contains(event.target) && !searchMethodButton.contains(event.target)) {
    setSearchMethodPanelOpen(false);
  }
});

function showSelectedSearchMethodOnButton() {
  const methodName = document.querySelector('input[name="search-method"]:checked').labels[0].textContent;
  searchMethodCurrent.textContent = methodName;
  searchMethodButton.setAttribute('aria-label', `Metoda wyszukiwania: ${methodName}`);
}

// Setting `checked` in code fires no `change` event, so the button is updated here.
function revertToBm25Method() {
  bm25MethodRadio.checked = true;
  showSelectedSearchMethodOnButton();
}

const EMBEDDINGS_CONSENT_STORAGE_KEY = 'embeddings-consent';
const EMBEDDINGS_SEARCH_DEBOUNCE_MILLISECONDS = 300;
// Embeddings rank every provision, with no notion of "matching", so the list is capped
// (unlike BM25's, FR-012).
const EMBEDDING_RESULT_LIMIT = 20;
/** Error for a failure while the provisions are embedded (FR-026), as opposed to the model failing to load. */
const EMBEDDING_ERROR = 'Błąd osadzania tekstu.';
/** Error for a model that fails to load (FR-023). */
const MODEL_LOAD_ERROR = 'Błąd wczytywania modelu.';
/** Error for a URL that cannot be parsed or fails validation with no more specific message (FR-014). */
const INVALID_ACT_URL_ERROR = 'Nieprawidłowy adres URL ustawy.';

/** Loaded act's provision records (FR-005); null until the first load finishes. */
let currentActRecords = null;
/** Promise of the embedding worker pool (FR-026), shared by every act; null until first needed or after a failure. */
let embeddingPoolPromise = null;
/** Promise of {pool, index} for the current act; null until embeddings search needs it. */
let currentEmbeddingSearchPromise = null;
let embeddingsSearchDebounceTimer;

// NFR-003: retry re-loads the whole page (picking up any ?url= already in the
// address bar), not just the failed request.
retryButton.addEventListener('click', () => window.location.reload());

// FR-018: a button, not an anchor link, so this never touches the URL/history
// the way an <a href="#top"> would (FR-003/FR-004 treat the URL as shareable).
backToTopButton.addEventListener('click', () => window.scrollTo({ top: 0 }));

// FR-008/FR-019: keeps --sticky-header-height current for style.css's
// scroll-margin-top, since the header's own height varies (error message,
// act title, responsive wrapping).
new ResizeObserver(([entry]) => {
  // +1: scrollIntoView() rounds the applied scroll position to the nearest
  // pixel, which can round up and land a target a sub-pixel short of the
  // margin; this covers that worst case on any screen, not one in particular.
  const height = Math.ceil(entry.borderBoxSize[0].blockSize) + 1;
  document.documentElement.style.setProperty('--sticky-header-height', `${height}px`);
}).observe(stickyHeader);

function setParsedReferenceDataset(reference) {
  if (reference) {
    parsedReferenceElement.dataset.publisher = reference.publisher;
    parsedReferenceElement.dataset.year = reference.year;
    parsedReferenceElement.dataset.position = reference.position;
  } else {
    delete parsedReferenceElement.dataset.publisher;
    delete parsedReferenceElement.dataset.year;
    delete parsedReferenceElement.dataset.position;
  }
}

function updateParsedReference() {
  setParsedReferenceDataset(parseActReferenceFromUrl(actUrlField.value));
}

actUrlField.addEventListener('input', updateParsedReference);

/** Current act's search index (FR-006); reassigned on each load, null until then. */
export let currentSearchIndexDb = null;

// FR-015: no debounce, since this only queries the in-memory index, no
// network request per keystroke. Also not optimized for per-keystroke reuse
// (a cached prepared statement) or capped with a LIMIT: FR-006 observes query
// speed empirically rather than gating on a threshold, and FR-012 requires
// every match shown, ruling out capping results.
function runBm25Search() {
  if (!currentSearchIndexDb) return;
  const query = searchQueryField.value.trim();
  // Explicit short-circuit for readability: toFtsQuery('') -> '""' already
  // matches zero rows in FTS5 (verified: it does not throw), so this is
  // redundant with the try/catch below, kept for clarity of intent.
  let results = [];
  if (query) {
    try {
      results = searchIndex(currentSearchIndexDb, toFtsQuery(query));
    } catch (error) {
      // A query with unbalanced quotes/parentheses or a dangling AND/OR/NOT/NEAR
      // is invalid FTS5 syntax mid-typing, an expected, self-correcting state
      // (the next keystroke commonly makes it valid again); logged at info level,
      // not error, so a genuinely unexpected exception here would still stand out.
      console.info(`Search query not yet valid FTS5 syntax: "${query}"`, error);
    }
  }
  renderSearchResults(results, searchResultsContainer);
}

function isEmbeddingsSearchSelected() {
  return embeddingsMethodRadio.checked;
}

/**
 * FR-027: reads the vectors saved for the act on an earlier visit.
 * @param {string} act - e.g. "DU/2024/1292".
 * @param {Array<string>} texts - the texts of the act's provisions, in record order.
 * @returns {Promise<Array<Float32Array>|null>} null when nothing fits, when the page address asks for a
 *   recalculation (`embeddings_recalculate=true`, a developer option), or when IndexedDB is unavailable.
 */
async function loadSavedVectors(act, texts) {
  if (pageParameters.get('embeddings_recalculate') === 'true') {
    console.info('Embeddings: recalculating, so the saved set is not read');
    return null;
  }
  try {
    return await loadEmbeddingsSet(act, texts);
  } catch (error) {
    console.error('Cannot read the saved embeddings set', error);
    return null;
  }
}

/**
 * FR-027: saves the act's vectors for later visits. A failure is logged, and the search continues with the
 * vectors in memory. The save hashes the texts again after loadSavedVectors() did, which costs tens of
 * milliseconds against the minutes of embedding, so the hash is not passed between the two.
 */
async function saveVectors(act, texts, vectors) {
  try {
    await saveEmbeddingsSet(act, texts, vectors);
  } catch (error) {
    console.error('Cannot save the embeddings set', error);
  }
}

/**
 * Prepares the act's embeddings: the workers load the model once per page, and the vectors are read
 * from the saved set when it fits the act (FR-027), otherwise computed live and saved, once per act.
 */
async function buildEmbeddingSearchIndex(records) {
  if (!embeddingPoolPromise) {
    embeddingsStatusElement.textContent = 'Ładowanie modelu…';
    const workerCount = getEmbeddingWorkerCount(navigator.hardwareConcurrency, pageParameters.get('embedding_workers'));
    const modelLoadStartedAt = performance.now();
    console.info(`Embeddings: starting ${workerCount} workers, each loading the model`);
    embeddingPoolPromise = createEmbeddingWorkerPool(workerCount).then((createdPool) => {
      console.info(`Embeddings: model loaded by ${workerCount} workers after ${Math.round(performance.now() - modelLoadStartedAt)} ms`);
      return createdPool;
    });
  }
  const poolPromise = embeddingPoolPromise;
  try {
    const pool = await poolPromise;
    const act = records[0]?.act;
    const texts = records.map((record) => record.text);
    const savedVectors = records.length ? await loadSavedVectors(act, texts) : null;
    if (savedVectors) {
      console.info(`Embeddings: using the saved set of ${records.length} provisions`);
      return { pool, index: { records, vectors: savedVectors } };
    }
    // Only the current act's build may write the indicator: an earlier act's
    // build can still be running after the act was reloaded.
    const showEmbeddingProgress = (embeddedCount, totalCount) => {
      if (records !== currentActRecords) return;
      embeddingsStatusElement.textContent = `Osadzanie tekstu… ${embeddedCount}/${totalCount}`;
    };
    showEmbeddingProgress(0, records.length);
    const embeddingStartedAt = performance.now();
    console.info(`Embeddings: embedding ${records.length} provisions`);
    let index;
    try {
      index = await buildEmbeddingIndex(pool, records, showEmbeddingProgress);
    } catch (error) {
      throw new Error(EMBEDDING_ERROR, { cause: error });
    }
    console.info(`Embeddings: ${records.length} provisions embedded in ${Math.round(performance.now() - embeddingStartedAt)} ms`);
    if (records.length) await saveVectors(act, texts, index.vectors);
    return { pool, index };
  } catch (error) {
    // A pool that failed is closed, so the next attempt starts a new one.
    if (embeddingPoolPromise === poolPromise) embeddingPoolPromise = null;
    throw error;
  }
}

/** Starts (or joins) the current act's embeddings build, showing the loading indicator until it ends. */
async function prepareEmbeddingSearch() {
  if (!currentActRecords) return;
  const build = (currentEmbeddingSearchPromise ??= buildEmbeddingSearchIndex(currentActRecords));
  embeddingsStatusElement.hidden = false;
  try {
    await build;
  } catch (error) {
    console.error('Cannot load embeddings search', error);
    // A newer build (the act was reloaded meanwhile) is not this failure's to reset.
    if (currentEmbeddingSearchPromise === build) {
      currentEmbeddingSearchPromise = null;
      errorMessageElement.textContent = error.message === EMBEDDING_ERROR ? EMBEDDING_ERROR : MODEL_LOAD_ERROR;
      revertToBm25Method();
    }
  } finally {
    if (currentEmbeddingSearchPromise === build || currentEmbeddingSearchPromise === null) {
      embeddingsStatusElement.hidden = true;
    }
  }
}

async function runEmbeddingsSearch() {
  const query = searchQueryField.value.trim();
  // A failed build was already reported by prepareEmbeddingSearch().
  const embeddingSearch = await currentEmbeddingSearchPromise?.catch(() => null);
  let results = [];
  if (query && embeddingSearch) {
    try {
      const ranked = await searchEmbeddingIndex(embeddingSearch.pool, embeddingSearch.index, query);
      results = ranked
        .slice(0, EMBEDDING_RESULT_LIMIT)
        .map((record) => ({ ...record, highlighted_text: record.text }));
    } catch (error) {
      console.error('Embeddings search failed', error);
    }
  }
  // A newer keystroke, method switch or act load may have finished first.
  if (query !== searchQueryField.value.trim() || !isEmbeddingsSearchSelected()) return;
  renderSearchResults(results, searchResultsContainer);
}

// FR-023: BM25 stays live as-you-type; embeddings wait for a pause in typing,
// since each query is a model inference.
searchQueryField.addEventListener('input', () => {
  clearTimeout(embeddingsSearchDebounceTimer);
  if (isEmbeddingsSearchSelected()) {
    embeddingsSearchDebounceTimer = setTimeout(runEmbeddingsSearch, EMBEDDINGS_SEARCH_DEBOUNCE_MILLISECONDS);
  } else {
    runBm25Search();
  }
});

/** Resolves true when the user has consented to downloading the embeddings model, asking first if needed. */
function requestEmbeddingsConsent() {
  if (localStorage.getItem(EMBEDDINGS_CONSENT_STORAGE_KEY) === 'granted') return Promise.resolve(true);
  return new Promise((resolve) => {
    consentDialog.returnValue = '';
    consentDialog.addEventListener('close', () => {
      const granted = consentDialog.returnValue === 'granted';
      if (granted) localStorage.setItem(EMBEDDINGS_CONSENT_STORAGE_KEY, 'granted');
      resolve(granted);
    }, { once: true });
    consentDialog.showModal();
  });
}

for (const methodRadio of [bm25MethodRadio, embeddingsMethodRadio]) {
  methodRadio.addEventListener('change', async () => {
    setSearchMethodPanelOpen(false);
    showSelectedSearchMethodOnButton();
    clearTimeout(embeddingsSearchDebounceTimer);
    if (!isEmbeddingsSearchSelected()) {
      runBm25Search();
      return;
    }
    if (!(await requestEmbeddingsConsent())) {
      revertToBm25Method();
      return;
    }
    await prepareEmbeddingSearch();
    await runEmbeddingsSearch();
  });
}

/** FR-014: promise of the load triggered by the last URL-field submission; exported so tests can await it. */
export let submittedActLoad = null;

// A lone <input> inside a <form> submits on Enter natively (HTML's implicit
// submission), so no keydown/Enter-key detection is needed here.
actUrlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const submittedUrl = actUrlField.value;
  submittedActLoad = loadActIntoPage(submittedUrl).then((isLoaded) => {
    if (isLoaded) showActInAddress(submittedUrl);
  });
});

/**
 * Puts the act the page shows into the page's own address as `?url=`, keeping the other parameters.
 * replaceState, not pushState: the address is a shareable link (FR-004) and gets no new history entry.
 */
function showActInAddress(url) {
  const address = new URL(window.location.href);
  address.searchParams.set('url', url);
  history.replaceState(null, '', address.search);
}

/** @returns {Promise<boolean>} true when the act was loaded and is shown, false when an error is shown instead. */
async function loadActIntoPage(url) {
  actUrlField.value = url;
  retryButton.hidden = true;
  const reference = parseActReferenceFromUrl(url);
  if (!reference) {
    console.error(`Cannot load act: unparseable or untrusted URL "${url}"`);
    errorMessageElement.textContent = INVALID_ACT_URL_ERROR;
    return false;
  }
  setParsedReferenceDataset(reference);

  const validation = validateActReference(reference);
  if (!validation.valid) {
    console.error(`Cannot load act: reference failed NFR-004 validation for URL "${url}"`);
    errorMessageElement.textContent = validation.error ?? INVALID_ACT_URL_ERROR;
    return false;
  }
  errorMessageElement.textContent = '';

  // Runs WASM init alongside the network fetch, not after: both are independent
  // first-load costs (NFR-001).
  let loadResult, sqlite3;
  try {
    [loadResult, sqlite3] = await Promise.all([loadAct(reference), sqlite3InitModule()]);
  } catch (error) {
    // NFR-003: api.sejm.gov.pl unreachable or returning an HTTP error, distinct
    // from FR-002's unsupported-act error (a genuine act-type rejection, where
    // retrying would not help).
    console.error(`Cannot load act: fetch failed for URL "${url}"`, error);
    errorMessageElement.textContent = 'Błąd wczytywania ustawy.';
    retryButton.hidden = false;
    return false;
  }
  if (!loadResult.supported) {
    errorMessageElement.textContent = loadResult.error;
    return false;
  }

  const act = `${reference.publisher}/${reference.year}/${reference.position}`;
  // One tree feeds both search and browse, so they can't diverge.
  const { tree, titleSegments, isUnofficialConversion } = parseLoadedAct(loadResult, act);
  currentActRecords = flattenToRecords(tree, act);
  currentSearchIndexDb = buildSearchIndex(sqlite3, currentActRecords);
  // The previous act's embeddings no longer apply.
  currentEmbeddingSearchPromise = null;
  if (isEmbeddingsSearchSelected()) {
    prepareEmbeddingSearch().then(runEmbeddingsSearch);
  }
  renderBrowseView(tree, browseViewContainer);
  actTitleElement.replaceChildren();
  appendSegments(actTitleElement, titleSegments);
  sourceNoticeElement.hidden = !isUnofficialConversion;
  return true;
}

async function loadInitialAct() {
  const urlParam = pageParameters.get('url');
  if (urlParam) {
    await loadActIntoPage(urlParam);
    return;
  }
  await loadActIntoPage(DEFAULT_ACT_URL);
  showActInAddress(DEFAULT_ACT_URL);
}

/** Exported so tests can await the initial load. */
export const initialActLoad = loadInitialAct();
