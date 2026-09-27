import { validateActReference } from './act-reference-validator.js';

export const API_PREFIX = 'https://api.sejm.gov.pl/eli/acts/';

/**
 * Checks the act's metadata, then fetches its text.html only if supported: a
 * direct "Ustawa", or an "Obwieszczenie" whose "Tekst jednolity dla aktu"
 * reference names an act of type "Ustawa".
 * Caller must have already validated `reference` per NFR-004 (fixed
 * publisher/year/position patterns) before calling; this function builds a
 * fetch URL directly from it.
 * Throws on api.sejm.gov.pl being unreachable or returning a non-404 error
 * status (NFR-003 owns showing a retry option for that); a 404 (the act does
 * not exist) is reported as a normal `{supported: false}` result instead,
 * since retrying cannot succeed.
 * @param {{publisher: string, year: string, position: string}} reference
 * @returns {Promise<{supported: true, text: string} | {supported: false, error: string}>}
 */
export async function loadAct(reference) {
  const check = await checkActMetadata(reference);
  if (!check.supported) {
    return check;
  }
  const response = await fetch(`${API_PREFIX}${reference.publisher}/${reference.year}/${reference.position}/text.html`);
  if (!response.ok) {
    throw new Error(`text.html fetch failed: ${response.status}`);
  }
  return { ...check, text: await response.text() };
}

async function checkActMetadata(reference) {
  const metadata = await fetchActMetadata(reference);
  if (!metadata) {
    // See loadAct's docstring: a 404 is a normal outcome here, not thrown.
    return { supported: false, error: 'Nie znaleziono ustawy' };
  }

  if (metadata.type === 'Ustawa') {
    return { supported: true };
  }
  if (metadata.type !== 'Obwieszczenie') {
    return { supported: false, error: 'not supported yet' };
  }

  const consolidatedActId = metadata.references?.['Tekst jednolity dla aktu']?.[0]?.id;
  if (!consolidatedActId) {
    return { supported: false, error: 'not supported yet' };
  }

  // NFR-004: this reference is derived from the API's own response, not user
  // input, but still must be validated before it is appended to API_PREFIX,
  // per NFR-004's own "only the validated components appended" requirement.
  const consolidatedReference = parseActReferenceId(consolidatedActId);
  if (!validateActReference(consolidatedReference).valid) {
    return { supported: false, error: 'not supported yet' };
  }

  const consolidatedMetadata = await fetchActMetadata(consolidatedReference);
  // ?. folds a 404 here into "not supported yet" too: an unresolvable
  // consolidated reference is as unsupported as one of the wrong type.
  return consolidatedMetadata?.type === 'Ustawa'
    ? { supported: true }
    : { supported: false, error: 'not supported yet' };
}

function parseActReferenceId(id) {
  const [publisher, year, position] = id.split('/');
  return { publisher, year, position };
}

/** @returns {Promise<object | null>} the parsed metadata, or null for a 404 (see loadAct's docstring). */
function fetchActMetadata(reference) {
  return fetch(`${API_PREFIX}${reference.publisher}/${reference.year}/${reference.position}`).then((response) => {
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`metadata fetch failed: ${response.status}`);
    }
    return response.json();
  });
}
