import { buildProvisionTree } from './act-provision-extractor.js';
import { buildDatasetProvisionTree } from './act-source-dataset.js';
import { extractActTitleSegments } from './act-title-extractor.js';

/**
 * Maps a loadAct() result's `textSource` to the function that turns its payload into the provision tree,
 * title and footnotes every consumer reads. A further text source adds a loader branch in loadAct()
 * and one entry here. `isUnofficialConversion` makes the page show FR-025's notice.
 */
const PARSER_BY_TEXT_SOURCE = {
  'sejm-html': (loadResult, act) => ({
    tree: buildProvisionTree(loadResult.text, act),
    titleSegments: extractActTitleSegments(loadResult.text),
    isUnofficialConversion: false,
  }),
  dataset: (loadResult) => ({ ...buildDatasetProvisionTree(loadResult.dataset), isUnofficialConversion: true }),
};

/**
 * @param {{textSource: string}} loadResult - a supported loadAct() result.
 * @param {string} act - the act reference (e.g. "DU/2024/1292") the text belongs to.
 * @returns {{tree: import('./act-provision-extractor.js').ProvisionNode,
 *   titleSegments: Array<import('./act-provision-extractor.js').TextSegment>, isUnofficialConversion: boolean}}
 */
export function parseLoadedAct(loadResult, act) {
  return PARSER_BY_TEXT_SOURCE[loadResult.textSource](loadResult, act);
}
