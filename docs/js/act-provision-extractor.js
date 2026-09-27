import { API_PREFIX } from './act-metadata-checker.js';

const FIELD_BY_UNIT_TYPE = {
  bran: 'division',
  chpt: 'chapter',
  arti: 'article',
  pass: 'paragraph',
  pint: 'point',
  lett: 'letter',
};

/** The record field for a unit's title. No entry for schp: an Oddział is a heading only. */
const TITLE_FIELD_BY_UNIT_TYPE = {
  bran: 'division_title',
  chpt: 'chapter_title',
};

/**
 * @typedef {object} ProvisionNode
 * @property {string|null} type - the unit type (bran/chpt/schp/arti/pass/pint/lett), null for the tree root.
 * @property {string} value - this unit's own local ordinal (e.g. "3a" for pass_3a), '' for the root.
 * @property {string} id - the unit's own element id (e.g. "chpt_1-arti_3-pint_1"), '' for the root.
 * @property {string} heading - this unit's own <h3> text, copied verbatim from the source (e.g.
 *   "3a.", "1a)", "Art. 14aa.", "Rozdział 1 Przepisy ogólne"); '' for the root, which has none.
 * @property {string} unitTitle - a bran, chpt or schp node's own title (e.g. "Przepisy ogólne"), '' otherwise.
 * @property {string} ownText - this unit's own directly-owned provision text, '' if it has none
 *   (e.g. an ust. with no lead sentence before its enumerated pkt. items).
 * @property {string} source - link to this unit on the ELI page, anchored by `id`; '' for the root.
 * @property {Array<TextSegment>} headingSegments - `heading`, but with each footnote marker kept as
 *   its own segment instead of excluded (FR-019); [] for the root.
 * @property {Array<TextSegment>} ownTextSegments - `ownText`, but with each footnote marker kept as
 *   its own segment instead of excluded (FR-019); [] for the root.
 * @property {Array<ProvisionNode>} children - nested units, in document order.
 * @property {Array<Footnote>} [footnotes] - the document's glossary entries (FR-019); only present
 *   on the root, since it's document-level, not per-unit.
 */

/**
 * @typedef {{type: 'text', value: string} | {type: 'footnote', marker: string, targetId: string}} TextSegment
 */

/**
 * @typedef {object} Footnote
 * @property {string} id - the glossary entry's own id (e.g. "gloss-0:34:"), matching a
 *   TextSegment footnote's targetId.
 * @property {string} marker - the footnote's own marker text (e.g. "34)").
 * @property {string} text - the footnote's explanation text.
 */

/**
 * Parses a fetched act's text.html into a tree mirroring the source's own
 * nested unit structure (bran > chpt > schp > arti > pass > pint > lett, the
 * first three optional: Dział, Rozdział, Oddział), reading only the last
 * part_N section (part_2 when present, otherwise part_1). Every heading
 * is copied verbatim from the source's own <h3>, never computed, since real
 * acts renumber via letter-suffixed insertions (e.g. "3a.", "14aa.").
 * FR-006 and FR-009 both render from this same tree.
 * @param {string} html - the fetched text.html document.
 * @param {string} act - the act reference (e.g. "DU/2024/1292") this text belongs to.
 * @returns {ProvisionNode} the tree root (type: null).
 */
export function buildProvisionTree(html, act) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const part = document.getElementById('part_2') ?? document.getElementById('part_1');
  const root = {
    type: null, value: '', id: '', heading: '', unitTitle: '', ownText: '', source: '',
    headingSegments: [], ownTextSegments: [], children: [], footnotes: [],
  };
  if (!part) {
    return root;
  }
  root.footnotes = extractFootnotes(part);

  const nodeByUnit = new Map();
  for (const unitElement of part.querySelectorAll('.unit')) {
    nodeByUnit.set(unitElement, buildNode(unitElement, act));
  }
  for (const [unitElement, node] of nodeByUnit) {
    const parentUnit = unitElement.parentElement?.closest('.unit') ?? null;
    (parentUnit ? nodeByUnit.get(parentUnit) : root).children.push(node);
  }
  return root;
}

/** FR-019: the glossary entries a footnote marker's targetId points to, e.g. `<DIV CLASS="gloss" ID="gloss-0:34:">`. */
function extractFootnotes(part) {
  return [...part.querySelectorAll('.gloss-section .gloss')].map((glossElement) => {
    const [markerElement, textElement] = glossElement.querySelectorAll(':scope > div');
    return {
      id: glossElement.id,
      marker: markerElement?.textContent.trim() ?? '',
      text: textElement?.textContent.trim() ?? '',
    };
  });
}

function buildNode(unitElement, act) {
  const [type, value] = (unitElement.dataset.id ?? '').split(/_(.*)/s);
  const ownTextElement = [...unitElement.querySelectorAll('[data-template="xText"]')].find(
    (element) => element.closest('.unit') === unitElement,
  );
  const h3 = unitElement.querySelector(':scope > h3');
  const ownText = ownTextElement ? visibleTextContent(ownTextElement).trim() : '';

  return {
    type,
    value: value ?? '',
    id: unitElement.id,
    heading: extractHeadingText(h3),
    // Read for every unit type, not only the titled ones: one query scoped to the own <h3>, so not worth a type guard.
    unitTitle: visibleTextContent(h3?.querySelector('.pro-title-unit')).trim(),
    ownText,
    source: `${API_PREFIX}${act}/text.html#${unitElement.id}`,
    headingSegments: h3 ? extractSegments(h3) : [],
    ownTextSegments: ownTextElement ? extractSegments(ownTextElement) : [],
    children: [],
  };
}

/**
 * A footnote marker is a <A class="gloss-link tooltip"> wrapping a visible
 * <sup> plus a hidden <span class="tooltip-text"> (shown only on ELI's own
 * hover). Excludes the whole marker, not just the hidden part: the flat
 * `ownText`/`heading` strings feed the search index, where a footnote
 * marker is noise. FR-019's `ownTextSegments`/`headingSegments`
 * (extractSegments()) keep it instead, for browse-view rendering. Accepts a text node too (h3.childNodes can hold
 * either), returned unchanged since a text node can't contain a gloss-link.
 */
function visibleTextContent(node) {
  if (!node) {
    return '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return node.textContent;
  }
  // querySelectorAll only matches descendants, not node itself.
  if (node.classList.contains('gloss-link')) {
    return '';
  }
  const clone = node.cloneNode(true);
  clone.querySelectorAll('.gloss-link').forEach((glossLink) => glossLink.remove());
  return clone.textContent;
}

/** A gloss-link's own visible marker text (its <sup>), excluding its hidden tooltip explanation. */
function footnoteMarkerText(glossLinkElement) {
  const clone = glossLinkElement.cloneNode(true);
  clone.querySelectorAll('.tooltip-text').forEach((tooltip) => tooltip.remove());
  return clone.textContent.trim();
}

/**
 * Like visibleTextContent(), but keeps each footnote marker as its own
 * segment (FR-019) instead of excluding it, so a caller can render it
 * in place (e.g. as a superscript link) rather than as flattened text.
 * @param {Node} node
 * @returns {Array<TextSegment>}
 */
export function extractSegments(node) {
  const segments = [];
  let textBuffer = '';
  const flushText = () => {
    if (textBuffer) {
      segments.push({ type: 'text', value: textBuffer });
      textBuffer = '';
    }
  };

  (function walk(current) {
    for (const child of current.childNodes) {
      if (child.nodeType !== Node.ELEMENT_NODE) {
        textBuffer += child.textContent;
      } else if (child.classList.contains('gloss-link')) {
        flushText();
        segments.push({
          type: 'footnote',
          marker: footnoteMarkerText(child),
          targetId: (child.getAttribute('href') ?? '').replace(/^#/, ''),
        });
      } else {
        walk(child);
      }
    }
  })(node);
  flushText();
  return segments;
}

/** Collapses runs of whitespace (including &nbsp;) to a single space and trims. */
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** h3's marker text can be split across child nodes with no whitespace between them. */
function extractHeadingText(h3) {
  if (!h3) {
    return '';
  }
  return normalizeWhitespace([...h3.childNodes].map((node) => visibleTextContent(node).trim()).filter(Boolean).join(' '));
}

/**
 * Flattens buildProvisionTree()'s tree into one record per own-text unit,
 * the Data Model shape FR-006/007/008/014/016 consume.
 * @param {ProvisionNode} tree - buildProvisionTree()'s return value.
 * @param {string} act - the act reference these records belong to.
 * @returns {Array<{act: string, division: string, division_title: string, chapter: string,
 *   chapter_title: string, article: string, paragraph: string, point: string, letter: string,
 *   text: string, source: string}>}
 */
export function flattenToRecords(tree, act) {
  const records = [];
  // Spelled out, not derived from the lookup tables, so the record shape is visible in one place.
  const noUnits = { division: '', division_title: '', chapter: '', chapter_title: '', article: '', paragraph: '', point: '', letter: '' };
  collectRecords(tree, { act, ...noUnits }, records);
  return records;
}

function collectRecords(node, ancestorFields, records) {
  const fields = { ...ancestorFields };
  const field = FIELD_BY_UNIT_TYPE[node.type];
  if (field) {
    fields[field] = node.value;
    const titleField = TITLE_FIELD_BY_UNIT_TYPE[node.type];
    if (titleField) {
      fields[titleField] = node.unitTitle;
    }
  }

  if (node.ownText) {
    records.push({ ...fields, text: node.ownText, source: node.source });
  }
  for (const child of node.children) {
    collectRecords(child, fields, records);
  }
}

/**
 * Parses a fetched act's text.html directly into the Data Model's flat
 * provision records: buildProvisionTree() + flattenToRecords() combined, for
 * callers that only need the flat shape (FR-006/007/008/010/014/016).
 * @param {string} html - the fetched text.html document.
 * @param {string} act - the act reference (e.g. "DU/2024/1292") this text belongs to.
 * @returns {ReturnType<typeof flattenToRecords>}
 */
export function extractProvisionsFromActText(html, act) {
  return flattenToRecords(buildProvisionTree(html, act), act);
}
