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

/**
 * Retargets a paragraph's existing style, e.g. from TOC2 to TOC1.
 *
 * Only rewrites a style that is already there; it never adds one. A paragraph
 * with no pStyle is inheriting from the document defaults, and giving it one
 * would be authoring formatting rather than reusing the template's. Returns
 * whether the style was changed, so a caller can tell the difference between
 * "done" and "there was nothing to retarget".
 */
export function setParagraphStyle(p: Element, styleId: string): boolean {
  const pPr = firstChild(p, 'pPr');
  if (!pPr) return false;
  const pStyle = firstChild(pPr, 'pStyle');
  if (!pStyle) return false;
  // The template writes the prefixed form; keep whichever form is already there
  // so the serialized attribute is byte-comparable with its neighbours.
  if (pStyle.getAttributeNS(W, 'val') !== null) pStyle.setAttributeNS(W, 'w:val', styleId);
  else pStyle.setAttribute('w:val', styleId);
  return true;
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

  // A run holding a page break is layout, not text, and has to survive the
  // rewrite. The template's cover ends with one, in the same paragraph as the
  // strapline: discarding it with the rest of the runs pulled the table of
  // contents up onto the cover page.
  const pageBreaks = runs
    .filter((r) => descendants(r, 'br').some((br) => br.getAttribute('w:type') === 'page'))
    .map((r) => r.cloneNode(true) as Element);

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
  for (const brk of pageBreaks) p.appendChild(brk);
}

/** Builds a standalone paragraph holding nothing but a hard page break. */
export function pageBreakParagraph(doc: Document): Element {
  const p = doc.createElementNS(W, 'w:p');
  const run = doc.createElementNS(W, 'w:r');
  const br = doc.createElementNS(W, 'w:br');
  br.setAttribute('w:type', 'page');
  run.appendChild(br);
  p.appendChild(run);
  return p;
}

/**
 * Fills a paragraph's runs from several strings, one per run, keeping each run's
 * own character formatting.
 *
 * The template formats within a paragraph, not just across paragraphs. A question
 * stem is a bold green "1. " followed by a bold stem; an explanation is a
 * bold-italic "Explanation: " followed by italic text; a slide's cues are a bold
 * "Visual Cues: " followed by italic text. Each of those is one paragraph holding
 * two differently-formatted runs.
 *
 * `setParagraphText` cannot express that: it keeps the first run's properties and
 * discards the rest, so the label's bold spread across the whole line and every
 * one of those paragraphs came out uniformly bold. This maps part N onto run N
 * instead, so the label stays a label and the body stays body.
 *
 * Parts beyond the template's run count reuse the last run's formatting, and
 * surplus runs are removed, so a paragraph always ends up with exactly as many
 * runs as there are parts.
 */
export function setParagraphParts(p: Element, parts: readonly string[]): void {
  const doc = p.ownerDocument!;
  const runs = childElements(p, 'r');
  if (parts.length === 0) return;

  // Captured before any mutation: these are the template's formatting, and they
  // are the only thing being carried over.
  const runProps = runs.map((r) => {
    const rPr = firstChild(r, 'rPr');
    return rPr ? (rPr.cloneNode(true) as Element) : undefined;
  });
  const pageBreaks = runs
    .filter((r) => descendants(r, 'br').some((br) => br.getAttribute('w:type') === 'page'))
    .map((r) => r.cloneNode(true) as Element);

  for (const r of runs) p.removeChild(r);
  for (const hl of childElements(p, 'hyperlink')) p.removeChild(hl);

  parts.forEach((part, i) => {
    const run = doc.createElementNS(W, 'w:r');
    // The last run's formatting carries on when there are more parts than runs.
    const rPr = runProps[i] ?? runProps[runProps.length - 1];
    if (rPr) run.appendChild(rPr.cloneNode(true) as Element);

    part.split('\n').forEach((line, j) => {
      if (j > 0) run.appendChild(doc.createElementNS(W, 'w:br'));
      const t = doc.createElementNS(W, 'w:t');
      t.setAttribute('xml:space', 'preserve');
      t.appendChild(doc.createTextNode(line));
      run.appendChild(t);
    });
    p.appendChild(run);
  });

  for (const brk of pageBreaks) p.appendChild(brk);
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
  if (!existing[0]) {
    throw new Error('Cannot set text on a table cell that contains no paragraph.');
  }

  const lines = paragraphs.length > 0 ? paragraphs : [''];

  // Paragraph i takes paragraph i's formatting, not paragraph 0's. A Correlation
  // cell holds a bold NOS code and then a plain list of performance criteria; with
  // one prototype for the whole cell the second line came out bold too.
  const protoFor = (i: number) => existing[Math.min(i, existing.length - 1)]!;

  const written: Element[] = [];
  lines.forEach((line, i) => {
    const source = protoFor(i);
    const target = i < existing.length ? source : (source.cloneNode(true) as Element);
    writeCellParagraph(target, line);
    written.push(target);
    if (i >= existing.length) tc.appendChild(target);
  });

  for (const node of existing) {
    if (!written.includes(node) && node.parentNode === tc) tc.removeChild(node);
  }
}

/**
 * Writes one line into a cell paragraph, honouring the template's run split.
 *
 * The template writes most cells as a bold label and a plain body in one
 * paragraph -- "Solar PV System Explorer: " then what the learner does, "Visual: "
 * then the shot, "Host (On-Camera): " then the dialogue. Some cells are a single
 * run and stay uniform: a unit label is bold throughout even though it contains a
 * colon, and a completion criterion is plain throughout.
 *
 * Which of those applies is read off the paragraph itself rather than decided per
 * column: a prototype whose first run is bold and whose later runs are not is a
 * label-and-body cell, and the line is split at its first ": " to match. Anything
 * else is written as one run. That keeps the decision in the template, where it
 * belongs -- add a column and it formats itself correctly.
 */
function writeCellParagraph(p: Element, line: string): void {
  const runs = childElements(p, 'r').filter((r) => descendants(r, 't').length > 0);
  const isBold = (r: Element) => {
    const rPr = firstChild(r, 'rPr');
    return rPr !== undefined && firstChild(rPr, 'b') !== undefined;
  };
  const labelled =
    runs.length >= 2 && runs[0] !== undefined && isBold(runs[0]) && runs.slice(1).some((r) => !isBold(r));

  if (labelled) {
    const at = line.indexOf(': ');
    if (at > 0) {
      setParagraphParts(p, [line.slice(0, at + 2), line.slice(at + 2)]);
      return;
    }
  }
  setParagraphText(p, line);
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
