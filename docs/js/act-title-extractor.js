import { extractSegments } from './act-provision-extractor.js';

/**
 * Extracts the loaded act's own human-readable title from its fetched
 * text.html (FR-016), reusing the already-fetched string rather than a
 * separate request, as text and footnote-marker segments (FR-019). For a
 * consolidated-text Obwieszczenie, part_2's own heading names the underlying
 * Ustawa (e.g. "Załącznik - Tekst jednolity ustawy..."), minus its
 * "Załącznik" prefix. Otherwise, the <h1> is used, rebuilt from its
 * head-type/head-date/head-title spans since they carry no whitespace
 * between them in the source markup.
 * @param {string} html - the fetched text.html document.
 * @returns {Array<import('./act-provision-extractor.js').TextSegment>} the
 *   title's segments, or [] if no heading could be found.
 */
export function extractActTitleSegments(html) {
  const document = new DOMParser().parseFromString(html, 'text/html');

  const consolidatedHeading = document.getElementById('part_2')?.querySelector('h2.part');
  if (consolidatedHeading) {
    const segments = tidySegments(extractSegments(consolidatedHeading));
    if (segments[0]?.type === 'text') {
      segments[0].value = segments[0].value.replace(/^Załącznik\s*-\s*/, '');
    }
    return segments;
  }

  const heading = document.querySelector('h1');
  if (!heading) {
    return [];
  }
  const headingParts = heading.querySelectorAll('.head-type, .head-date, .head-title');
  return tidySegments([...headingParts].flatMap((part) => [...extractSegments(part), { type: 'text', value: ' ' }]));
}

/**
 * Merges adjacent text segments, collapses whitespace inside them and trims
 * the two ends. A single space next to a footnote marker is kept, as in the source.
 */
function tidySegments(segments) {
  const tidied = [];
  for (const segment of segments) {
    const previous = tidied.at(-1);
    if (segment.type !== 'text') {
      tidied.push(segment);
    } else if (previous?.type === 'text') {
      previous.value = `${previous.value}${segment.value}`.replace(/\s+/g, ' ');
    } else {
      tidied.push({ type: 'text', value: segment.value.replace(/\s+/g, ' ') });
    }
  }
  if (tidied[0]?.type === 'text') {
    tidied[0].value = tidied[0].value.trimStart();
  }
  if (tidied.at(-1)?.type === 'text') {
    tidied.at(-1).value = tidied.at(-1).value.trimEnd();
  }
  return tidied.filter((segment) => segment.type !== 'text' || segment.value);
}
