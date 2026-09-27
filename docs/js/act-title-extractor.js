/**
 * Extracts the loaded act's own human-readable title from its fetched
 * text.html (FR-016), reusing the already-fetched string rather than a
 * separate request. For a consolidated-text Obwieszczenie, part_2's own
 * heading names the underlying Ustawa (e.g. "Załącznik - Tekst jednolity
 * ustawy..."); the "Załącznik" prefix and any footnote marker in that heading
 * are dropped. Otherwise, the document's own <h1> is used, rebuilt from its
 * head-type/head-date/head-title spans since they carry no whitespace between
 * them in the source markup.
 * @param {string} html - the fetched text.html document.
 * @returns {string} the act's title, or '' if no heading could be found.
 */
export function extractActTitle(html) {
  const document = new DOMParser().parseFromString(html, 'text/html');

  const consolidatedHeading = document.getElementById('part_2')?.querySelector('h2.part');
  if (consolidatedHeading) {
    const heading = consolidatedHeading.cloneNode(true);
    heading.querySelectorAll('a').forEach((link) => link.remove());
    return normalizeWhitespace(heading.textContent).replace(/^Załącznik\s*-\s*/, '');
  }

  const heading = document.querySelector('h1');
  if (!heading) {
    return '';
  }
  const headingParts = [...heading.querySelectorAll('.head-type, .head-date, .head-title')].map((part) =>
    part.textContent.trim(),
  );
  return normalizeWhitespace(headingParts.join(' '));
}

/** Collapses runs of whitespace (including &nbsp;) to a single space and trims. */
export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}
