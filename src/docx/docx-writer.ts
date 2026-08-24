/**
 * Renders a StoryboardState into a .docx by populating the supplied template.
 *
 * The document is never built from scratch. Every paragraph, row and table in the
 * output is a clone of a real element from the template, with only its <w:t> text
 * replaced. Styles, theme, numbering, header, footer and section properties are
 * carried over as untouched package parts, so formatting is preserved by
 * construction rather than by post-hoc validation.
 *
 * Two things in the template need care:
 *
 *  - Bookmarks. The template carries 59 `_Toc…` bookmarks anchoring its table of
 *    contents. Cloning a block that contains one would emit duplicate bookmark
 *    names, which is invalid OOXML and makes Word repair the file. Clones are
 *    therefore stripped of bookmarks and field codes.
 *  - The table of contents is a real `TOC` field with cached entries and PAGEREF
 *    page numbers. Page numbers cannot be computed without laying the document
 *    out, so entry text is rewritten and `w:updateFields` is set, which makes Word
 *    refresh the TOC when the file is opened.
 */

import JSZip from 'jszip';
import type { Document, Element } from './ooxml.js';
import {
  W,
  bodyBlocks,
  childElements,
  descendants,
  firstChild,
  pageBreakParagraph,
  paragraphStyle,
  parseXml,
  serializeXml,
  rowCells,
  setCellParagraphs,
  setCellText,
  setParagraphParts,
  setParagraphStyle,
  setParagraphText,
  tableRows,
  textOf,
  cloneRowWithValues,
} from './ooxml.js';
import type { AnalyzedTemplate } from './template-analyzer.js';
import type { StoryboardState, StoryboardModule } from '../types/storyboard.js';
import { isInsufficientSource } from '../types/source.js';

export class RenderError extends Error {
  constructor(message: string) {
    super(`DOCX render failed: ${message}`);
    this.name = 'RenderError';
  }
}

/**
 * Removes template bookmarks and field codes from a cloned subtree.
 *
 * Without this, every cloned module heading would repeat the template's
 * `_Toc900101`-style bookmark and its PAGEREF field, producing duplicate names
 * across the document.
 */
function sanitizeClone(el: Element): Element {
  for (const name of ['bookmarkStart', 'bookmarkEnd', 'fldSimple', 'proofErr', 'commentRangeStart', 'commentRangeEnd']) {
    for (const node of [...descendants(el, name)]) node.parentNode?.removeChild(node);
  }
  // A run carrying fldChar/instrText is part of a field; the text it renders is a
  // cached result, so the whole run goes.
  for (const run of [...descendants(el, 'r')]) {
    if (descendants(run, 'fldChar').length > 0 || descendants(run, 'instrText').length > 0) {
      run.parentNode?.removeChild(run);
    }
  }
  // Hyperlinks in the template point at TOC bookmarks that no longer exist.
  for (const link of [...descendants(el, 'hyperlink')]) {
    const parent = link.parentNode;
    if (!parent) continue;
    // Keep the visible runs, drop the link wrapper.
    for (const child of [...childElements(link, 'r')]) parent.insertBefore(child, link);
    parent.removeChild(link);
  }
  return el;
}

/** Parses a serialized prototype back into a sanitized element owned by `doc`. */
function fromPrototype(doc: Document, xml: string): Element {
  const wrapped = `<w:wrapper xmlns:w="${W}">${xml}</w:wrapper>`;
  const root = parseXml(wrapped).documentElement;
  if (!root) throw new RenderError('a template prototype could not be re-parsed.');

  let node: Element | undefined;
  for (let i = 0; i < root.childNodes.length; i++) {
    const child = root.childNodes.item(i);
    if (child && child.nodeType === 1) {
      node = child as Element;
      break;
    }
  }
  if (!node) throw new RenderError('a template prototype contained no element.');

  return sanitizeClone(doc.importNode(node, true) as Element);
}

/**
 * Splits a correlation into the template's two paragraphs.
 *
 * The cell holds a bold NOS code and then its performance criteria in plain text,
 * as separate paragraphs -- "SGJ/N0111" over "PC1, PC3, PC4". Content arrives as
 * one string, conventionally "<NOS> / <PCs>", so the separator is where it splits.
 * A value with no separator stays a single paragraph rather than being forced into
 * a shape it does not have.
 */
function splitCorrelation(correlation: string): string[] {
  const at = correlation.indexOf(' / ');
  if (at < 0) return [correlation];
  return [correlation.slice(0, at), correlation.slice(at + 3)];
}

/** Builds one module's block sequence from the template prototypes. */
function renderModule(
  doc: Document,
  proto: AnalyzedTemplate['prototypes'],
  module: StoryboardModule,
): Element[] {
  const blocks: Element[] = [];
  const spacer = () => fromPrototype(doc, proto.spacer);

  const heading = fromPrototype(doc, proto.module_heading);
  setParagraphText(heading, `Module ${module.number}: ${module.title}`);
  blocks.push(heading);

  const duration = fromPrototype(doc, proto.module_duration);
  setParagraphText(duration, module.duration_label);
  blocks.push(duration);

  const description = fromPrototype(doc, proto.module_description);
  setParagraphText(
    description,
    isInsufficientSource(module.description) ? module.description.message : module.description,
  );
  blocks.push(description);

  // A module with no usable source content renders its heading, its authoritative
  // duration and an explicit statement of the gap -- never invented content.
  if (isInsufficientSource(module.part_a)) {
    const note = fromPrototype(doc, proto.module_description);
    setParagraphText(note, `INSUFFICIENT SOURCE CONTENT: ${module.part_a.message}`);
    blocks.push(note, spacer());
    return blocks;
  }

  // --- Part A -----------------------------------------------------------
  const partAHeading = fromPrototype(doc, proto.part_a_heading);
  setParagraphText(partAHeading, module.part_a.header_label);
  blocks.push(partAHeading);

  const partATable = fromPrototype(doc, proto.part_a_table);
  replaceTableRows(
    doc,
    partATable,
    proto.part_a_body_row,
    module.part_a.rows.map((r) => [
      r.unit_label,
      r.duration.label,
      // "<Activity>: <what the learner does>" -- the cell splits it into a bold
      // label and a plain body, as the template's own cells do.
      r.activity_name ? `${r.activity_name}: ${r.interactive_description}` : r.interactive_description,
      // Two paragraphs in the template: the NOS code in bold, then its
      // performance criteria in plain text.
      splitCorrelation(r.correlation),
    ]),
  );
  blocks.push(partATable, spacer());

  // --- LMS Technical Mapping -------------------------------------------
  if (!isInsufficientSource(module.lms_mapping) && module.lms_mapping.rows.length > 0) {
    const lmsHeading = fromPrototype(doc, proto.lms_heading);
    setParagraphText(lmsHeading, `LMS Technical Mapping for Module ${module.number}`);
    blocks.push(lmsHeading);

    const lmsTable = fromPrototype(doc, proto.lms_table);
    replaceTableRows(
      doc,
      lmsTable,
      proto.lms_body_row,
      module.lms_mapping.rows.map((r) => [
        r.unit_range,
        r.activity_type,
        r.recommended_standard,
        // The template writes this cell as one or two labelled paragraphs --
        // "xAPI Verbs: …" over "Data: …" -- so a newline starts a new paragraph.
        r.tracking.split('\n'),
        r.completion_criteria,
      ]),
    );
    blocks.push(lmsTable, spacer());
  }

  // --- Part B -----------------------------------------------------------
  if (!isInsufficientSource(module.part_b)) {
    const partBHeading = fromPrototype(doc, proto.part_b_heading);
    setParagraphText(partBHeading, `Part B: Video Production Script (${module.part_b.duration_minutes} minutes)`);
    blocks.push(partBHeading);

    const partBTable = fromPrototype(doc, proto.part_b_table);
    replaceTableRows(
      doc,
      partBTable,
      proto.part_b_body_row,
      module.part_b.rows.map((r) => [
        r.time_range,
        // The reference splits this cell into a "Visual:" paragraph and an
        // optional "GFX:" paragraph, so it is passed as an array.
        r.gfx ? [`Visual: ${r.visual}`, `GFX: ${r.gfx}`] : [`Visual: ${r.visual}`],
        r.audio,
      ]),
    );
    blocks.push(partBTable, spacer());
  }

  // --- Part C -----------------------------------------------------------
  if (!isInsufficientSource(module.part_c)) {
    const partCHeading = fromPrototype(doc, proto.part_c_heading);
    setParagraphText(
      partCHeading,
      `Part C: Online Instructor-Led Interactive Session (${module.part_c.duration_minutes} minutes)`,
    );
    blocks.push(partCHeading);

    const deckTitle = fromPrototype(doc, proto.part_c_deck_title);
    // Two runs in the template: the deck title, then its subtitle.
    setParagraphParts(
      deckTitle,
      module.part_c.subtitle
        ? [module.part_c.deck_title, `Subtitle: ${module.part_c.subtitle}`]
        : [module.part_c.deck_title],
    );
    blocks.push(deckTitle);

    for (const slide of module.part_c.slides) {
      const title = fromPrototype(doc, proto.part_c_slide_title);
      setParagraphText(title, `Slide ${slide.number}: ${slide.title}`);
      blocks.push(title);

      // "Visual Cues: " is bold and the body italic; "Instructor Script: " is
      // bold and the body plain. Both are one paragraph of two runs.
      const cues = fromPrototype(doc, proto.part_c_visual_cues);
      setParagraphParts(cues, ['Visual Cues: ', slide.visual_cues]);
      blocks.push(cues);

      const script = fromPrototype(doc, proto.part_c_instructor_script);
      setParagraphParts(script, ['Instructor Script: ', slide.instructor_script]);
      blocks.push(script);
    }
    blocks.push(spacer());
  }

  return blocks;
}

/**
 * Rewrites a cloned table to hold exactly `values`, reusing the template's own
 * header and body rows as prototypes.
 */
function replaceTableRows(
  doc: Document,
  table: Element,
  bodyRowXml: string,
  values: readonly (string | string[])[][],
): void {
  const existing = tableRows(table);
  const header = existing[0];
  if (!header) throw new RenderError('a cloned table prototype has no rows.');

  // The header row's text is static template content and is kept as-is, but its
  // bookmarks are stripped so a re-render cannot duplicate them.
  sanitizeClone(header);
  for (const row of existing.slice(1)) table.removeChild(row);

  const bodyProto = fromPrototype(doc, bodyRowXml);
  for (const rowValues of values) {
    table.appendChild(sanitizeClone(cloneRowWithValues(bodyProto, rowValues)));
  }
}

/** Rewrites the metadata table's specification column. */
function renderMetadataTable(table: Element, state: StoryboardState): void {
  const rows = tableRows(table);
  const byField = new Map(state.front_matter.metadata.map((m) => [m.field.toLowerCase(), m.specification]));
  for (const row of rows.slice(1)) {
    const cells = childElements(row, 'tc');
    const label = cells[0] ? textOf(cells[0]).trim().toLowerCase() : '';
    const value = byField.get(label);
    if (value !== undefined && cells[1]) setCellParagraphs(cells[1], [value]);
  }
}

/**
 * The table of contents, rebuilt as a real Word field.
 *
 * The template's TOC is a live `TOC` field: an opening `fldChar`, the field
 * instruction, and then one paragraph per entry, each carrying a hyperlink to a
 * `_Toc…` bookmark, a right-aligned tab with a dot leader, and a `PAGEREF` field
 * holding the page number. That structure is the whole of how it looks -- the dots
 * and the numbers are the tab and the PAGEREF, not text.
 *
 * Rewriting the entries as plain text destroyed all of it. `sanitizeClone` strips
 * `fldChar`/`instrText` runs to stop cloned module headings repeating the
 * template's bookmarks, and applied to a TOC paragraph that also removes the field
 * itself: the output had zero TOC fields, so `w:updateFields` had nothing to
 * refresh, no page numbers could ever appear, and what was left -- a bare run
 * still carrying the `Hyperlink` character style -- rendered as blue underlined
 * text with no leaders.
 *
 * So the TOC is not edited, it is rebuilt, and from the document that was actually
 * produced rather than from a second list of what it should contain. Every
 * Heading1 and Heading2 in the finished body gets a fresh bookmark, and one entry
 * is emitted per heading in document order. Levels come from the heading styles,
 * so the glossary, a module count that differs from the template's, and anything
 * else added later are all carried without further bookkeeping.
 *
 * Page numbers still cannot be computed here -- that needs a layout engine -- so
 * each PAGEREF caches an empty result and `w:updateFields` asks Word to resolve
 * them when the document is opened. Word fills in every number and leader on open;
 * a simple viewer that renders the cached field result shows the entries and their
 * leaders with the numbers blank.
 */

/** Levels the field publishes. See the note in `rebuildToc` about "1-2". */
const TOC_FIELD_INSTRUCTION = 'TOC \\o "1-2" \\h \\z \\u';

/** Creates a `w:`-prefixed element with optional attributes. */
function wEl(doc: Document, name: string, attrs: Record<string, string> = {}): Element {
  const el = doc.createElementNS(W, `w:${name}`);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** A run carrying the given children, under optional run properties. */
function wRun(doc: Document, children: readonly Element[], rPr?: Element): Element {
  const run = wEl(doc, 'r');
  if (rPr) run.appendChild(rPr);
  for (const child of children) run.appendChild(child);
  return run;
}

/** `<w:rPr><w:noProof/><w:webHidden/></w:rPr>` -- the field runs' properties. */
function hiddenRunProps(doc: Document): Element {
  const rPr = wEl(doc, 'rPr');
  rPr.appendChild(wEl(doc, 'noProof'));
  rPr.appendChild(wEl(doc, 'webHidden'));
  return rPr;
}

function wText(doc: Document, text: string): Element {
  const t = wEl(doc, 't');
  t.setAttribute('xml:space', 'preserve');
  t.appendChild(doc.createTextNode(text));
  return t;
}

function wInstr(doc: Document, text: string): Element {
  const t = wEl(doc, 'instrText');
  t.setAttribute('xml:space', 'preserve');
  t.appendChild(doc.createTextNode(text));
  return t;
}

/**
 * Removes every bookmark in the body.
 *
 * The template's own `_Toc…` names are about to be reissued, and a document
 * carrying two bookmarks of one name is invalid OOXML that makes Word offer to
 * repair the file. Clearing first means the names emitted below are the only ones.
 */
function stripBookmarks(doc: Document): void {
  for (const name of ['bookmarkStart', 'bookmarkEnd'] as const) {
    for (const node of [...descendants(doc.documentElement as Element, name)]) {
      node.parentNode?.removeChild(node);
    }
  }
}

interface TocTarget {
  level: 1 | 2;
  text: string;
  bookmark: string;
}

/**
 * Bookmarks every heading the contents will list, in document order.
 *
 * Only Heading1 and Heading2, because that is what the template's contents shows.
 * Its field instruction says `\o "1-3"`, which disagrees with its own cached
 * entries -- there are ten Heading3 question-group headings and none of them is
 * listed -- so honouring the instruction on refresh would add eleven lines the
 * reference document does not have. The visible template is the specification, so
 * the field is emitted as "1-2" and Word's refresh reproduces exactly what the
 * template shows.
 */
function bookmarkHeadings(doc: Document, body: Element): TocTarget[] {
  const targets: TocTarget[] = [];
  let id = 900_100;

  for (const block of childElements(body, 'p')) {
    const style = paragraphStyle(block);
    const level = style === 'Heading1' ? 1 : style === 'Heading2' ? 2 : undefined;
    if (level === undefined) continue;
    const text = textOf(block).replace(/\s+/g, ' ').trim();
    if (text === '') continue;

    const bookmark = `_Toc${id}`;
    const start = wEl(doc, 'bookmarkStart', { 'w:id': String(id), 'w:name': bookmark });
    const end = wEl(doc, 'bookmarkEnd', { 'w:id': String(id) });
    id += 1;

    // After pPr so the bookmark opens inside the paragraph, as Word writes it.
    const pPr = firstChild(block, 'pPr');
    if (pPr?.nextSibling) block.insertBefore(start, pPr.nextSibling);
    else if (pPr) block.appendChild(start);
    else block.insertBefore(start, block.firstChild);
    block.appendChild(end);

    targets.push({ level: level as 1 | 2, text, bookmark });
  }

  return targets;
}

/**
 * One contents entry: hyperlink, dot-leader tab, and a PAGEREF for the number.
 *
 * `first` opens the TOC field and `last` closes it, exactly as the template does:
 * the field brackets the whole run of entry paragraphs rather than each one.
 */
function buildTocEntry(
  doc: Document,
  prototype: Element,
  target: TocTarget,
  first: boolean,
  last: boolean,
): Element {
  // The prototype supplies pPr -- the TOC style and, crucially, the right-aligned
  // tab stop with the dot leader that draws the dots.
  const p = prototype.cloneNode(true) as Element;
  for (const child of [...childElements(p, 'r')]) p.removeChild(child);
  for (const child of [...childElements(p, 'hyperlink')]) p.removeChild(child);
  for (const child of [...childElements(p, 'bookmarkStart')]) p.removeChild(child);
  for (const child of [...childElements(p, 'bookmarkEnd')]) p.removeChild(child);
  setParagraphStyle(p, target.level === 1 ? 'TOC1' : 'TOC2');

  if (first) {
    p.appendChild(wRun(doc, [wEl(doc, 'fldChar', { 'w:fldCharType': 'begin' })]));
    p.appendChild(wRun(doc, [wInstr(doc, TOC_FIELD_INSTRUCTION)]));
    p.appendChild(wRun(doc, [wEl(doc, 'fldChar', { 'w:fldCharType': 'separate' })]));
  }

  const link = wEl(doc, 'hyperlink', { 'w:anchor': target.bookmark, 'w:history': '1' });

  const textProps = wEl(doc, 'rPr');
  textProps.appendChild(wEl(doc, 'rStyle', { 'w:val': 'Hyperlink' }));
  textProps.appendChild(wEl(doc, 'noProof'));
  link.appendChild(wRun(doc, [wText(doc, target.text)], textProps));

  // The tab that runs the dots out to the page number.
  link.appendChild(wRun(doc, [wEl(doc, 'tab')], hiddenRunProps(doc)));

  // PAGEREF, cached empty: Word resolves it on open, which is what fills in the
  // page numbers this renderer cannot compute.
  link.appendChild(wRun(doc, [wEl(doc, 'fldChar', { 'w:fldCharType': 'begin' })], hiddenRunProps(doc)));
  link.appendChild(wRun(doc, [wInstr(doc, ` PAGEREF ${target.bookmark} \\h `)], hiddenRunProps(doc)));
  link.appendChild(wRun(doc, [wEl(doc, 'fldChar', { 'w:fldCharType': 'separate' })], hiddenRunProps(doc)));
  link.appendChild(wRun(doc, [wText(doc, '')], hiddenRunProps(doc)));
  link.appendChild(wRun(doc, [wEl(doc, 'fldChar', { 'w:fldCharType': 'end' })], hiddenRunProps(doc)));

  p.appendChild(link);

  if (last) {
    p.appendChild(wRun(doc, [wEl(doc, 'fldChar', { 'w:fldCharType': 'end' })]));
  }
  return p;
}

/**
 * Replaces the template's contents entries with ones describing this document.
 *
 * Runs last, after every other section is in place, because it reads the finished
 * body: what the contents lists is whatever headings the document ended up with.
 */
function rebuildToc(doc: Document, body: Element): void {
  const isTocParagraph = (b: Element) =>
    b.localName === 'p' && ['TOC1', 'TOC2'].includes(paragraphStyle(b));

  const existing = childElements(body, 'p').filter(isTocParagraph);
  if (existing.length === 0) return;

  // Kept as the formatting prototype: its pPr carries the dot-leader tab stop.
  const prototype = existing[0]!.cloneNode(true) as Element;
  const anchor = existing[existing.length - 1]!.nextSibling;

  stripBookmarks(doc);
  const targets = bookmarkHeadings(doc, body);

  for (const p of existing) if (p.parentNode === body) body.removeChild(p);

  targets.forEach((target, i) => {
    const entry = buildTocEntry(doc, prototype, target, i === 0, i === targets.length - 1);
    if (anchor && anchor.parentNode === body) body.insertBefore(entry, anchor);
    else body.appendChild(entry);
  });
}

/** Marks fields dirty so Word refreshes the TOC and its page numbers on open. */
function setUpdateFields(parts: Record<string, Uint8Array>): void {
  const key = 'word/settings.xml';
  const raw = parts[key];
  if (!raw) return;
  let xml = new TextDecoder().decode(raw);
  if (xml.includes('w:updateFields')) {
    xml = xml.replace(/<w:updateFields[^>]*\/>/, '<w:updateFields w:val="true"/>');
  } else {
    xml = xml.replace(/(<w:settings[^>]*>)/, '$1<w:updateFields w:val="true"/>');
  }
  parts[key] = new TextEncoder().encode(xml);
}

export interface RenderOptions {
  template: AnalyzedTemplate;
  state: StoryboardState;
}

export async function renderStoryboardDocx(options: RenderOptions): Promise<Uint8Array> {
  const { template, state } = options;

  // Work on a fresh parse so repeated renders never accumulate edits.
  const documentPart = template.parts['word/document.xml'];
  if (!documentPart) throw new RenderError('the template package has no word/document.xml.');
  const doc = parseXml(new TextDecoder().decode(documentPart));

  const { body, blocks } = bodyBlocks(doc);

  // --- Front matter -----------------------------------------------------
  // Cover text is matched by content rather than position, because the template's
  // cover is a run of otherwise indistinguishable unstyled paragraphs.
  for (const block of blocks) {
    if (block.localName !== 'p') continue;
    const text = textOf(block).trim();
    const style = paragraphStyle(block);

    if (style === 'Heading1' && /Storyboard\s*&\s*Curriculum\s+Blueprint/i.test(text)) {
      setParagraphText(sanitizeClone(block), state.front_matter.blueprint_heading);
    } else if (style === '' && /^Solar Photovoltaic Entrepreneur$/i.test(text)) {
      setParagraphText(block, state.front_matter.title);
    } else if (style === '' && /Complete Curriculum Storyboard/i.test(text)) {
      setParagraphText(block, state.front_matter.subtitle);
    } else if (style === '' && /Micro-credential Reference/i.test(text)) {
      setParagraphText(block, state.front_matter.strapline);
    }
  }

  const metadataTable = blocks.find((b) => b.localName === 'tbl');
  if (metadataTable) renderMetadataTable(metadataTable, state);

  // --- Module region ----------------------------------------------------
  const firstModule = template.map.modules[0];
  if (!firstModule) throw new RenderError('the template map contains no modules.');

  const moduleHeadings = blocks.filter(
    (b) => b.localName === 'p' && paragraphStyle(b) === 'Heading1' && /^Module\s+\d+\s*:/.test(textOf(b).trim()),
  );
  const firstModuleEl = moduleHeadings[0];
  if (!firstModuleEl) throw new RenderError('no module heading found in the template body.');

  const assessmentEl = blocks.find(
    (b) =>
      b.localName === 'p' &&
      paragraphStyle(b) === 'Heading1' &&
      /Assessment\s+Strategy\s+Blueprint/i.test(textOf(b).trim()),
  );

  // Everything from the first module heading up to the assessment heading (or the
  // trailing sectPr) is replaced wholesale.
  const startIndex = blocks.indexOf(firstModuleEl);
  const endIndex = assessmentEl ? blocks.indexOf(assessmentEl) : blocks.findIndex((b) => b.localName === 'sectPr');
  const stop = endIndex === -1 ? blocks.length : endIndex;

  const doomed = blocks.slice(startIndex, stop);
  const anchor = blocks[stop] ?? null;

  const rendered: Element[] = [];
  for (const [index, module] of state.modules.entries()) {
    // Each module starts its own page; the first one already opens right after
    // the table of contents, so it takes no break of its own.
    if (index > 0) rendered.push(pageBreakParagraph(doc));
    rendered.push(...renderModule(doc, template.prototypes, module));
  }

  for (const el of doomed) if (el.parentNode === body) body.removeChild(el);
  for (const el of rendered) {
    if (anchor && anchor.parentNode === body) body.insertBefore(el, anchor);
    else body.appendChild(el);
  }

  // --- Assessment -------------------------------------------------------
  if (assessmentEl) {
    const remaining = bodyBlocks(doc).blocks;
    const assessIndex = remaining.indexOf(assessmentEl);
    const sectIndex = remaining.findIndex((b) => b.localName === 'sectPr');
    const tailEnd = sectIndex === -1 ? remaining.length : sectIndex;
    const tail = remaining.slice(assessIndex + 1, tailEnd);

    if (isInsufficientSource(state.assessment)) {
      // The Solar reference's 100 questions must not survive into a Biofuels
      // document, so the tail is replaced with an explicit statement of the gap.
      for (const el of tail) if (el.parentNode === body) body.removeChild(el);
      const note = fromPrototype(doc, template.prototypes.module_description);
      setParagraphText(note, `INSUFFICIENT SOURCE CONTENT: ${state.assessment.message}`);
      const sectEl = bodyBlocks(doc).blocks.find((b) => b.localName === 'sectPr') ?? null;
      if (sectEl && sectEl.parentNode === body) body.insertBefore(note, sectEl);
      else body.appendChild(note);
    } else {
      // The template's Heading1 hard-codes "100-Question Bank"; make it match the
      // bank actually produced.
      setParagraphText(
        sanitizeClone(assessmentEl),
        `Advanced Assessment Strategy Blueprint & ${state.assessment.questions.length}-Question Bank`,
      );
      renderAssessment(doc, body, template, state, tail);
    }
  }

  // --- Table of contents ------------------------------------------------
  // Last, because it describes the document that was actually produced: every
  // heading now in the body, at the level its style gives it.
  rebuildToc(doc, body);

  // --- Repackage --------------------------------------------------------
  const parts: Record<string, Uint8Array> = { ...template.parts };
  parts['word/document.xml'] = new TextEncoder().encode(serializeXml(doc));
  setUpdateFields(parts);

  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(parts)) {
    zip.file(name, bytes);
  }
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/**
 * Rebuilds the assessment strategy and question bank from state.
 *
 * The whole tail after the assessment Heading1 is replaced, so the section's own
 * "Assessment Strategy" and "<N>-Question Bank" Heading2 paragraphs have to be
 * re-emitted from their prototype -- they are part of what gets removed.
 */
function renderAssessment(
  doc: Document,
  body: Element,
  template: AnalyzedTemplate,
  state: StoryboardState,
  tail: readonly Element[],
): void {
  if (isInsufficientSource(state.assessment)) return;
  const assessment = state.assessment;
  const proto = template.prototypes;

  for (const el of tail) if (el.parentNode === body) body.removeChild(el);

  const blocks: Element[] = [];
  const push = (protoXml: string, text: string) => {
    const el = fromPrototype(doc, protoXml);
    setParagraphText(el, text);
    blocks.push(el);
  };
  /** For the template's label-then-body paragraphs, which are two runs. */
  const pushParts = (protoXml: string, parts: readonly string[]) => {
    const el = fromPrototype(doc, protoXml);
    setParagraphParts(el, parts);
    blocks.push(el);
  };

  // --- Assessment Strategy ---------------------------------------------
  push(proto.assessment_subheading, 'Assessment Strategy');
  for (const point of assessment.strategy_points) push(proto.strategy_point, point.text);

  pushParts(proto.assessment_label_bullet, [
    'Minimum Aggregate Passing % at QP Level: ',
    `${assessment.minimum_aggregate_pass_pct}. Every trainee should score a minimum aggregate ` +
      'passing percentage as specified, to successfully clear the Qualification Pack assessment.',
  ]);

  // Each weightage line opens with a bold label -- the heading, or the NOS code --
  // and continues in plain text, so it takes the labelled prototype.
  const labelledWeightage = (row: (typeof assessment.weightage_compulsory)[number]) =>
    row.is_total
      ? ['Total: ', `Theory ${row.theory_marks}, Practical ${row.practical_marks}, ` +
          `Total ${row.total_marks}, Weightage ${row.weightage}.`]
      : [`${row.nos_code} `, `${row.nos_title}: Theory ${row.theory_marks}, ` +
          `Practical ${row.practical_marks}, Total ${row.total_marks}, Weightage ${row.weightage}.`];

  if (assessment.weightage_compulsory.length > 0) {
    pushParts(proto.assessment_label_bullet, ['Assessment Weightage (Compulsory NOS):', '']);
    for (const row of assessment.weightage_compulsory) {
      pushParts(proto.assessment_label_bullet, labelledWeightage(row));
    }
  }
  for (const [name, rows] of Object.entries(assessment.weightage_electives)) {
    if (rows.length === 0) continue;
    pushParts(proto.assessment_label_bullet, [`Assessment Weightage (${name}):`, '']);
    for (const row of rows) pushParts(proto.assessment_label_bullet, labelledWeightage(row));
  }

  if (assessment.remarks) push(proto.assessment_bullet, `Remarks: ${assessment.remarks}`);
  if (assessment.disclosure_note) push(proto.assessment_bullet, assessment.disclosure_note);

  // --- Question bank ----------------------------------------------------
  if (assessment.questions.length > 0) {
    push(
      proto.assessment_subheading,
      `${assessment.questions.length}-Question Bank (Full Student Version)`,
    );

    const byModule = new Map<number, typeof assessment.questions>();
    for (const q of assessment.questions) {
      const list = byModule.get(q.module_number) ?? [];
      list.push(q);
      byModule.set(q.module_number, list);
    }

    for (const module of state.modules) {
      const questions = byModule.get(module.number);
      if (!questions || questions.length === 0) continue;

      push(proto.question_group_heading, `Module ${module.number}: ${module.title}`);

      // Ordered by the bank-wide question number so numbering reads continuously.
      for (const q of [...questions].sort((a, b) => a.number - b.number)) {
        // The number is bold green and the stem bold; the two labels below are
        // formatted differently from the text that follows them.
        pushParts(proto.question_stem, [`${q.number}. `, q.stem]);
        for (const key of ['a', 'b', 'c', 'd'] as const) {
          push(proto.question_option, `${key}) ${q.options[key]}`);
        }
        pushParts(proto.question_answer, [
          'Correct Answer: ',
          `${q.correct_option}) ${q.options[q.correct_option]}`,
        ]);
        pushParts(proto.question_explanation, ['Explanation: ', q.explanation]);
      }
    }
  }

  renderGlossary(doc, state, proto, push, blocks);

  const sectEl = bodyBlocks(doc).blocks.find((b) => b.localName === 'sectPr') ?? null;
  for (const el of blocks) {
    if (sectEl && sectEl.parentNode === body) body.insertBefore(el, sectEl);
    else body.appendChild(el);
  }
}

/**
 * The closing Glossary of Terms and Abbreviations.
 *
 * Terms are gathered a module at a time, from the sources that use them, and this
 * is where they become one list: merged, deduplicated case-insensitively by term,
 * and sorted alphabetically so the reader can look one up.
 *
 * Rendered as a three-column table -- Abbreviation, Full Form, Definition -- built
 * from the template's own three-column table, so its header fill, borders, cell
 * padding, fonts and widths are the template's rather than anything chosen here.
 * The one deliberate difference from that prototype: the second and third columns
 * are written plain. In its original use those cells open with a bold label, which
 * a full form and a definition do not have.
 */
function renderGlossary(
  doc: Document,
  state: StoryboardState,
  proto: AnalyzedTemplate['prototypes'],
  push: (protoXml: string, text: string) => void,
  blocks: Element[],
): void {
  const entries = state.glossary ?? [];
  if (entries.length === 0) return;

  const byTerm = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    const key = entry.term.trim().toLowerCase();
    if (!byTerm.has(key)) byTerm.set(key, entry);
  }
  const sorted = [...byTerm.values()].sort((a, b) =>
    a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }),
  );

  // The glossary opens its own page, as each module does, rather than running on
  // from the end of the question bank.
  blocks.push(pageBreakParagraph(doc));

  push(proto.module_heading, 'Glossary of Terms and Abbreviations');
  push(
    proto.module_description,
    'Comprehensive reference of the technical, financial, regulatory and operational terminology ' +
      "used throughout this storyboard, drawn from the course's approved documents.",
  );

  const table = fromPrototype(doc, proto.part_b_table);
  const header = tableRows(table)[0];
  if (header) {
    sanitizeClone(header);
    const cells = rowCells(header);
    ['Abbreviation', 'Full Form', 'Definition'].forEach((label, i) => {
      if (cells[i]) setCellText(cells[i]!, label);
    });
  }
  for (const row of tableRows(table).slice(1)) table.removeChild(row);

  const bodyProto = plainedBodyRow(doc, proto.part_b_body_row);
  for (const entry of sorted) {
    table.appendChild(
      sanitizeClone(cloneRowWithValues(bodyProto, [entry.term, entry.full_form, entry.definition])),
    );
  }
  blocks.push(table, fromPrototype(doc, proto.spacer));
}

/**
 * The three-column body row with bold dropped from its second and third cells.
 *
 * The prototype's role in the template is a script row, where those cells open
 * with a bold speaker or shot label. A glossary's full form and definition have no
 * label, so the bold is removed and everything else -- widths, borders, padding,
 * font, size -- is left exactly as the template set it. Removing the property also
 * stops the cell writer treating the text as a labelled one and splitting it at a
 * colon a definition may well contain.
 */
function plainedBodyRow(doc: Document, bodyRowXml: string): Element {
  const row = fromPrototype(doc, bodyRowXml);
  rowCells(row)
    .slice(1)
    .forEach((tc) => {
      for (const p of childElements(tc, 'p')) {
        for (const run of childElements(p, 'r')) {
          const rPr = firstChild(run, 'rPr');
          if (!rPr) continue;
          for (const b of childElements(rPr, 'b')) rPr.removeChild(b);
        }
      }
    });
  return row;
}
