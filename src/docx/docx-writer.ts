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
  paragraphStyle,
  parseXml,
  serializeXml,
  setCellParagraphs,
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
      r.activity_name ? `${r.activity_name}: ${r.interactive_description}` : r.interactive_description,
      r.correlation,
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
        r.tracking,
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
    setParagraphText(
      deckTitle,
      module.part_c.subtitle
        ? `${module.part_c.deck_title}Subtitle: ${module.part_c.subtitle}`
        : module.part_c.deck_title,
    );
    blocks.push(deckTitle);

    for (const slide of module.part_c.slides) {
      const title = fromPrototype(doc, proto.part_c_slide_title);
      setParagraphText(title, `Slide ${slide.number}: ${slide.title}`);
      blocks.push(title);

      const cues = fromPrototype(doc, proto.part_c_visual_cues);
      setParagraphText(cues, `Visual Cues: ${slide.visual_cues}`);
      blocks.push(cues);

      const script = fromPrototype(doc, proto.part_c_instructor_script);
      setParagraphText(script, `Instructor Script: ${slide.instructor_script}`);
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
 * Rewrites the cached table-of-contents entries.
 *
 * Page numbers are dropped rather than guessed: `w:updateFields` is set in
 * settings.xml so Word recomputes the whole TOC, including page numbers, when the
 * document is opened.
 */
function renderToc(blocks: readonly Element[], state: StoryboardState): void {
  const tocParagraphs = blocks.filter((b) => {
    const style = b.localName === 'p' ? paragraphStyle(b) : '';
    return style === 'TOC1' || style === 'TOC2';
  });

  const entries: { level: 1 | 2; text: string }[] = [
    { level: 1, text: 'Table of Contents' },
    { level: 1, text: state.front_matter.blueprint_heading },
    { level: 2, text: 'Official SCGJ Metadata' },
    { level: 1, text: 'Instructional Design and Behavioral Analytics Tracking Guidelines' },
    ...state.front_matter.guideline_groups.map((g) => ({ level: 2 as const, text: g })),
  ];

  for (const module of state.modules) {
    entries.push({ level: 1, text: `Module ${module.number}: ${module.title}` });
    if (isInsufficientSource(module.part_a)) continue;
    entries.push({ level: 2, text: module.part_a.header_label.replace(/^Part A: /, 'Part A: ') });
    entries.push({ level: 2, text: `LMS Technical Mapping for Module ${module.number}` });
    entries.push({ level: 2, text: 'Part B: Video Production Script (15 minutes)' });
    entries.push({ level: 2, text: 'Part C: Online Instructor-Led Interactive Session (15 minutes)' });
  }

  if (!isInsufficientSource(state.assessment)) {
    const count = state.assessment.questions.length;
    entries.push({ level: 1, text: `Advanced Assessment Strategy Blueprint & ${count}-Question Bank` });
    entries.push({ level: 2, text: 'Assessment Strategy' });
    entries.push({ level: 2, text: `${count}-Question Bank (Full Student Version)` });
  }

  // Reuse as many TOC paragraphs as there are entries; strip any surplus, and
  // accept a shortfall rather than inventing differently-styled paragraphs --
  // Word rebuilds the field on open regardless.
  tocParagraphs.forEach((p, i) => {
    const entry = entries[i];
    if (entry) {
      sanitizeClone(p);
      setParagraphText(p, entry.text);
    } else {
      p.parentNode?.removeChild(p);
    }
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

  renderToc(blocks, state);

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
  for (const module of state.modules) {
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

  // --- Assessment Strategy ---------------------------------------------
  push(proto.assessment_subheading, 'Assessment Strategy');
  for (const point of assessment.strategy_points) push(proto.strategy_point, point.text);

  push(
    proto.assessment_bullet,
    `Minimum Aggregate Passing % at QP Level: ${assessment.minimum_aggregate_pass_pct}. Every ` +
      'trainee should score a minimum aggregate passing percentage as specified, to successfully ' +
      'clear the Qualification Pack assessment.',
  );

  const weightageLine = (row: (typeof assessment.weightage_compulsory)[number]) =>
    row.is_total
      ? `Total: Theory ${row.theory_marks}, Practical ${row.practical_marks}, ` +
        `Total ${row.total_marks}, Weightage ${row.weightage}.`
      : `${row.nos_code} ${row.nos_title}: Theory ${row.theory_marks}, ` +
        `Practical ${row.practical_marks}, Total ${row.total_marks}, Weightage ${row.weightage}.`;

  if (assessment.weightage_compulsory.length > 0) {
    push(proto.assessment_bullet, 'Assessment Weightage (Compulsory NOS):');
    for (const row of assessment.weightage_compulsory) push(proto.assessment_bullet, weightageLine(row));
  }
  for (const [name, rows] of Object.entries(assessment.weightage_electives)) {
    if (rows.length === 0) continue;
    push(proto.assessment_bullet, `Assessment Weightage (${name}):`);
    for (const row of rows) push(proto.assessment_bullet, weightageLine(row));
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
        push(proto.question_stem, `${q.number}. ${q.stem}`);
        for (const key of ['a', 'b', 'c', 'd'] as const) {
          push(proto.question_option, `${key}) ${q.options[key]}`);
        }
        push(proto.question_answer, `Correct Answer: ${q.correct_option}) ${q.options[q.correct_option]}`);
        push(proto.question_explanation, `Explanation: ${q.explanation}`);
      }
    }
  }

  const sectEl = bodyBlocks(doc).blocks.find((b) => b.localName === 'sectPr') ?? null;
  for (const el of blocks) {
    if (sectEl && sectEl.parentNode === body) body.insertBefore(el, sectEl);
    else body.appendChild(el);
  }
}
