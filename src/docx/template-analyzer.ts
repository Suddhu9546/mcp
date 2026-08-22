/**
 * Template analyzer.
 *
 * Reads the supplied storyboard template and derives a Template Map from what is
 * actually in the file. Nothing about the structure is assumed: the module count,
 * the table shapes, the column headers and the slide count are all discovered.
 *
 * The supplied template (templates/storyboard-template-v1.docx) is a complete,
 * populated Solar PV storyboard rather than a blank form. That is usable -- and
 * in fact stronger than a blank form -- because it lets us lift real, correctly
 * formatted elements out of it and use them as clone prototypes. The generated
 * Biofuels document therefore reuses the template's own paragraphs, rows and
 * tables, and inherits its formatting by construction.
 *
 * Analysis failure is fatal (ERROR HANDLING: "Template parsing failure -> stop.
 * Do not create an approximate template.").
 */

import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import type { Document, Element } from './ooxml.js';
import {
  W,
  bodyBlocks,
  blockKind,
  childElements,
  descendants,
  gridSpan,
  paragraphStyle,
  parseXml,
  rowCells,
  serializeXml,
  tableRows,
  textOf,
} from './ooxml.js';

export class TemplateAnalysisError extends Error {
  constructor(message: string) {
    super(`Template analysis failed: ${message}`);
    this.name = 'TemplateAnalysisError';
  }
}

// ---------------------------------------------------------------------------
// Template map
// ---------------------------------------------------------------------------

export interface TableShape {
  /** Index of the table within the document, 1-based, as analyzed. */
  table_index: number;
  /** Column count taken from w:tblGrid. */
  columns: number;
  /** Header row cell texts, verbatim. These are static text, never regenerated. */
  header_cells: string[];
  row_count: number;
  /** Cells per row, to detect merged or irregular rows. */
  cells_per_row: number[];
}

export interface ModuleBlockMap {
  module_number: number;
  title: string;
  /** Index into body blocks where this module's Heading1 sits. */
  start_block: number;
  /** Exclusive end index. */
  end_block: number;
  duration_text: string;
  has_description: boolean;
  part_a: { heading: string; table: TableShape } | null;
  lms_mapping: { heading: string; table: TableShape } | null;
  part_b: { heading: string; table: TableShape } | null;
  part_c: { heading: string; deck_title: string; slide_count: number; paragraph_count: number } | null;
}

export interface TemplateMap {
  template_version: string;
  source_file: string;
  /** Package parts carried over verbatim. Formatting lives in these. */
  package_parts: string[];
  total_blocks: number;
  total_tables: number;
  /** Paragraph style ids used, with counts, for reference. */
  paragraph_styles: Record<string, number>;
  front_matter: {
    /** Block index of the "…Storyboard & Curriculum Blueprint" Heading1. */
    blueprint_heading_block: number;
    blueprint_heading_text: string;
    metadata_table: TableShape | null;
    /**
     * Every heading the template prints ahead of the first module, in order.
     *
     * The renderer leaves front matter in place and only swaps specific text, so
     * this is exactly what the finished document contains -- which makes it the
     * only correct source for the table of contents' opening entries. The two
     * tracks genuinely differ here: the Orientation template carries an
     * Instructional Design and Behavioral Analytics section that the Entrepreneur
     * one does not, and a TOC that assumed either would be wrong for the other.
     */
    front_headings: { level: 1 | 2; text: string }[];
    guideline_groups: string[];
    guideline_bullet_count: number;
  };
  modules: ModuleBlockMap[];
  assessment: {
    heading_block: number;
    heading_text: string;
    strategy_point_count: number;
    /** Heading3 blocks inside the question bank, one per module. */
    question_bank_groups: string[];
    question_count: number;
  } | null;
  /** Serialized <w:sectPr> governing page size, orientation and margins. */
  sect_pr_xml: string;
}

/** Clone prototypes lifted out of the template, as serialized XML. */
export interface BlockPrototypes {
  module_heading: string;
  module_duration: string;
  module_description: string;
  part_a_heading: string;
  part_a_table: string;
  part_a_header_row: string;
  part_a_body_row: string;
  lms_heading: string;
  lms_table: string;
  lms_header_row: string;
  lms_body_row: string;
  part_b_heading: string;
  part_b_table: string;
  part_b_header_row: string;
  part_b_body_row: string;
  part_c_heading: string;
  part_c_deck_title: string;
  part_c_slide_title: string;
  part_c_visual_cues: string;
  part_c_instructor_script: string;
  /** An empty spacer paragraph, used between blocks as the template does. */
  spacer: string;
  question_stem: string;
  question_option: string;
  question_answer: string;
  question_explanation: string;
  question_group_heading: string;
  /** Heading2 inside the assessment section, e.g. "Assessment Strategy". */
  assessment_subheading: string;
  /** A numbered assessment-strategy point (ListNumber style). */
  strategy_point: string;
  /** A ListBullet2 bullet, used for weightage lines and the disclosure note. */
  assessment_bullet: string;
}

export interface AnalyzedTemplate {
  map: TemplateMap;
  prototypes: BlockPrototypes;
  /** Parsed document.xml, for the renderer to clone from. */
  document: Document;
  /** Every package part, so the renderer can rebuild the .docx unchanged. */
  parts: Record<string, Uint8Array>;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyzeTable(tbl: Element, index: number): TableShape {
  const rows = tableRows(tbl);
  const grid = childElements(tbl, 'tblGrid')[0];
  const columns = grid ? childElements(grid, 'gridCol').length : (rows[0] ? rowCells(rows[0]).length : 0);
  const headerRow = rows[0];
  return {
    table_index: index,
    columns,
    header_cells: headerRow ? rowCells(headerRow).map((tc) => textOf(tc).trim()) : [],
    row_count: rows.length,
    cells_per_row: rows.map((tr) => rowCells(tr).reduce((acc, tc) => acc + gridSpan(tc), 0)),
  };
}

const MODULE_HEADING_RE = /^Module\s+(\d+)\s*:\s*(.+)$/i;
const PART_A_RE = /^Part\s+A\b/i;
const PART_B_RE = /^Part\s+B\b/i;
const PART_C_RE = /^Part\s+C\b/i;
const LMS_RE = /^LMS\s+Technical\s+Mapping/i;
const SLIDE_RE = /^Slide\s+(\d+)\s*:/i;
const DURATION_RE = /^Total\s+Duration\s*:/i;
const ASSESSMENT_RE = /Assessment\s+Strategy\s+Blueprint/i;
const QUESTION_RE = /^(\d+)\.\s+\S/;
const CORRECT_ANSWER_RE = /^Correct\s+Answer\s*:/i;
const EXPLANATION_RE = /^Explanation\s*:/i;
const VISUAL_CUES_RE = /^Visual\s+Cues\s*:/i;
const INSTRUCTOR_SCRIPT_RE = /^Instructor\s+Script\s*:/i;
const BLUEPRINT_RE = /Storyboard\s*&\s*Curriculum\s+Blueprint/i;

interface BlockInfo {
  el: Element;
  index: number;
  kind: ReturnType<typeof blockKind>;
  style: string;
  text: string;
  /** 1-based table index, for tables only. */
  tableIndex?: number;
}

function indexBlocks(document: Document): BlockInfo[] {
  const { blocks } = bodyBlocks(document);
  let tableCounter = 0;
  return blocks.map((el, index) => {
    const kind = blockKind(el);
    if (kind === 'tbl') tableCounter += 1;
    return {
      el,
      index,
      kind,
      style: kind === 'p' ? paragraphStyle(el) : '',
      text: kind === 'sectPr' ? '' : textOf(el).trim(),
      ...(kind === 'tbl' ? { tableIndex: tableCounter } : {}),
    };
  });
}

export async function analyzeTemplate(file: string, templateVersion = 'v1'): Promise<AnalyzedTemplate> {
  const zip = await JSZip.loadAsync(await readFile(file));

  const parts: Record<string, Uint8Array> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    parts[name] = await entry.async('uint8array');
  }

  const documentPart = parts['word/document.xml'];
  if (!documentPart) throw new TemplateAnalysisError('the package contains no word/document.xml.');

  const document = parseXml(new TextDecoder().decode(documentPart));
  const blocks = indexBlocks(document);

  const paragraphStyles: Record<string, number> = {};
  for (const b of blocks) {
    if (b.kind !== 'p') continue;
    const key = b.style || '(default)';
    paragraphStyles[key] = (paragraphStyles[key] ?? 0) + 1;
  }

  // --- Module spans -------------------------------------------------------
  const moduleHeadings = blocks.filter(
    (b) => b.kind === 'p' && b.style === 'Heading1' && MODULE_HEADING_RE.test(b.text),
  );
  if (moduleHeadings.length === 0) {
    throw new TemplateAnalysisError(
      'no Heading1 paragraph matching "Module <n>: <title>" was found. The template ' +
        'does not have the expected per-module structure.',
    );
  }

  const assessmentHeading = blocks.find(
    (b) => b.kind === 'p' && b.style === 'Heading1' && ASSESSMENT_RE.test(b.text),
  );

  const modules: ModuleBlockMap[] = moduleHeadings.map((head, i) => {
    const next = moduleHeadings[i + 1];
    const endBlock = next?.index ?? assessmentHeading?.index ?? blocks.length;
    const span = blocks.filter((b) => b.index > head.index && b.index < endBlock);
    const m = MODULE_HEADING_RE.exec(head.text)!;

    const durationBlock = span.find((b) => b.kind === 'p' && DURATION_RE.test(b.text));
    // The description is the first substantial unstyled paragraph after the
    // duration line and before the first Heading2.
    const firstHeading2 = span.find((b) => b.kind === 'p' && b.style === 'Heading2');
    const description = span.find(
      (b) =>
        b.kind === 'p' &&
        !b.style &&
        b.text.length > 80 &&
        (!durationBlock || b.index > durationBlock.index) &&
        (!firstHeading2 || b.index < firstHeading2.index),
    );

    /** First table appearing after `heading` and before the next Heading2. */
    const tableAfter = (heading: BlockInfo | undefined): TableShape | null => {
      if (!heading) return null;
      const nextHeading = span.find((b) => b.kind === 'p' && b.style === 'Heading2' && b.index > heading.index);
      const tbl = span.find(
        (b) => b.kind === 'tbl' && b.index > heading.index && (!nextHeading || b.index < nextHeading.index),
      );
      return tbl ? analyzeTable(tbl.el, tbl.tableIndex ?? 0) : null;
    };

    const partAHeading = span.find((b) => b.kind === 'p' && b.style === 'Heading2' && PART_A_RE.test(b.text));
    const lmsHeading = span.find((b) => b.kind === 'p' && b.style === 'Heading2' && LMS_RE.test(b.text));
    const partBHeading = span.find((b) => b.kind === 'p' && b.style === 'Heading2' && PART_B_RE.test(b.text));
    const partCHeading = span.find((b) => b.kind === 'p' && b.style === 'Heading2' && PART_C_RE.test(b.text));

    let partC: ModuleBlockMap['part_c'] = null;
    if (partCHeading) {
      const tail = span.filter((b) => b.index > partCHeading.index);
      const slides = tail.filter((b) => b.kind === 'p' && SLIDE_RE.test(b.text));
      const deckTitle = tail.find((b) => b.kind === 'p' && b.text.startsWith('Slide Deck'));
      partC = {
        heading: partCHeading.text,
        deck_title: deckTitle?.text ?? '',
        slide_count: slides.length,
        paragraph_count: tail.filter((b) => b.kind === 'p').length,
      };
    }

    const partATable = tableAfter(partAHeading);
    const lmsTable = tableAfter(lmsHeading);
    const partBTable = tableAfter(partBHeading);

    return {
      module_number: Number(m[1]),
      title: m[2] ?? '',
      start_block: head.index,
      end_block: endBlock,
      duration_text: durationBlock?.text ?? '',
      has_description: description !== undefined,
      part_a: partAHeading && partATable ? { heading: partAHeading.text, table: partATable } : null,
      lms_mapping: lmsHeading && lmsTable ? { heading: lmsHeading.text, table: lmsTable } : null,
      part_b: partBHeading && partBTable ? { heading: partBHeading.text, table: partBTable } : null,
      part_c: partC,
    };
  });

  // --- Front matter ------------------------------------------------------
  const blueprintHeading = blocks.find(
    (b) => b.kind === 'p' && b.style === 'Heading1' && BLUEPRINT_RE.test(b.text),
  );
  const firstModuleIndex = moduleHeadings[0]!.index;
  const frontBlocks = blocks.filter((b) => b.index < firstModuleIndex);
  const metadataTableBlock = frontBlocks.find((b) => b.kind === 'tbl');
  const guidelineGroups = frontBlocks
    .filter((b) => b.kind === 'p' && b.style === 'Heading2')
    .map((b) => b.text);
  // Headings only, and only ones that carry text: the Entrepreneur template
  // leaves an empty Heading1 where its guidelines section was removed, and an
  // empty TOC entry is worse than none.
  const frontHeadings = frontBlocks
    .filter((b) => b.kind === 'p' && (b.style === 'Heading1' || b.style === 'Heading2') && b.text.trim() !== '')
    .map((b) => ({ level: b.style === 'Heading1' ? (1 as const) : (2 as const), text: b.text }));

  // --- Assessment --------------------------------------------------------
  let assessment: TemplateMap['assessment'] = null;
  if (assessmentHeading) {
    const tail = blocks.filter((b) => b.index > assessmentHeading.index);
    assessment = {
      heading_block: assessmentHeading.index,
      heading_text: assessmentHeading.text,
      strategy_point_count: tail.filter((b) => b.kind === 'p' && b.style === 'ListNumber').length,
      question_bank_groups: tail.filter((b) => b.kind === 'p' && b.style === 'Heading3').map((b) => b.text),
      question_count: tail.filter((b) => b.kind === 'p' && QUESTION_RE.test(b.text)).length,
    };
  }

  const sectPrEl = descendants(document, 'sectPr')[0];
  if (!sectPrEl) {
    throw new TemplateAnalysisError(
      'no w:sectPr found. Page size, orientation and margins cannot be established.',
    );
  }

  const map: TemplateMap = {
    template_version: templateVersion,
    source_file: file,
    package_parts: Object.keys(parts).sort(),
    total_blocks: blocks.length,
    total_tables: blocks.filter((b) => b.kind === 'tbl').length,
    paragraph_styles: paragraphStyles,
    front_matter: {
      blueprint_heading_block: blueprintHeading?.index ?? -1,
      blueprint_heading_text: blueprintHeading?.text ?? '',
      metadata_table: metadataTableBlock ? analyzeTable(metadataTableBlock.el, metadataTableBlock.tableIndex ?? 1) : null,
      front_headings: frontHeadings,
      guideline_groups: guidelineGroups,
      guideline_bullet_count: frontBlocks.filter((b) => b.kind === 'p' && b.style.startsWith('ListBullet')).length,
    },
    modules,
    assessment,
    sect_pr_xml: serializeXml(sectPrEl),
  };

  const prototypes = extractPrototypes(blocks, modules, assessment);

  return { map, prototypes, document, parts };
}

// ---------------------------------------------------------------------------
// Prototype extraction
// ---------------------------------------------------------------------------

/**
 * Lifts clone prototypes out of the template's first fully-formed module.
 *
 * The first module is used because the analyzer has already confirmed it carries
 * every sub-structure. Cloning from a real module means the generated document's
 * paragraphs and rows are the template's own, so no formatting decision is ever
 * made by this codebase.
 */
function extractPrototypes(
  blocks: BlockInfo[],
  modules: ModuleBlockMap[],
  assessment: TemplateMap['assessment'],
): BlockPrototypes {
  const complete = modules.find((m) => m.part_a && m.lms_mapping && m.part_b && m.part_c);
  if (!complete) {
    throw new TemplateAnalysisError(
      'no module in the template contains all of Part A, LMS Technical Mapping, Part B ' +
        'and Part C. Cannot derive clone prototypes.',
    );
  }

  const span = blocks.filter((b) => b.index >= complete.start_block && b.index < complete.end_block);
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new TemplateAnalysisError(`could not locate ${what} in module ${complete.module_number}.`);
    return value;
  };

  const heading = need(span.find((b) => b.style === 'Heading1'), 'the module Heading1');
  const duration = need(span.find((b) => b.kind === 'p' && DURATION_RE.test(b.text)), 'the "Total Duration" paragraph');
  const description = need(
    span.find((b) => b.kind === 'p' && !b.style && b.text.length > 80 && b.index > duration.index),
    'the module description paragraph',
  );
  const spacer = need(
    span.find((b) => b.kind === 'p' && !b.style && b.text === ''),
    'an empty spacer paragraph',
  );

  const headingByRe = (re: RegExp, what: string) =>
    need(span.find((b) => b.kind === 'p' && b.style === 'Heading2' && re.test(b.text)), what);

  const partAHeading = headingByRe(PART_A_RE, 'the Part A heading');
  const lmsHeading = headingByRe(LMS_RE, 'the LMS Technical Mapping heading');
  const partBHeading = headingByRe(PART_B_RE, 'the Part B heading');
  const partCHeading = headingByRe(PART_C_RE, 'the Part C heading');

  const tableAfter = (from: BlockInfo, what: string) =>
    need(span.find((b) => b.kind === 'tbl' && b.index > from.index), what);

  const partATable = tableAfter(partAHeading, 'the Part A table');
  const lmsTable = tableAfter(lmsHeading, 'the LMS Technical Mapping table');
  const partBTable = tableAfter(partBHeading, 'the Part B table');

  const rowsOf = (tbl: BlockInfo, what: string) => {
    const rows = tableRows(tbl.el);
    const header = rows[0];
    const body = rows[1];
    if (!header || !body) {
      throw new TemplateAnalysisError(`${what} has fewer than two rows, so no body-row prototype exists.`);
    }
    return { header, body };
  };

  const partARows = rowsOf(partATable, 'the Part A table');
  const lmsRows = rowsOf(lmsTable, 'the LMS Technical Mapping table');
  const partBRows = rowsOf(partBTable, 'the Part B table');

  const partCTail = span.filter((b) => b.index > partCHeading.index && b.kind === 'p');
  const deckTitle = need(partCTail.find((b) => b.text.startsWith('Slide Deck')), 'the Part C deck title paragraph');
  const slideTitle = need(partCTail.find((b) => SLIDE_RE.test(b.text)), 'a "Slide <n>:" paragraph');
  const visualCues = need(partCTail.find((b) => VISUAL_CUES_RE.test(b.text)), 'a "Visual Cues:" paragraph');
  const instructorScript = need(
    partCTail.find((b) => INSTRUCTOR_SCRIPT_RE.test(b.text)),
    'an "Instructor Script:" paragraph',
  );

  // Question-bank prototypes come from after the assessment heading.
  const qTail = assessment
    ? blocks.filter((b) => b.index > assessment.heading_block && b.kind === 'p')
    : [];
  const questionStem = need(qTail.find((b) => QUESTION_RE.test(b.text)), 'a question stem paragraph');
  const questionOption = need(
    qTail.find((b) => b.style.startsWith('ListBullet') && /^[a-d]\)\s/.test(b.text)),
    'a question option paragraph',
  );
  const questionAnswer = need(qTail.find((b) => CORRECT_ANSWER_RE.test(b.text)), 'a "Correct Answer:" paragraph');
  const questionExplanation = need(qTail.find((b) => EXPLANATION_RE.test(b.text)), 'an "Explanation:" paragraph');
  const questionGroupHeading = need(qTail.find((b) => b.style === 'Heading3'), 'a question-bank Heading3');
  const assessmentSubheading = need(
    qTail.find((b) => b.style === 'Heading2'),
    'a Heading2 inside the assessment section',
  );
  const strategyPoint = need(
    qTail.find((b) => b.style === 'ListNumber'),
    'a numbered assessment-strategy point (ListNumber)',
  );

  const xml = (b: BlockInfo) => serializeXml(b.el);

  return {
    module_heading: xml(heading),
    module_duration: xml(duration),
    module_description: xml(description),
    part_a_heading: xml(partAHeading),
    part_a_table: xml(partATable),
    part_a_header_row: serializeXml(partARows.header),
    part_a_body_row: serializeXml(partARows.body),
    lms_heading: xml(lmsHeading),
    lms_table: xml(lmsTable),
    lms_header_row: serializeXml(lmsRows.header),
    lms_body_row: serializeXml(lmsRows.body),
    part_b_heading: xml(partBHeading),
    part_b_table: xml(partBTable),
    part_b_header_row: serializeXml(partBRows.header),
    part_b_body_row: serializeXml(partBRows.body),
    part_c_heading: xml(partCHeading),
    part_c_deck_title: xml(deckTitle),
    part_c_slide_title: xml(slideTitle),
    part_c_visual_cues: xml(visualCues),
    part_c_instructor_script: xml(instructorScript),
    spacer: xml(spacer),
    question_stem: xml(questionStem),
    question_option: xml(questionOption),
    question_answer: xml(questionAnswer),
    question_explanation: xml(questionExplanation),
    question_group_heading: xml(questionGroupHeading),
    assessment_subheading: xml(assessmentSubheading),
    strategy_point: xml(strategyPoint),
    assessment_bullet: xml(questionOption),
  };
}

/** Namespace declarations needed when re-parsing a serialized fragment. */
export const FRAGMENT_NS = `xmlns:w="${W}"`;
