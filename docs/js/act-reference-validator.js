// NFR-004: validates a parsed act reference's values before it is ever used to
// build a fetch URL. FR-001's parser already pins the source URL's hostname;
// this validates the *values* extracted from it, closing off a crafted
// well-formed-but-out-of-range reference reaching a real fetch unrejected.
/** FR-002's error for an act that is not supported, shared by every rejection of that kind. */
export const UNSUPPORTED_ACT_ERROR = 'Ten akt nie jest jeszcze obsługiwany.';
const PUBLISHER = 'DU';
const WELL_FORMED_PUBLISHER_PATTERN = /^[A-Z]{2}$/;
const YEAR_PATTERN = /^(19|20)\d{2}$/;
const POSITION_PATTERN = /^[1-9]\d*$/;

/**
 * Validates a parsed act reference against NFR-004's fixed patterns.
 * @param {{publisher: string, year: string, position: string}} reference
 * @returns {{valid: true} | {valid: false, error: string | null}} error is the
 *   unsupported-act message (FR-002's own act-type-rejection UX) for a
 *   well-formed but non-DU publisher, or null for any other rejection.
 */
export function validateActReference(reference) {
  if (!YEAR_PATTERN.test(reference.year) || !POSITION_PATTERN.test(reference.position)) {
    return { valid: false, error: null };
  }
  if (reference.publisher === PUBLISHER) {
    return { valid: true };
  }
  if (WELL_FORMED_PUBLISHER_PATTERN.test(reference.publisher)) {
    return { valid: false, error: UNSUPPORTED_ACT_ERROR };
  }
  return { valid: false, error: null };
}
