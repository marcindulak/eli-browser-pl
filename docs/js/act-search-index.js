const PROVISION_COLUMNS = ['act', 'chapter', 'chapter_title', 'article', 'paragraph', 'point', 'letter', 'text', 'repealed', 'source'];
const TEXT_COLUMN_INDEX = PROVISION_COLUMNS.indexOf('text');

// FR-017: delimiters FTS5's highlight() wraps matched spans with. Control
// characters, not HTML: rendering splits on them into text/<mark> nodes,
// never through innerHTML, so they can never be confused with real text.
export const MATCH_START = '\x01';
export const MATCH_END = '\x02';

/**
 * Builds an in-memory SQLite FTS5 index over the Data Model's provision records (FR-006).
 * `text` is the only tokenized column, using the unicode61 tokenizer with diacritics folded;
 * every other field is stored UNINDEXED, kept for display rather than full-text matched.
 * @param {object} sqlite3 - an initialized `@sqlite.org/sqlite-wasm` module, imported and
 *   initialized by the caller at its own top level (see REQUIREMENTS.md's Technical Choices).
 * @param {Array<{act: string, chapter: string, chapter_title: string, article: string,
 *   paragraph: string, point: string, letter: string, text: string, repealed: boolean, source: string}>} records
 *   - provision records, e.g. extractProvisionsFromActText()'s output.
 * @returns {object} a sqlite-wasm `db` handle to pass to searchIndex().
 */
export function buildSearchIndex(sqlite3, records) {
  const db = new sqlite3.oo1.DB();

  // remove_diacritics 2 does not fold "ł" (a distinct letter, not "l" + a mark);
  // see REQUIREMENTS.md's Deferred Features for the considered workaround.
  const columnDefinitions = PROVISION_COLUMNS.map((column) => (column === 'text' ? column : `${column} UNINDEXED`));
  db.exec(`CREATE VIRTUAL TABLE provisions USING fts5(${columnDefinitions.join(', ')}, tokenize = "unicode61 remove_diacritics 2")`);

  const insertStatement = db.prepare(
    `INSERT INTO provisions (${PROVISION_COLUMNS.join(', ')}) VALUES (${PROVISION_COLUMNS.map(() => '?').join(', ')})`,
  );
  try {
    for (const record of records) {
      insertStatement.bind(PROVISION_COLUMNS.map((column) => (column === 'repealed' ? Number(record[column]) : record[column]))).stepReset();
    }
  } finally {
    insertStatement.finalize();
  }

  return db;
}

/**
 * Runs a full-text query against a FR-006 search index, best match first
 * (FTS5's "rank" column orders ascending by bm25, lower is better).
 * @param {object} db - sqlite-wasm `db` handle returned by buildSearchIndex().
 * @param {string} query - an FTS5 MATCH expression (FR-007 owns literal-text-vs-syntax interpretation).
 * @returns {Array<object>} matching provision records, best match first, each with an added
 *   `highlighted_text` field (FR-017): `text` with every FTS5-matched span wrapped in
 *   MATCH_START/MATCH_END.
 */
export function searchIndex(db, query) {
  const rows = db.exec({
    sql: `SELECT *, highlight(provisions, ${TEXT_COLUMN_INDEX}, ?, ?) AS highlighted_text
          FROM provisions WHERE provisions MATCH ? ORDER BY rank`,
    bind: [MATCH_START, MATCH_END, query],
    rowMode: 'object',
    returnValue: 'resultRows',
  });
  return rows.map((row) => ({ ...row, repealed: Boolean(row.repealed) }));
}
