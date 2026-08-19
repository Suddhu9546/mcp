/**
 * Structure-aware chunking.
 *
 * Chunks are the unit of citation, so their boundaries matter: a chunk that
 * straddles two units produces a citation a reviewer cannot verify. Splitting
 * therefore follows the document's own headings first and only falls back to size
 * when a section is longer than the target.
 *
 * Every chunk records the chapter and unit it came from, which is what makes
 * course-and-chapter scoped retrieval possible. For Biofuels this is essential:
 * the timing document's Module 5 is the handbook's chapter 7, so retrieval must
 * filter on the chapter recorded here rather than on a module number.
 */

import type { DocumentType } from '../types/source.js';
import type { ExtractedPage } from './pdf-extractor.js';
import { config } from '../util/config.js';

export interface Chunk {
  chunk_id: string;
  course_id: string;
  document_type: DocumentType;
  pdf_page: number;
  printed_page?: number;
  /**
   * PH/FG chapter this chunk belongs to. Never set for the QP, which is organised
   * by NOS rather than by chapter -- see `nos_code`.
   */
  chapter?: number;
  /** Unit code such as "1.1", when the chunk sits under a unit heading. */
  unit_code?: string;
  /**
   * NOS code such as "SGJ/N4105", when the chunk sits under a NOS heading. This is
   * how QP content is scoped, since the crosswalk maps each module to a NOS.
   */
  nos_code?: string;
  /** Nearest enclosing heading text. */
  section: string;
  subsection?: string;
  content: string;
  char_count: number;
  ordinal: number;
}

/** Headings in the SCGJ documents, most specific first. */
const UNIT_HEADING_RE = /^(?:UNIT|Unit)\s+(\d+)\.(\d+)\s*[:\-–]?\s*(.+)$/;
const CHAPTER_HEADING_RE = /^(\d+)\.\s+([A-Z][^.]{6,120})$/;
const NOS_HEADING_RE = /^((?:SGJ|DGT)\/(?:VSQ\/)?[NQ]\d+)\s*[:.]\s*(.+)$/;
/** FG pedagogical cue words that begin a facilitator instruction block. */
const FG_CUE_RE = /^(Say|Do|Ask|Explain|Elaborate|Demonstrate|Activity|Team Activity|Role Play|Notes|Resources to be Used|Unit Objectives|Ask the participants)\s*[:.]?\s*$/;

function compileNoise(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p));
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'of', 'in', 'to', 'a', 'an', 'with', 'on', 'at', 'by', 'from',
]);

function titleTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

/**
 * Decides whether a numbered line is genuinely a chapter opener.
 *
 * A bare `^\d+\. Title$` pattern is far too permissive in these documents:
 * "7. Annexures", "7. Packaging Machine" (a figure caption inside chapter 2) and
 * "9. Discuss various biomass energy conversion technologies" (a unit-objectives
 * list item) all match it. Each one silently reassigned every following chunk to
 * the wrong chapter, so a module-scoped search returned correctly-cited content
 * from the wrong part of the book.
 *
 * The line must therefore both carry a chapter number the course declares and
 * share enough of that chapter's expected title.
 */
function matchChapterHeading(
  line: string,
  chapterTitles: Record<number, string>,
): { chapter: number; title: string } | undefined {
  const m = CHAPTER_HEADING_RE.exec(line);
  if (!m) return undefined;

  const chapter = Number(m[1]);
  const expected = chapterTitles[chapter];
  if (expected === undefined) return undefined;

  const found = titleTokens(m[2] ?? '');
  if (found.size === 0) return undefined;

  const want = titleTokens(expected);
  let hits = 0;
  for (const token of want) if (found.has(token)) hits += 1;

  // Half the expected title's significant words must be present. "Ensure
  // Manufacturing of Biomass pellet" against "Packaging Machine" scores 0.
  const coverage = want.size === 0 ? 0 : hits / want.size;
  if (coverage < 0.5) return undefined;

  return { chapter, title: `${chapter}. ${expected}` };
}

/**
 * Drops running headers, footers and folio numbers.
 *
 * The Biofuels handbook carries a stray "Plastic Recycling Operator" running
 * header on printed pages 283-291, left over from another qualification. Left in,
 * it would be retrievable as Biofuels content and citable as a section name.
 */
function cleanLines(text: string, noise: readonly RegExp[]): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      if (/^\d{1,4}$/.test(line)) return false; // bare folio number
      if (/^[ivxlcdm]{1,6}$/i.test(line)) return false; // roman folio
      return !noise.some((re) => re.test(line));
    });
}

/** A table-of-contents line: title, dot leaders, page number. */
function isTocLine(line: string): boolean {
  return /\.{4,}\s*\d+\s*$/.test(line) || /\s\.\s?\.\s?\.\s?\./.test(line);
}

const TOC_UNIT_RE = /^(?:UNIT|Unit)\s+(\d+)\.(\d+)\s*[:\-–—]?\s*(.+?)\s*\.{4,}\s*\d+\s*$/;
const TOC_CHAPTER_RE = /^(\d+)\.\s+(.+?)\s*\.{4,}\s*\d+\s*$/;

export interface DocumentContents {
  /** Unit code to the title as printed in the table of contents. */
  unit_titles: Map<string, string>;
  /** Chapter number to the title as printed in the table of contents. */
  chapter_titles: Record<number, string>;
}

/**
 * Reads the document's own table of contents.
 *
 * The contents page is the handbook's canonical statement of its own structure, and
 * it has two properties the body headings do not: every title is complete on one
 * line, and the list is exhaustive. Body headings wrap mid-phrase -- "UNIT 5.2:
 * First Aid and Emergency Response in Bioenergy" continues as "manufacturing
 * Facilities" on the next line -- and no general rule distinguishes that
 * continuation from the first line of a paragraph. Taking the title from the
 * contents page removes the guesswork.
 *
 * The chapter titles are collected for the same reason, and additionally so that a
 * course whose chapter table has not been reviewed yet still gets real titles.
 */
export function collectContents(pages: readonly ExtractedPage[]): DocumentContents {
  const unitTitles = new Map<string, string>();
  const chapterTitles: Record<number, string> = {};

  for (const page of pages) {
    const lines = page.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    // Only read pages that are predominantly contents entries, so a stray line
    // with dot leaders elsewhere in the book cannot rewrite a title.
    const tocDensity = lines.length > 0 ? lines.filter(isTocLine).length / lines.length : 0;
    if (tocDensity <= 0.5) continue;

    for (const line of lines) {
      const unit = TOC_UNIT_RE.exec(line);
      if (unit) {
        const code = `${unit[1]}.${unit[2]}`;
        // First occurrence wins: the contents list precedes any later index.
        if (!unitTitles.has(code)) unitTitles.set(code, unit[3]!.trim().replace(/\s+/g, ' '));
        continue;
      }
      const chapter = TOC_CHAPTER_RE.exec(line);
      if (chapter) {
        const number = Number(chapter[1]);
        const title = chapter[2]!.trim().replace(/\s+/g, ' ').replace(/\.$/, '');
        if (chapterTitles[number] === undefined && title.length > 5) chapterTitles[number] = title;
      }
    }
  }

  return { unit_titles: unitTitles, chapter_titles: chapterTitles };
}

/**
 * Decides whether a line continues the heading above it.
 *
 * Headings in these handbooks wrap: "UNIT 2.1: Fundamentals of Financial Management
 * for" is followed by "Biomass Enterprises" on its own line. Taking only the first
 * line gives a truncated unit title, which is what the user is then asked to choose
 * from, and a truncated section string in every citation from that unit.
 *
 * A continuation is short, starts like a title, carries no terminal punctuation and
 * is not itself a heading or a pedagogical cue -- "Unit Objectives" and "At the end
 * of this unit, you will be able to:" both follow real unit headings and neither
 * may be swallowed.
 */
function isHeadingContinuation(line: string | undefined): boolean {
  if (line === undefined) return false;
  if (line.length === 0 || line.length > 60) return false;
  if (!/^[A-Z(]/.test(line)) return false;
  if (/[.:;,?!]$/.test(line)) return false;
  if (UNIT_HEADING_RE.test(line) || NOS_HEADING_RE.test(line) || CHAPTER_HEADING_RE.test(line)) {
    return false;
  }
  return !FG_CUE_RE.test(line);
}

/** Joins a wrapped heading, honouring a hyphen break ("Bio-" + "Energy" -> "Bio-Energy"). */
function joinWrapped(head: string, tail: string): string {
  const joined = head.endsWith('-') ? `${head}${tail}` : `${head} ${tail}`;
  return joined.replace(/\s+/g, ' ').trim();
}

/**
 * Whether a numbered line is the first half of a wrapped chapter opener.
 *
 * Required before trying the joined pair against the chapter titles, because
 * joining indiscriminately is actively harmful: "5. Environmental and Community
 * Safety:" is an ordinary list item on a page of Unit 5.1, but joined with the
 * sentence beneath it, it shares enough words with "Health & Safety in Bioenergy
 * Manufacturing facility" to be mistaken for the chapter opener -- which silently
 * ended Unit 5.1 three pages early. A real wrapped opener is short and carries no
 * terminal punctuation.
 */
function looksLikeWrappedChapterOpener(line: string, next: string | undefined): boolean {
  if (next === undefined) return false;
  if (line.length > 60 || !/^\d+\.\s+[A-Z]/.test(line)) return false;
  if (/[.:;,?!]$/.test(line)) return false;
  return isHeadingContinuation(next);
}

/**
 * Recognises a module opener page: the page that lists a chapter's units before the
 * chapter begins.
 *
 * Such a page is an index, not content, but unlike the table of contents it has no
 * dot leaders to give it away. Left untreated, its last listed unit heading stayed
 * in effect across the page break, so the module's Key Learning Outcomes -- and the
 * chapter opener itself -- were filed under that unit. Module 1's outcomes were
 * being retrieved and cited as Unit 1.4 content.
 */
function isUnitIndexPage(lines: readonly string[]): boolean {
  const headings = lines.filter((l) => UNIT_HEADING_RE.test(l)).length;
  if (headings < 2) return false;
  // An index page is almost entirely headings; a content page that happens to
  // mention two units has substantive text around them.
  return lines.length - headings <= headings + 4;
}

interface Section {
  section: string;
  chapter?: number;
  unit_code?: string;
  nos_code?: string;
  subsection?: string;
  pdf_page: number;
  printed_page?: number;
  lines: string[];
}

/**
 * Groups a document's cleaned lines into sections under their headings, carrying
 * heading state forward across page breaks.
 */
function collectSections(
  pages: readonly ExtractedPage[],
  noise: readonly RegExp[],
  chapterTitles: Record<number, string>,
  assignChapters: boolean,
  contents: DocumentContents,
  printedPageOffset?: number,
): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;

  // A reviewed chapter table wins where it exists; the document's contents page
  // fills the gaps, which is what lets a newly supplied handbook be chunked
  // correctly before anyone has transcribed its chapter titles into the registry.
  const titles: Record<number, string> = { ...contents.chapter_titles, ...chapterTitles };

  let chapter: number | undefined;
  let unitCode: string | undefined;
  let nosCode: string | undefined;
  let heading = '(front matter)';

  const start = (page: ExtractedPage) => {
    const printed = page.printed_page ?? (printedPageOffset ? page.pdf_page - printedPageOffset : undefined);
    current = {
      section: heading,
      ...(chapter !== undefined ? { chapter } : {}),
      ...(unitCode !== undefined ? { unit_code: unitCode } : {}),
      ...(nosCode !== undefined ? { nos_code: nosCode } : {}),
      pdf_page: page.pdf_page,
      ...(printed !== undefined && printed > 0 ? { printed_page: printed } : {}),
      lines: [],
    };
    sections.push(current);
  };

  for (const page of pages) {
    const lines = cleanLines(page.text, noise);
    // Contents pages are navigation, not content. Skipping them stops every
    // heading in the book from being retrievable twice, once as a TOC entry.
    const tocDensity = lines.length > 0 ? lines.filter(isTocLine).length / lines.length : 0;
    if (tocDensity > 0.5) continue;

    start(page);

    // A module opener lists the chapter's units; those listings are navigation and
    // must not become the heading in force for the pages that follow.
    const indexPage = assignChapters && isUnitIndexPage(lines);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isTocLine(line)) continue;

      // Unit headings are the most reliable chapter signal in these documents:
      // the chapter number is embedded in the unit code, so "UNIT 7.1" fixes the
      // chapter without needing a chapter opener to have been seen at all.
      const unit = UNIT_HEADING_RE.exec(line);
      if (unit) {
        if (indexPage) {
          // Still worth the chapter number, which the unit code states outright,
          // but not a unit scope and not a new section.
          if (assignChapters) chapter = Number(unit[1]);
          continue;
        }
        const code = `${unit[1]}.${unit[2]}`;
        let title = unit[3]!.trim();
        // The contents page is authoritative for the title where it lists one; the
        // wrap heuristic is the fallback for a document with no usable contents.
        const canonical = contents.unit_titles.get(code);
        if (canonical) {
          // When the body heading is a prefix of the contents title, the title
          // wrapped, and the rest of it is sitting on the next line. Matching that
          // remainder exactly is what identifies it -- it need not look like a
          // heading at all: "First Aid and Emergency Response in Bioenergy"
          // continues as "manufacturing Facilities", which no general rule would
          // separate from ordinary prose. Left in, it becomes the unit's first line.
          const remainder = canonical.toLowerCase().startsWith(title.toLowerCase())
            ? canonical.slice(title.length).trim()
            : '';
          if (remainder.length > 0 && lines[i + 1]?.trim().toLowerCase() === remainder.toLowerCase()) {
            i += 1;
          }
          title = canonical;
        } else if (isHeadingContinuation(lines[i + 1])) {
          title = joinWrapped(title, lines[i + 1]!.trim());
          i += 1;
        }
        if (assignChapters) chapter = Number(unit[1]);
        unitCode = code;
        heading = `UNIT ${unitCode}: ${title}`;
        start(page);
        continue;
      }

      const nos = NOS_HEADING_RE.exec(line);
      if (nos) {
        unitCode = undefined;
        nosCode = nos[1];
        heading = `${nos[1]}: ${nos[2]!.trim()}`;
        start(page);
        continue;
      }

      if (!assignChapters) {
        // The QP has no chapters; leaving chapter unset here stops a stray
        // numbered line from pinning all 80-odd QP chunks to one wrong chapter.
        if (!current) start(page);
        current!.lines.push(line);
        continue;
      }

      // Chapter openers wrap too ("1. Entrepreneurship and" / "Basics of Biomass
      // Energy"), and a half title never carries enough of the expected words to be
      // recognised on its own -- but the pair is only tried when the first line
      // actually looks like a wrapped opener, never on ordinary numbered text.
      const direct = matchChapterHeading(line, titles);
      const wrapped =
        direct === undefined && looksLikeWrappedChapterOpener(line, lines[i + 1])
          ? matchChapterHeading(joinWrapped(line, lines[i + 1]!), titles)
          : undefined;
      const chap = direct ?? wrapped;
      if (chap) {
        if (direct === undefined) i += 1;
        chapter = chap.chapter;
        unitCode = undefined;
        heading = chap.title;
        start(page);
        continue;
      }

      const cue = FG_CUE_RE.exec(line);
      if (cue && current) {
        current.subsection = cue[1];
        continue;
      }

      if (!current) start(page);
      current!.lines.push(line);
    }
  }

  return sections.filter((s) => s.lines.length > 0);
}

/**
 * Splits an over-long section into overlapping windows on paragraph boundaries.
 *
 * Overlap exists so a claim spanning a window boundary is still fully present in
 * at least one chunk; without it a citation can point at a chunk holding only
 * half the supporting sentence.
 */
function windowSection(lines: readonly string[], targetChars: number, overlapChars: number): string[] {
  const out: string[] = [];
  let buffer: string[] = [];
  let size = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    out.push(buffer.join('\n'));
    if (overlapChars > 0) {
      // Carry trailing lines forward until the overlap budget is met.
      const carry: string[] = [];
      let carried = 0;
      for (let i = buffer.length - 1; i >= 0 && carried < overlapChars; i--) {
        const line = buffer[i]!;
        carry.unshift(line);
        carried += line.length + 1;
      }
      buffer = carry;
      size = carried;
    } else {
      buffer = [];
      size = 0;
    }
  };

  for (const line of lines) {
    if (size + line.length + 1 > targetChars && size > 0) flush();
    buffer.push(line);
    size += line.length + 1;
  }
  if (buffer.length > 0) out.push(buffer.join('\n'));

  // The overlap carry can make the final window a duplicate of the previous one.
  return out.filter((text, i) => i === 0 || text !== out[i - 1]);
}

export interface ChunkDocumentOptions {
  courseId: string;
  documentType: DocumentType;
  /**
   * Identifies the document within its course, for the chunk_id.
   *
   * A qualification course has one document per type, so the type is unique and
   * this is omitted. A CDR course has nine documents of type REF; without a key
   * their chunk_ids would collide on the first page of the second document.
   */
  docKey?: string;
  pages: readonly ExtractedPage[];
  noisePatterns?: readonly string[];
  /** Chapter number to expected title, used to validate chapter openers. */
  chapterTitles?: Record<number, string>;
  /**
   * Whether this document is organised into the course's chapters. True for PH and
   * FG; false for the QP (NOS-organised) and the timing document.
   */
  assignChapters?: boolean;
  printedPageOffset?: number;
  targetChars?: number;
  overlapChars?: number;
}

export function chunkDocument(options: ChunkDocumentOptions): Chunk[] {
  const {
    courseId,
    documentType,
    docKey,
    pages,
    noisePatterns = [],
    chapterTitles = {},
    assignChapters = documentType === 'PH' || documentType === 'FG',
    printedPageOffset,
    targetChars = config.chunking.targetChars,
    overlapChars = config.chunking.overlapChars,
  } = options;

  const noise = compileNoise(noisePatterns);
  // Read the document's own contents before chunking it, so unit and chapter
  // headings can be completed from it as they are encountered.
  const contents = collectContents(pages);
  const sections = collectSections(
    pages,
    noise,
    chapterTitles,
    assignChapters,
    contents,
    printedPageOffset,
  );

  const chunks: Chunk[] = [];
  let ordinal = 0;

  for (const section of sections) {
    for (const text of windowSection(section.lines, targetChars, overlapChars)) {
      const trimmed = text.trim();
      // Fragments this short are page furniture or stray captions, not content.
      if (trimmed.length < 40) continue;
      ordinal += 1;
      chunks.push({
        chunk_id: `${courseId}:${docKey ?? documentType}:p${section.pdf_page}:${ordinal}`,
        course_id: courseId,
        document_type: documentType,
        pdf_page: section.pdf_page,
        ...(section.printed_page !== undefined ? { printed_page: section.printed_page } : {}),
        ...(section.chapter !== undefined ? { chapter: section.chapter } : {}),
        ...(section.unit_code !== undefined ? { unit_code: section.unit_code } : {}),
        ...(section.nos_code !== undefined ? { nos_code: section.nos_code } : {}),
        section: section.section,
        ...(section.subsection !== undefined ? { subsection: section.subsection } : {}),
        content: trimmed,
        char_count: trimmed.length,
        ordinal,
      });
    }
  }

  return chunks;
}
