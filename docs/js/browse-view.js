/**
 * Renders the browse view (FR-009) from buildProvisionTree()'s tree: a chpt
 * node is a collapsible Rozdział; every other node prints its own heading
 * (copied verbatim from ELI's own <h3>, e.g. "3a.", "1a)"; empty when the
 * source has no wrapper unit there) and own text, then recurses into its
 * children as a nested list. No numbering is computed, only copied.
 * @param {import('./act-provision-extractor.js').ProvisionNode} tree - buildProvisionTree()'s
 *   return value.
 * @param {HTMLElement} container - element to render into; its previous content is cleared.
 * @param {boolean} showRepealed - FR-010: when false, a repealed unit is not rendered at all.
 */
export function renderBrowseView(tree, container, showRepealed) {
  container.textContent = '';
  const topLevelNodes = filterRepealedNodes(tree.children, showRepealed);
  const hasChapters = topLevelNodes.some((node) => node.type === 'chpt');

  if (hasChapters) {
    topLevelNodes.forEach((chapter, index) => {
      container.append(renderChapterSection(chapter, index, showRepealed));
    });
  } else {
    container.append(...renderArticles(topLevelNodes, showRepealed));
  }

  const footnotesSection = renderFootnotesSection(tree.footnotes);
  if (footnotesSection) {
    container.append(footnotesSection);
  }
}

/**
 * A collapsed-by-default section (a Rozdział, FR-019's glossary): a button
 * toggles `aria-expanded` and the content div's `hidden` state together.
 * @param {string} buttonLabel
 * @param {string} contentId
 * @param {Array<Node>} contentChildren
 */
function renderCollapsibleSection(buttonLabel, contentId, contentChildren) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', contentId);
  button.textContent = buttonLabel;

  const heading = document.createElement('h3');
  heading.append(button);

  const content = document.createElement('div');
  content.id = contentId;
  content.hidden = true;
  content.append(...contentChildren);

  button.addEventListener('click', () => {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    content.hidden = expanded;
  });

  const section = document.createElement('section');
  section.append(heading, content);
  return section;
}

/**
 * FR-019: the document's glossary, one entry per footnote marker, collapsed by
 * default; null if the act has no footnotes. A <ul>, not <ol>: each entry
 * already carries its own real marker text, so a browser-generated list
 * number would double up.
 */
function renderFootnotesSection(footnotes) {
  if (!footnotes.length) {
    return null;
  }
  const list = document.createElement('ul');
  list.className = 'provision-list';
  list.append(
    ...footnotes.map((footnote) => {
      const item = document.createElement('li');
      item.id = footnote.id;
      item.append(document.createTextNode(`${footnote.marker} ${footnote.text}`));
      return item;
    }),
  );
  return renderCollapsibleSection('Odnośniki', 'footnotes-content', [list]);
}

function renderChapterSection(chapterNode, index, showRepealed) {
  const articles = renderArticles(filterRepealedNodes(chapterNode.children, showRepealed), showRepealed);
  return renderCollapsibleSection(chapterNode.heading, `chapter-content-${index}`, articles);
}

function renderArticles(articleNodes, showRepealed) {
  return articleNodes.map((article) => {
    const heading = document.createElement('h4');
    appendSegments(heading, article.headingSegments);

    const articleElement = document.createElement('article');
    articleElement.append(heading);
    if (article.ownText) {
      articleElement.append(renderProvisionParagraph(article));
    }
    const list = renderProvisionList(article.children, showRepealed);
    if (list) {
      articleElement.append(list);
    }
    return articleElement;
  });
}

/** A <ul> for one nesting level (pass, then point, then letter), or null if nothing is visible there. */
function renderProvisionList(nodes, showRepealed) {
  const visibleNodes = filterRepealedNodes(nodes, showRepealed);
  if (!visibleNodes.length) {
    return null;
  }
  const list = document.createElement('ul');
  list.className = 'provision-list';
  list.append(...visibleNodes.map((node) => renderProvisionItem(node, showRepealed)));
  return list;
}

function renderProvisionItem(node, showRepealed) {
  const item = document.createElement('li');
  item.id = node.id;

  const marker = document.createElement('span');
  appendSegments(marker, node.headingSegments);
  marker.append(document.createTextNode(' '));
  item.append(marker);

  if (node.ownText) {
    appendSegments(item, node.ownTextSegments);
  }

  const list = renderProvisionList(node.children, showRepealed);
  if (list) {
    item.append(list);
  }
  return item;
}

function renderProvisionParagraph(node) {
  const paragraph = document.createElement('p');
  appendSegments(paragraph, node.ownTextSegments);
  return paragraph;
}

/** FR-010: nodes excluding repealed ones, unless showRepealed is true. */
function filterRepealedNodes(nodes, showRepealed) {
  return showRepealed ? nodes : nodes.filter((node) => !node.repealed);
}

/**
 * FR-019: appends each segment as plain text, or a footnote marker as a
 * superscript link (never innerHTML: the text is externally-sourced).
 * @param {HTMLElement} element
 * @param {Array<import('./act-provision-extractor.js').TextSegment>} segments
 */
export function appendSegments(element, segments) {
  for (const segment of segments) {
    element.append(segment.type === 'footnote' ? renderFootnoteLink(segment) : document.createTextNode(segment.value));
  }
}

/** A footnote marker rendered as a superscript in-page link to its glossary entry (FR-019). */
function renderFootnoteLink(segment) {
  const link = createRevealLink(segment.marker, segment.targetId, `Przypis ${segment.marker} - pokaż wyjaśnienie`);
  const sup = document.createElement('sup');
  sup.append(link);
  return sup;
}

/**
 * An <a href="#targetId"> that reveals/scrolls to its target via
 * revealProvision() on click (FR-008's breadcrumb link, FR-019's footnote
 * link), instead of native anchor navigation.
 * @param {string} text
 * @param {string} targetId
 * @param {string} accessibleLabel - states the link's action, not just its text (WCAG 2.2).
 */
export function createRevealLink(text, targetId, accessibleLabel) {
  const link = document.createElement('a');
  link.href = `#${targetId}`;
  link.textContent = text;
  link.setAttribute('aria-label', accessibleLabel);
  link.addEventListener('click', (event) => {
    event.preventDefault();
    revealProvision(targetId);
  });
  return link;
}

/** FR-010: records/results excluding repealed ones, unless showRepealed is true. */
export function filterRepealed(records, showRepealed) {
  return showRepealed ? records : records.filter((record) => !record.repealed);
}

/** The DOM id a provision's browse-view <li> is anchored under, e.g. for FR-008's in-page link. */
export function provisionAnchorId(record) {
  return record.source.slice(record.source.indexOf('#') + 1);
}

/**
 * Expands the provision's containing Rozdział if collapsed, then scrolls to
 * it (FR-008/FR-019's in-page links): a hidden ancestor stops native anchor
 * navigation from revealing or scrolling to the target. Clearing the sticky
 * header is the target's own `scroll-margin-top` (style.css), kept in sync
 * by a ResizeObserver (app.js), so scrollIntoView() handles it natively.
 * @param {string} anchorId - id from provisionAnchorId(), or a footnote's targetId.
 */
export function revealProvision(anchorId) {
  const target = document.getElementById(anchorId);
  if (!target) return;

  // Only one level of hiding exists today (a chapter's content div).
  const content = target.closest('[hidden]');
  if (content) {
    content.hidden = false;
    content.parentElement?.querySelector('button[aria-controls]')?.setAttribute('aria-expanded', 'true');
  }

  target.scrollIntoView();
}

/** ust./pkt./lit. segments for FR-008's search-result breadcrumb. */
function paragraphPointLetterSegments(record) {
  return [
    record.paragraph && `ust. ${record.paragraph}`,
    record.point && `pkt ${record.point}`,
    record.letter && `lit. ${record.letter}`,
  ].filter(Boolean);
}

/** FR-008: full breadcrumb for a provision, e.g. "Rozdział 11 > Art. 109b > ust. 1 > pkt 1 > lit. a". */
export function provisionBreadcrumb(record) {
  return [
    record.chapter && `Rozdział ${record.chapter}`,
    record.article && `Art. ${record.article}`,
    ...paragraphPointLetterSegments(record),
  ]
    .filter(Boolean)
    .join(' > ');
}
