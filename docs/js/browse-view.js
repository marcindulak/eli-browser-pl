/**
 * FR-019: the footnote marker link the reader last clicked, per glossary entry id, so the
 * entry's back link returns to it. A footnote can have several markers in the act.
 * @type {Map<string, HTMLAnchorElement>}
 */
const lastClickedMarkerByTargetId = new Map();

/**
 * Renders the browse view (FR-009) from buildProvisionTree()'s tree as collapsible
 * sections (see renderUnits()). Every other node prints its own heading
 * (copied verbatim from ELI's own <h3>, e.g. "3a.", "1a)"; empty when the
 * source has no wrapper unit there) and own text, then recurses into its
 * children as a nested list. No numbering is computed, only copied.
 * @param {import('./act-provision-extractor.js').ProvisionNode} tree - buildProvisionTree()'s
 *   return value.
 * @param {HTMLElement} container - element to render into; its previous content is cleared.
 */
export function renderBrowseView(tree, container) {
  container.textContent = '';
  lastClickedMarkerByTargetId.clear();
  container.append(...renderUnits(tree.children, []));

  const footnotesSection = renderFootnotesSection(tree.footnotes);
  if (footnotesSection) {
    container.append(footnotesSection);
  }
}

/**
 * A collapsed-by-default section (a Dział or Rozdział, FR-019's glossary): a button
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
      item.append(document.createTextNode(`${footnote.marker} ${footnote.text} `), renderBackButton(footnote));
      return item;
    }),
  );
  return renderCollapsibleSection('Odnośniki', 'footnotes-content', [list]);
}

/** FR-019: returns to the marker the reader came from, or to the footnote's first marker if none was clicked. */
function renderBackButton(footnote) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Wróć do tekstu';
  // WCAG 2.5.3: the accessible name starts with the visible text.
  button.setAttribute('aria-label', `Wróć do tekstu, od przypisu ${footnote.marker}`);
  button.addEventListener('click', () => {
    const marker =
      lastClickedMarkerByTargetId.get(footnote.id) ??
      document.querySelector(`a.footnote-marker[data-footnote-target-id="${CSS.escape(footnote.id)}"]`);
    if (!marker) return;
    revealElement(marker);
    // The button scrolled away, so keyboard and screen reader users would otherwise be left on it.
    marker.focus({ preventScroll: true });
  });
  return button;
}

const isDivision = (node) => node.type === 'bran' || node.type === 'chpt';

/**
 * Renders sibling nodes. A Dział (bran) or Rozdział (chpt) that directly holds Artykuły or own
 * text becomes a collapsible section labelled "Dział ... > Rozdział ...", and its nested
 * Działy and Rozdziały follow as further sections. Any other node is rendered in place, so
 * nothing is dropped from an act that mixes top-level Artykuły with sections.
 * @param {Array<import('./act-provision-extractor.js').ProvisionNode>} nodes
 * @param {Array<string>} ancestorHeadings - headings of the enclosing Działy, joined into the label.
 */
function renderUnits(nodes, ancestorHeadings) {
  return nodes.flatMap((node) => {
    if (!isDivision(node)) {
      return renderContent([node]);
    }
    const headings = [...ancestorHeadings, node.heading];
    const nestedSections = renderUnits(node.children.filter(isDivision), headings);
    const heldNodes = node.children.filter((child) => !isDivision(child));
    // Own text alone (e.g. a repealed Rozdział's "(uchylony)") still needs a section.
    if (!node.ownText && !heldNodes.length) {
      return nestedSections;
    }
    const content = [...ownTextParagraph(node), ...renderContent(heldNodes)];
    return [renderCollapsibleSection(headings.join(' > '), `section-content-${node.id}`, content), ...nestedSections];
  });
}

/** Renders an Oddział (schp) as a centered heading before its own content, and any other node as an Artykuł. */
function renderContent(nodes) {
  return nodes.flatMap((node) => {
    if (node.type !== 'schp') {
      return renderArticles([node]);
    }
    const heading = document.createElement('h4');
    heading.className = 'subdivision-heading';
    appendSegments(heading, node.headingSegments);
    return [heading, ...ownTextParagraph(node), ...renderContent(node.children)];
  });
}

/** The node's own text as a one-paragraph array, or an empty array when it has none. */
function ownTextParagraph(node) {
  return node.ownText ? [renderProvisionParagraph(node)] : [];
}

function renderArticles(articleNodes) {
  return articleNodes.map((article) => {
    const heading = document.createElement('h4');
    appendSegments(heading, article.headingSegments);

    const articleElement = document.createElement('article');
    // FR-008: target of the breadcrumb link of a result that is the Artykuł's own text.
    articleElement.id = article.id;
    articleElement.append(heading);
    if (article.ownText) {
      articleElement.append(renderProvisionParagraph(article));
    }
    const list = renderProvisionList(article.children);
    if (list) {
      articleElement.append(list);
    }
    return articleElement;
  });
}

/** A <ul> for one nesting level (pass, then point, then letter), or null if there are no nodes. */
function renderProvisionList(nodes) {
  if (!nodes.length) {
    return null;
  }
  const list = document.createElement('ul');
  list.className = 'provision-list';
  list.append(...nodes.map(renderProvisionItem));
  return list;
}

function renderProvisionItem(node) {
  const item = document.createElement('li');
  item.id = node.id;

  const marker = document.createElement('span');
  appendSegments(marker, node.headingSegments);
  marker.append(document.createTextNode(' '));
  item.append(marker);

  if (node.ownText) {
    appendSegments(item, node.ownTextSegments);
  }

  const list = renderProvisionList(node.children);
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
  link.className = 'footnote-marker';
  link.dataset.footnoteTargetId = segment.targetId;
  link.addEventListener('click', () => lastClickedMarkerByTargetId.set(segment.targetId, link));
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
  if (target) revealElement(target);
}

/** revealProvision()'s body for a target element that may have no id (a footnote marker, FR-019). */
function revealElement(target) {
  // Only one level of hiding exists today (a section's content div).
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

/** FR-008: full breadcrumb for a provision, e.g. "Dział II > Rozdział 11 > Art. 109b > ust. 1 > pkt 1 > lit. a". */
export function provisionBreadcrumb(record) {
  return [
    record.division && `Dział ${record.division}`,
    record.chapter && `Rozdział ${record.chapter}`,
    record.article && `Art. ${record.article}`,
    ...paragraphPointLetterSegments(record),
  ]
    .filter(Boolean)
    .join(' > ');
}
