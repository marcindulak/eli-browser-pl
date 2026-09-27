import { parseActReferenceFromUrl } from './act-reference-parser.js';
import { validateActReference } from './act-reference-validator.js';
import { loadAct } from './act-metadata-checker.js';
import { buildProvisionTree, flattenToRecords } from './act-provision-extractor.js';
import { extractActTitle } from './act-title-extractor.js';
import { buildSearchIndex, searchIndex } from './act-search-index.js';
import { toFtsQuery } from './search-query.js';
import { renderSearchResults } from './search-results.js';
import { renderBrowseView } from './browse-view.js';
import { DEFAULT_ACT_URL } from './default-act.js';

// Top-level import, not a shared helper: WebKit fails SRI integrity checks on
// this CDN import when it's transitive (REQUIREMENTS.md Technical Choices).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const actUrlForm = document.getElementById('act-url-form');
const actUrlField = document.getElementById('act-url');
const parsedReferenceElement = document.getElementById('parsed-reference');
const errorMessageElement = document.getElementById('error-message');
const retryButton = document.getElementById('retry');
const browseViewContainer = document.getElementById('browse-view');
const showRepealedCheckbox = document.getElementById('show-repealed');
const searchQueryField = document.getElementById('search-query');
const searchResultsContainer = document.getElementById('search-results');
const actTitleElement = document.getElementById('act-title');
const backToTopButton = document.getElementById('back-to-top');
const stickyHeader = document.getElementById('sticky-header');

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
function handleSearchQueryInput() {
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
  renderSearchResults(results, searchResultsContainer, showRepealedCheckbox.checked);
}

searchQueryField.addEventListener('input', handleSearchQueryInput);

// Kept separate from initialActLoad: merging would also pull in its
// history.replaceState step, for only two call sites.
/** FR-014: promise of the load triggered by the last URL-field submission; exported so tests can await it. */
export let submittedActLoad = null;

// A lone <input> inside a <form> submits on Enter natively (HTML's implicit
// submission), so no keydown/Enter-key detection is needed here.
actUrlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submittedActLoad = loadActIntoPage(actUrlField.value);
});

async function loadActIntoPage(url) {
  actUrlField.value = url;
  retryButton.hidden = true;
  const reference = parseActReferenceFromUrl(url);
  if (!reference) {
    console.error(`Cannot load act: unparseable or untrusted URL "${url}"`);
    errorMessageElement.textContent = 'invalid act URL';
    return;
  }
  setParsedReferenceDataset(reference);

  const validation = validateActReference(reference);
  if (!validation.valid) {
    console.error(`Cannot load act: reference failed NFR-004 validation for URL "${url}"`);
    errorMessageElement.textContent = validation.error ?? 'invalid act URL';
    return;
  }
  errorMessageElement.textContent = '';

  // Runs WASM init alongside the network fetch, not after: both are independent
  // first-load costs (NFR-001).
  let loadResult, sqlite3;
  try {
    [loadResult, sqlite3] = await Promise.all([loadAct(reference), sqlite3InitModule()]);
  } catch (error) {
    // NFR-003: api.sejm.gov.pl unreachable or returning an HTTP error, distinct
    // from FR-002's "not supported yet" (a genuine act-type rejection, where
    // retrying would not help).
    console.error(`Cannot load act: fetch failed for URL "${url}"`, error);
    errorMessageElement.textContent = 'Błąd wczytywania ustawy.';
    retryButton.hidden = false;
    return;
  }
  if (!loadResult.supported) {
    errorMessageElement.textContent = loadResult.error;
    return;
  }

  const act = `${reference.publisher}/${reference.year}/${reference.position}`;
  // One tree feeds both search and browse, so they can't diverge.
  const tree = buildProvisionTree(loadResult.text, act);
  currentSearchIndexDb = buildSearchIndex(sqlite3, flattenToRecords(tree, act));
  renderBrowseView(tree, browseViewContainer, showRepealedCheckbox.checked);
  // Parses loadResult.text a second time (extractProvisionsFromActText already
  // did once): a single act's text, once per load, not a hot path, so not
  // worth changing both functions' signatures to share one parsed Document.
  actTitleElement.textContent = extractActTitle(loadResult.text);
}

async function loadInitialAct() {
  const urlParam = new URLSearchParams(window.location.search).get('url');
  if (urlParam) {
    await loadActIntoPage(urlParam);
    return;
  }
  await loadActIntoPage(DEFAULT_ACT_URL);
  // replaceState, not pushState: shareable link, no new history entry.
  history.replaceState(null, '', `?url=${encodeURIComponent(DEFAULT_ACT_URL)}`);
}

/** Exported so tests can await the initial load. */
export const initialActLoad = loadInitialAct();
