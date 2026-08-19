/**
 * Low-level OOXML helpers.
 *
 * INVARIANT 1 / 7: the template defines how the storyboard looks. Nothing here
 * authors formatting. Every function either reads structure or replaces the text
 * inside an existing run while leaving that run's properties untouched.
 *
 * Why a DOM rather than a templating library: the supplied template carries no
 * placeholders, and its 345KB of styles, its theme, numbering, header, footer and
 * section properties must survive byte-identical. Cloning real elements out of
 * the template and swapping only <w:t> content preserves formatting by
 * construction, so there is nothing for a validator to catch after the fact.
 */

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Document, Element, Node } from '@xmldom/xmldom';

// xmldom's DOM types are used rather than lib.dom's, so the project does not have
// to pull browser globals into a Node-only build.
export type { Document, Element, Node };

export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml');
}

export function serializeXml(node: Node): string {
  return new XMLSerializer().serializeToString(node);
}

/** Direct element children with the given local name, in document order. */
export function childElements(parent: Element | Document, localName: string): Element[] {
  const out: Element[] = [];
  const kids = parent.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const node = kids.item(i);
    if (node && node.nodeType === 1 && (node as Element).localName === localName) {
      out.push(node as Element);
    }
  }
  return out;
}

/** First direct element child with the given local name. */
export function firstChild(parent: Element | Document, localName: string): Element | undefined {
  return childElements(parent, localName)[0];
}

/** All descendant elements with the given local name, in document order. */
export function descendants(parent: Element | Document, localName: string): Element[] {
  const list = (parent as Element).getElementsByTagNameNS(W, localName);
  const out: Element[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list.item(i);
    if (item) out.push(item as Element);
  }
  return out;
}

/** Concatenated visible text of a paragraph, cell or table. */
export function textOf(node: Element): string {
  return descendants(node, 't')
    .map((t) => t.textContent ?? '')
    .join('');
}

/** The style id applied to a paragraph, e.g. "Heading1", or '' if unstyled. */
export function paragraphStyle(p: Element): string {
  const pPr = firstChild(p, 'pPr');
  if (!pPr) return '';
  const pStyle = firstChild(pPr, 'pStyle');
  return pStyle?.getAttributeNS(W, 'val') ?? pStyle?.getAttribute('w:val') ?? '';
}

/** Number of grid columns a cell spans (w:gridSpan), defaulting to 1. */
export function gridSpan(tc: Element): number {
  const tcPr = firstChild(tc, 'tcPr');
  if (!tcPr) return 1;
  const span = firstChild(tcPr, 'gridSpan');
  if (!span) return 1;
  const raw = span.getAttributeNS(W, 'val') ?? span.getAttribute('w:val');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function tableRows(tbl: Element): Element[] {
  return childElements(tbl, 'tr');
}

export function rowCells(tr: Element): Element[] {
  return childElements(tr, 'tc');
}

/**
 * Replaces a paragraph's text while preserving its paragraph properties and the
 * character formatting of its first run.
 *
 * Word splits a visually uniform paragraph into many runs for reasons unrelated
 * to appearance (spell-check state, revision ids, language runs). Rewriting the
 * first run and dropping the rest keeps the appearance the template defined and
 * avoids inheriting a mid-sentence formatting change from the sample content.
 *
 * If the paragraph has no run at all -- an empty spacer -- one is created by
 * cloning nothing and inserting a bare run, which Word renders using the
 * paragraph's own style.
 */
export function setParagraphText(p: Element, text: string): void {
  const doc = p.ownerDocument!;
  const runs = childElements(p, 'r');

  // Preserve the first run's properties, if any, then discard every run.
  const keptRPr = runs[0] ? firstChild(runs[0], 'rPr') : undefined;
  const keptRPrClone = keptRPr ? (keptRPr.cloneNode(true) as Element) : undefined;
  for (const r of runs) p.removeChild(r);

  // Hyperlinks and bookmarks would otherwise keep stale text visible.
  for (const hl of childElements(p, 'hyperlink')) p.removeChild(hl);

  const run = doc.createElementNS(W, 'w:r');
  if (keptRPrClone) run.appendChild(keptRPrClone);

  // Word requires an explicit break element per line inside a single paragraph.
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (i > 0) run.appendChild(doc.createElementNS(W, 'w:br'));
    const t = doc.createElementNS(W, 'w:t');
    // xml:space="preserve" stops Word from collapsing leading/trailing spaces.
    t.setAttribute('xml:space', 'preserve');
    t.appendChild(doc.createTextNode(line));
    run.appendChild(t);
  });

  p.appendChild(run);
}

/**
 * Replaces a table cell's content with one paragraph per supplied string.
 *
 * The first paragraph in the cell is reused as the formatting prototype and
 * cloned for any additional lines, so a multi-paragraph cell in the output
 * inherits exactly the spacing and indentation the template used.
 */
export function setCellParagraphs(tc: Element, paragraphs: readonly string[]): void {
  const existing = childElements(tc, 'p');
  const prototype = existing[0];
  if (!prototype) {
    throw new Error('Cannot set text on a table cell that contains no paragraph.');
  }

  const lines = paragraphs.length > 0 ? paragraphs : [''];

  // Reuse the first paragraph, clone it for the rest, drop any surplus.
  setParagraphText(prototype, lines[0]!);
  for (let i = 1; i < lines.length; i++) {
    const clone = prototype.cloneNode(true) as Element;
    setParagraphText(clone, lines[i]!);
    tc.appendChild(clone);
  }
  for (let i = 1; i < existing.length; i++) {
    const node = existing[i]!;
    if (node.parentNode === tc) tc.removeChild(node);
  }
}

/** Convenience for single-paragraph cells. */
export function setCellText(tc: Element, text: string): void {
  setCellParagraphs(tc, [text]);
}

/**
 * Clones a row and fills its cells from `values`.
 *
 * Cell count must match. A mismatch means the prototype row and the data
 * disagree about the table's shape, which would corrupt the table -- so it
 * throws rather than filling what it can.
 */
export function cloneRowWithValues(prototype: Element, values: readonly (string | string[])[]): Element {
  const row = prototype.cloneNode(true) as Element;
  const cells = rowCells(row);
  if (cells.length !== values.length) {
    throw new Error(
      `Row prototype has ${cells.length} cells but ${values.length} values were supplied. ` +
        'Refusing to write a table row of the wrong shape.',
    );
  }
  cells.forEach((tc, i) => {
    const value = values[i]!;
    setCellParagraphs(tc, Array.isArray(value) ? value : [value]);
  });
  return row;
}

/** Removes every element between `from` and `to` inclusive from their parent. */
export function removeRange(nodes: readonly Element[]): void {
  for (const node of nodes) {
    node.parentNode?.removeChild(node);
  }
}

/** Inserts `nodes` into `parent` immediately before `ref` (or appends if absent). */
export function insertBefore(parent: Element, nodes: readonly Element[], ref: Element | null): void {
  for (const node of nodes) {
    if (ref) parent.insertBefore(node, ref);
    else parent.appendChild(node);
  }
}

/**
 * The direct children of <w:body>, which is the document's block sequence:
 * paragraphs, tables and the trailing sectPr.
 */
export function bodyBlocks(documentXml: Document): { body: Element; blocks: Element[] } {
  const root = documentXml.documentElement;
  if (!root) throw new Error('document.xml has no root element.');
  const body = firstChild(root, 'body');
  if (!body) throw new Error('document.xml has no w:body element.');

  const blocks: Element[] = [];
  const kids = body.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const node = kids.item(i);
    if (node && node.nodeType === 1) blocks.push(node as Element);
  }
  return { body, blocks };
}

export type BlockKind = 'p' | 'tbl' | 'sectPr' | 'other';

export function blockKind(el: Element): BlockKind {
  switch (el.localName) {
    case 'p':
      return 'p';
    case 'tbl':
      return 'tbl';
    case 'sectPr':
      return 'sectPr';
    default:
      return 'other';
  }
}
