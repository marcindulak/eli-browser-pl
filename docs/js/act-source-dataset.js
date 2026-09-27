/** FR-025: fixed prefix of the dataset's per-act JSON files; only validated year and position are appended (NFR-004). */
export const DATASET_PREFIX = 'https://raw.githubusercontent.com/PolskiAgentW/dziennik-ustaw-md/main/DU/';

/** The unit type of each numbered dataset node, and its own heading, which the dataset does not store: rebuilt from the number. */
const UNIT_BY_DATASET_TYPE = {
  art: { unitType: 'arti', heading: (number) => `Art. ${number}.` },
  ust: { unitType: 'pass', heading: (number) => `${number}.` },
  par: { unitType: 'pass', heading: (number) => `§ ${number}.` },
  pkt: { unitType: 'pint', heading: (number) => `${number})` },
  lit: { unitType: 'lett', heading: (number) => `${number})` },
};

const DIVISION_TYPE_BY_LABEL_WORD = { dział: 'bran', rozdział: 'chpt', oddział: 'schp' };
const DIVISION_DEPTH = { bran: 1, chpt: 2, schp: 3 };
const FOOTNOTE_MARKER = /\[\^([^\]]+)\]/g;

/** Own-property lookup: a dataset value such as "constructor" must not resolve to an inherited member. */
function lookup(table, key) {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Fetches the dataset's JSON tree of an act.
 * Caller must have already validated `reference` per NFR-004; this builds the URL directly from it.
 * @param {{publisher: string, year: string, position: string}} reference
 * @returns {Promise<object | null>} the parsed JSON, or null for a 404 (the dataset does not hold the act).
 * @throws on an unreachable host or any other HTTP error status (NFR-003 owns the retry).
 */
export async function fetchDatasetAct(reference) {
  const response = await fetch(`${DATASET_PREFIX}${reference.year}/DU-${reference.year}-${reference.position}.json`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`dataset fetch failed: ${response.status}`);
  }
  return response.json();
}

/**
 * Converts a dataset JSON tree into the ProvisionNode tree buildProvisionTree() returns for Sejm HTML,
 * so every consumer reads either source unchanged. The JSON lists Dział, Rozdział and Oddział as flat
 * sibling headings, which are nested here by document order. Unit ids are generated, because the
 * dataset's paths repeat for an article published in two wordings, and `source` is only the in-page
 * `#id`, since the dataset has no per-provision address.
 * @param {object} dataset - the parsed JSON from fetchDatasetAct().
 * @returns {{tree: import('./act-provision-extractor.js').ProvisionNode,
 *   titleSegments: Array<import('./act-provision-extractor.js').TextSegment>}}
 */
export function buildDatasetProvisionTree(dataset) {
  const root = {
    ...createNode(null, '', '', ''),
    footnotes: Object.entries(dataset.footnotes).map(([key, text]) => ({ id: `fn-${key}`, marker: `${key})`, text })),
  };
  const usedIds = new Set();
  const openDivisions = [];
  for (const datasetNode of dataset.body) {
    if (datasetNode.type === 'heading') {
      const divisionType = getDivisionType(datasetNode.label);
      while (openDivisions.length && DIVISION_DEPTH[openDivisions.at(-1).type] >= DIVISION_DEPTH[divisionType]) {
        openDivisions.pop();
      }
      const parent = openDivisions.at(-1) ?? root;
      const division = createDivision(datasetNode, divisionType, parent, usedIds);
      parent.children.push(division);
      openDivisions.push(division);
    } else if (lookup(UNIT_BY_DATASET_TYPE, datasetNode.type)) {
      const parent = openDivisions.at(-1) ?? root;
      parent.children.push(convertUnit(datasetNode, parent.id, usedIds));
    } else if (datasetNode.type !== 'text' && datasetNode.type !== 'signature') {
      console.error(`Dataset node of type "${datasetNode.type}" ignored`);
    }
  }
  return { tree: root, titleSegments: [{ type: 'text', value: dataset.title }] };
}

/**
 * The division type of a heading's label (e.g. "DZIAŁ I"). A heading of another kind
 * (e.g. "Księga") is logged and treated as a Rozdział, so its content stays grouped.
 */
function getDivisionType(label) {
  const type = lookup(DIVISION_TYPE_BY_LABEL_WORD, label.split(/\s+/)[0].toLowerCase());
  if (!type) {
    console.error(`Dataset heading "${label}" is not a Dział, Rozdział or Oddział`);
    return 'chpt';
  }
  return type;
}

function createDivision(datasetNode, type, parent, usedIds) {
  const value = datasetNode.label.slice(datasetNode.label.split(/\s+/)[0].length).trim();
  const id = uniqueId(getChildId(parent.id, type, value), usedIds);
  const division = createNode(type, value, id, `${datasetNode.label} ${datasetNode.text}`.trim());
  division.unitTitle = datasetNode.text;
  return division;
}

/** `parentId` is the id of the enclosing division or unit, '' at the top. */
function convertUnit(datasetNode, parentId, usedIds) {
  const { unitType, heading } = lookup(UNIT_BY_DATASET_TYPE, datasetNode.type);
  const id = uniqueId(getChildId(parentId, unitType, datasetNode.num), usedIds);
  const node = createNode(unitType, datasetNode.num, id, heading(datasetNode.num));
  addOwnText(node, datasetNode.text);
  for (const child of datasetNode.children ?? []) {
    addChild(node, child, usedIds);
  }
  node.ownText = node.ownTextSegments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.value)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return node;
}

/** An unnumbered paragraph, quoted text or tiret belongs to the unit above it, as in the Sejm HTML. */
function addChild(node, child, usedIds) {
  if (child.type === 'text') {
    addOwnText(node, child.text);
  } else if (child.type === 'tir') {
    addOwnText(node, `– ${child.text}`);
    for (const tirChild of child.children ?? []) {
      addChild(node, tirChild, usedIds);
    }
  } else if (lookup(UNIT_BY_DATASET_TYPE, child.type)) {
    node.children.push(convertUnit(child, node.id, usedIds));
  } else {
    console.error(`Dataset node of type "${child.type}" ignored`);
  }
}

/** The id of a unit inside `parentId`, which is '' at the top. */
function getChildId(parentId, type, value) {
  return parentId ? `${parentId}-${type}_${value}` : `${type}_${value}`;
}

/** Appends a suffix to an id the dataset has already produced once (an article published in two wordings). */
function uniqueId(id, usedIds) {
  let candidate = id;
  for (let copy = 2; usedIds.has(candidate); copy += 1) {
    candidate = `${id}_${copy}`;
  }
  usedIds.add(candidate);
  return candidate;
}

function createNode(type, value, id, heading) {
  return {
    type, value, id, heading, unitTitle: '', ownText: '', source: id ? `#${id}` : '',
    headingSegments: segmentsFromText(heading), ownTextSegments: [], children: [],
  };
}

/** Appends `text` to the node's own text segments, with a space before it when the node already has some. */
function addOwnText(node, text) {
  if (!text) {
    return;
  }
  if (node.ownTextSegments.length) {
    node.ownTextSegments.push({ type: 'text', value: ' ' });
  }
  node.ownTextSegments.push(...segmentsFromText(text));
}

/** Splits inline `[^key]` footnote markers out of `text` as FR-019 footnote segments. */
function segmentsFromText(text) {
  const segments = [];
  let textStart = 0;
  for (const match of text.matchAll(FOOTNOTE_MARKER)) {
    if (match.index > textStart) {
      segments.push({ type: 'text', value: text.slice(textStart, match.index) });
    }
    segments.push({ type: 'footnote', marker: `${match[1]})`, targetId: `fn-${match[1]}` });
    textStart = match.index + match[0].length;
  }
  if (textStart < text.length) {
    segments.push({ type: 'text', value: text.slice(textStart) });
  }
  return segments;
}
