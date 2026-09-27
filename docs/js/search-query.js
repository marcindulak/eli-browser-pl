const FTS5_SYNTAX_PATTERN = /["*()^]/;
const FTS5_KEYWORD_PATTERN = /\b(AND|OR|NOT|NEAR)\b/;

/**
 * Turns a raw search-box query into an FTS5 MATCH expression (FR-007).
 * With no FTS5 syntax present, each word is quoted individually and ANDed
 * (every word required, any order), `*` suffixed for a prefix match on the
 * last word (FR-015's live typing). Per-word quoting (not one whole-phrase
 * quote) stops a stray FTS5-meaningful character in one word (e.g. `:`) from
 * being misread as syntax. A blank query returns `'""'` (matches nothing);
 * everything else passes through unchanged (explicit phrases, operators, etc).
 * @param {string} rawQuery
 * @returns {string} an FTS5 MATCH expression
 */
export function toFtsQuery(rawQuery) {
  const hasFts5Syntax = FTS5_SYNTAX_PATTERN.test(rawQuery) || FTS5_KEYWORD_PATTERN.test(rawQuery);
  if (hasFts5Syntax) {
    return rawQuery;
  }
  const trimmed = rawQuery.trim();
  if (trimmed === '') {
    return '""';
  }
  return `${trimmed.split(/\s+/).map((word) => `"${word}"`).join(' AND ')}*`;
}
