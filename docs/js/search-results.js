import { createRevealLink, provisionAnchorId, provisionBreadcrumb } from './browse-view.js';
import { MATCH_START, MATCH_END } from './act-search-index.js';

const HIGHLIGHT_PATTERN = new RegExp(`${MATCH_START}(.*?)${MATCH_END}`, 'gs');

/**
 * Renders search results (FR-008): each shows the legal reference, a
 * breadcrumb that doubles as an in-page link revealing and scrolling to the
 * same provision in the browse view, a new-tab source link, and the exact
 * provision text.
 * @param {Array<{act: string, division: string, chapter: string, article: string, paragraph: string,
 *   point: string, letter: string, text: string, highlighted_text: string, source: string}>} results
 *   - ranked provision records, e.g. searchIndex()'s output.
 * @param {HTMLElement} container - element to render into; its previous content is cleared.
 */
export function renderSearchResults(results, container) {
  container.textContent = '';
  container.append(...results.map(renderResultItem));
}

function renderResultItem(record) {
  const anchorId = provisionAnchorId(record);
  const breadcrumb = provisionBreadcrumb(record);
  const breadcrumbLink = createRevealLink(breadcrumb, anchorId, `${breadcrumb} - pokaż w widoku przeglądania`);

  const header = document.createElement('p');
  header.append(`${record.act} `, breadcrumbLink);
  // FR-025: a dataset provision has no address of its own, only the in-page "#id", so it has no source link.
  if (!record.source.startsWith('#')) {
    const sourceLink = document.createElement('a');
    sourceLink.href = record.source;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.className = 'source-link';
    sourceLink.textContent = 'Źródło';
    // The no-break space adds to the ordinary one, which alone leaves the button tucked against the breadcrumb link.
    header.append(' \u00a0', sourceLink);
  }

  const text = document.createElement('p');
  appendHighlightedText(text, record.highlighted_text);

  const item = document.createElement('li');
  item.append(header, text);
  return item;
}

/**
 * FR-017: appends record.highlighted_text (FTS5's highlight() output, matched
 * spans wrapped in MATCH_START/MATCH_END) as alternating text and <mark>
 * nodes. Never innerHTML: the delimiters are plain text, not markup.
 */
function appendHighlightedText(element, highlightedText) {
  highlightedText.split(HIGHLIGHT_PATTERN).forEach((part, index) => {
    if (index % 2 === 0) {
      element.append(document.createTextNode(part));
    } else {
      const mark = document.createElement('mark');
      mark.append(document.createTextNode(part));
      element.append(mark);
    }
  });
}
