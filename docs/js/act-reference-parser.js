// FR-001: parse an eli.gov.pl or ISAP DocDetails URL into {publisher, year, position}.
// api.sejm.gov.pl and eli.gov.pl are different domains serving the same documents,
// each under its own path convention (see REQUIREMENTS.md's Data Source section);
// eli.gov.pl itself has two: a human-facing page path and an /api/acts/ path.
// Hostnames are hardcoded and checked exactly (NFR-004-style host pinning): a
// URL whose path happens to match one of these shapes on an untrusted host must
// not be accepted, so an attacker-controlled domain can't pass itself off as a
// legitimate act reference.
const ELI_HOSTNAME = 'eli.gov.pl';
const ISAP_HOSTNAME = 'isap.sejm.gov.pl';

// Both patterns repeat the same publisher/year/position triplet; kept as two
// independent literals (WET) rather than a shared fragment, per CLAUDE.md's
// AHA guidance for exactly two occurrences.
// /ogl/pol is the form eli.gov.pl/search returns, /ogl the form its act pages link to.
const ELI_PAGE_PATH_PATTERN = /^\/eli\/(?<publisher>[^/]+)\/(?<year>[^/]+)\/(?<position>[^/]+)(?:\/ogl(?:\/pol)?)?\/?$/;
const ELI_API_PATH_PATTERN = /^\/api\/acts\/(?<publisher>[^/]+)\/(?<year>[^/]+)\/(?<position>[^/]+)(?:\/text\.html)?\/?$/;
const ISAP_ID_PATTERN = /^W(?<publisher>[A-Z]{2})(?<year>\d{4})(?<position>\d+)$/;

/**
 * Parses an act reference (publisher, year, position) out of a URL string.
 * @param {string} rawUrl - a URL entered by the user: an eli.gov.pl page URL, an
 *   eli.gov.pl /api/acts/ URL, or an ISAP DocDetails URL.
 * @returns {{publisher: string, year: string, position: string} | null} the parsed
 *   reference, or null if rawUrl is not a valid URL, is not on a recognized host,
 *   or matches no known path form for that host.
 */
export function parseActReferenceFromUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.hostname === ELI_HOSTNAME) {
    const eliPageMatch = url.pathname.match(ELI_PAGE_PATH_PATTERN);
    if (eliPageMatch) {
      const { publisher, year, position } = eliPageMatch.groups;
      return { publisher, year, position };
    }

    const eliApiMatch = url.pathname.match(ELI_API_PATH_PATTERN);
    if (eliApiMatch) {
      const { publisher, year, position } = eliApiMatch.groups;
      return { publisher, year, position };
    }
  }

  if (url.hostname === ISAP_HOSTNAME) {
    const isapMatch = url.searchParams.get('id')?.match(ISAP_ID_PATTERN);
    if (isapMatch) {
      const { publisher, year, position } = isapMatch.groups;
      return { publisher, year, position: String(parseInt(position, 10)) };
    }
  }

  return null;
}
