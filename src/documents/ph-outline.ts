/**
 * Participant Handbook navigation and verbatim reading.
 *
 * The video flows treat the Participant Handbook as the source of truth, so they
 * need three things this file provides and nothing else does:
 *
 *   1. the handbook's own structure -- its modules and units -- derived from the
 *      indexed document rather than declared in code, so a handbook revision is
 *      picked up by re-ingesting;
 *   2. the exact text of one unit, reassembled from its chunks with the indexing
 *      overlap removed, for the reading mode that must not transform anything;
 *   3. a way to find a unit from a heading a user typed, across subjects, for the
 *      shortcut flow.
 *
 * MODULE NUMBERING. "Module" here means a Participant Handbook chapter, because
 * that is the structure the user is being shown and selecting from. It is not the
 * Timing Allocation Document's module number, which disagrees (timing module 5 is
 * handbook chapter 7). Where a crosswalk exists the timing number is reported
 * alongside as `timing_module`, clearly labelled, and never substituted.
 */

import { getCourseConfig, type ModuleCrosswalkEntry } from '../courses/course-config.js';
import { findSubjectByCourseId, listSubjects, subjectStatus, type CourseTrack } from '../catalog/subject-catalog.js';
import { getDb } from '../storage/db.js';
import type { SourceRef } from '../types/source.js';

export interface PhUnit {
  unit_code: string;
  /** Participant Handbook chapter number, taken from the unit code. */
  module_number: number;
  /** Unit title with the "UNIT 1.2:" prefix removed. */
  title: string;
  /** The heading exactly as the chunk index recorded it. */
  heading: string;
  pdf_page_start: number;
  pdf_page_end: number;
  printed_page_start?: number;
  printed_page_end?: number;
  chunk_count: number;
  char_count: number;
}

export interface PhModule {
  module_number: number;
  title: string;
  unit_count: number;
  char_count: number;
  /** Timing Allocation module number, when the course has a reviewed crosswalk. */
  timing_module?: number;
  nos_code?: string;
  /**
   * False when the handbook declares this module but gives it no units. Biofuels
   * module 6 (Employability Skills) is one: the handbook carries the heading and a
   * paragraph deferring to an external DGT workbook, and nothing else. Such a
   * module is still listed, because hiding it would misrepresent the handbook the
   * user is choosing from -- it just cannot be selected for generation.
   */
  has_units: boolean;
  /** Why the module has no units, when it has none. */
  note?: string;
  units: PhUnit[];
}

export interface PhOutline {
  course_id: string;
  subject_id?: string;
  subject_code?: string;
  module_count: number;
  unit_count: number;
  /** Modules that can actually be used for a transcript or a reading. */
  selectable_module_count: number;
  modules: PhModule[];
}

interface UnitChunkRow {
  chunk_id: string;
  chapter: number | null;
  unit_code: string;
  section: string;
  pdf_page: number;
  printed_page: number | null;
  content: string;
  char_count: number;
  ordinal: number;
}

const UNIT_PREFIX_RE = /^UNIT\s+\d+\.\d+\s*[:\-–]?\s*/i;

function stripUnitPrefix(heading: string): string {
  return heading.replace(UNIT_PREFIX_RE, '').trim();
}

/** Chapter number implied by a unit code such as "7.3". */
function chapterOf(unitCode: string): number {
  return Number(unitCode.split('.')[0]);
}

/**
 * Every chapter the indexed handbook mentions, whether or not it has units.
 *
 * Chapters are read from the document rather than from the course configuration so
 * that a subject with no reviewed chapter table still lists its modules, and so a
 * handbook that gains a chapter is picked up by re-ingesting.
 */
function chapterNumbers(courseId: string): number[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT chapter FROM chunks
       WHERE course_id = ? AND document_type = 'PH' AND chapter IS NOT NULL
       ORDER BY chapter ASC`,
    )
    .all(courseId) as unknown as { chapter: number }[];
  return rows.map((r) => r.chapter);
}

/**
 * The chapter's own printed heading, when the handbook prints one.
 *
 * Some handbooks open each chapter with a numbered heading ("7. Ensure
 * Manufacturing of Biomass pellet") that the chunker records as a section on a
 * non-unit chunk; others jump straight to the first unit and print no chapter
 * heading at all. Reading it here means a newly ingested course gets real module
 * titles without anyone hand-copying them into chapter_titles, and a course whose
 * handbook has no such heading falls back rather than inventing one.
 */
function chapterHeading(courseId: string, chapter: number): string | undefined {
  const rows = getDb()
    .prepare(
      `SELECT section FROM chunks
       WHERE course_id = ? AND document_type = 'PH' AND chapter = ? AND unit_code IS NULL
         AND section IS NOT NULL
       ORDER BY ordinal ASC LIMIT 4`,
    )
    .all(courseId, chapter) as unknown as { section: string }[];
  for (const row of rows) {
    // Only a heading that states this chapter's own number is trusted; anything
    // else is front matter or a stray running head.
    const match = new RegExp(`^${chapter}[.:)]\\s+(.+)$`).exec(row.section.trim());
    const title = match?.[1]?.trim();
    if (title && title.length > 2) return title;
  }
  return undefined;
}

/** The first line of a chapter that has no units, used to explain why it has none. */
function chapterOpeningText(courseId: string, chapter: number): string | undefined {
  const row = getDb()
    .prepare(
      `SELECT content FROM chunks
       WHERE course_id = ? AND document_type = 'PH' AND chapter = ? AND unit_code IS NULL
       ORDER BY ordinal ASC LIMIT 1`,
    )
    .get(courseId, chapter) as { content: string } | undefined;
  return row?.content.split('\n').slice(0, 4).join(' ').trim();
}

function unitChunks(courseId: string, unitCode?: string): UnitChunkRow[] {
  const params: (string | number)[] = [courseId];
  let sql = `
    SELECT chunk_id, chapter, unit_code, section, pdf_page, printed_page, content, char_count, ordinal
    FROM chunks
    WHERE course_id = ? AND document_type = 'PH' AND unit_code IS NOT NULL`;
  if (unitCode !== undefined) {
    sql += ' AND unit_code = ?';
    params.push(unitCode);
  }
  sql += ' ORDER BY ordinal ASC';
  return getDb().prepare(sql).all(...params) as unknown as UnitChunkRow[];
}

function crosswalkForChapter(courseId: string, chapter: number): ModuleCrosswalkEntry | undefined {
  return getCourseConfig(courseId).crosswalk.find((c) => c.source_chapter === chapter);
}

/**
 * Derives the handbook's module and unit structure from the indexed chunks.
 *
 * Units are the grouping key rather than chapters, because a unit heading such as
 * "UNIT 7.1" states its own chapter and is the most reliable structural signal the
 * chunker records. A chapter with no unit headings therefore does not appear here,
 * which is correct: there is no unit for the user to select in it.
 */
export function getPhOutline(courseId: string): PhOutline {
  // Throws for an unregistered course, so a typo cannot silently widen scope.
  const course = getCourseConfig(courseId);
  const rows = unitChunks(courseId);

  const byUnit = new Map<string, UnitChunkRow[]>();
  for (const row of rows) {
    const list = byUnit.get(row.unit_code);
    if (list) list.push(row);
    else byUnit.set(row.unit_code, [row]);
  }

  const units: PhUnit[] = [...byUnit.entries()].map(([unitCode, chunks]) => {
    const pages = chunks.map((c) => c.pdf_page);
    const printed = chunks.map((c) => c.printed_page).filter((p): p is number => p !== null);
    // The first chunk carries the heading as it was printed; later chunks of the
    // same unit repeat it, so taking the first keeps the document's own wording.
    const heading = chunks[0]!.section;
    return {
      unit_code: unitCode,
      module_number: chunks[0]!.chapter ?? chapterOf(unitCode),
      title: stripUnitPrefix(heading),
      heading,
      pdf_page_start: Math.min(...pages),
      pdf_page_end: Math.max(...pages),
      ...(printed.length > 0
        ? { printed_page_start: Math.min(...printed), printed_page_end: Math.max(...printed) }
        : {}),
      chunk_count: chunks.length,
      char_count: chunks.reduce((a, c) => a + c.char_count, 0),
    };
  });

  const sortUnits = (a: PhUnit, b: PhUnit): number => {
    const [aMaj, aMin] = a.unit_code.split('.').map(Number) as [number, number];
    const [bMaj, bMin] = b.unit_code.split('.').map(Number) as [number, number];
    return aMaj !== bMaj ? aMaj - bMaj : aMin - bMin;
  };

  // The union of chapters that hold units and chapters the handbook declares at
  // all: a chapter which only defers to an external workbook has no units but is
  // still one of the modules the handbook presents.
  const moduleNumbers = [
    ...new Set([...units.map((u) => u.module_number), ...chapterNumbers(courseId)]),
  ].sort((a, b) => a - b);

  const modules: PhModule[] = moduleNumbers.map((number) => {
    const moduleUnits = units.filter((u) => u.module_number === number).sort(sortUnits);
    const crosswalk = crosswalkForChapter(courseId, number);
    const hasUnits = moduleUnits.length > 0;
    const opening = hasUnits ? undefined : chapterOpeningText(courseId, number);
    return {
      module_number: number,
      title: course.chapter_titles[number] ?? chapterHeading(courseId, number) ?? `Module ${number}`,
      unit_count: moduleUnits.length,
      char_count: moduleUnits.reduce((a, u) => a + u.char_count, 0),
      ...(crosswalk ? { timing_module: crosswalk.timing_module, nos_code: crosswalk.nos_code } : {}),
      has_units: hasUnits,
      ...(hasUnits
        ? {}
        : {
            note:
              'The handbook declares this module but gives it no units, so there is no unit ' +
              'text to read or to build a video from.' +
              (opening ? ` The handbook says: "${opening}"` : ''),
          }),
      units: moduleUnits,
    };
  });

  const subject = findSubjectByCourseId(courseId);
  return {
    course_id: courseId,
    ...(subject ? { subject_id: subject.subject_id, subject_code: subject.code } : {}),
    module_count: modules.length,
    unit_count: units.length,
    selectable_module_count: modules.filter((m) => m.has_units).length,
    modules,
  };
}

export interface PhUnitBlock {
  chunk_id: string;
  pdf_page: number;
  printed_page?: number;
  /** Text of this block after overlap with the previous block was removed. */
  text: string;
  char_count: number;
}

export interface PhUnitReading {
  course_id: string;
  subject_id?: string;
  subject_code?: string;
  unit: PhUnit;
  /** The unit's text, reassembled in document order with indexing overlap removed. */
  text: string;
  word_count: number;
  char_count: number;
  /** One entry per source chunk, in order, for scene-level citation. */
  blocks: PhUnitBlock[];
  chunk_ids: string[];
  sources: SourceRef[];
  /**
   * What the reassembly did and did not preserve. Stated on every reading so the
   * word "exact" is never overclaimed.
   */
  fidelity_note: string;
}

const FIDELITY_NOTE =
  'This is the Participant Handbook text for this unit, reproduced verbatim in document ' +
  'order. Nothing has been rewritten, summarised, paraphrased, reordered or added. Two ' +
  'mechanical removals were applied during indexing and are the only differences from the ' +
  'printed page: repeated running headers/footers and bare folio page numbers, and the ' +
  'overlap the indexer adds between adjacent chunks. Original line breaks are preserved; ' +
  'the PDF text layer does not carry bold, italic, figures or table ruling.';

/**
 * Removes the indexing overlap when joining two adjacent chunks.
 *
 * The chunker carries trailing lines of one window forward into the next so a claim
 * spanning a boundary is whole in at least one chunk. Concatenating chunks
 * therefore duplicates those lines, which for a reading mode would mean the user
 * seeing a paragraph twice and believing the handbook repeats itself. The longest
 * suffix of what has been accumulated that equals a prefix of the next chunk is the
 * overlap, so it is dropped exactly once.
 */
function appendWithoutOverlap(accumulated: string[], next: string[]): string[] {
  const max = Math.min(accumulated.length, next.length);
  for (let k = max; k > 0; k--) {
    let matches = true;
    for (let i = 0; i < k; i++) {
      if (accumulated[accumulated.length - k + i] !== next[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return next.slice(k);
  }
  return next;
}

function countWords(text: string): number {
  const matched = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu);
  return matched ? matched.length : 0;
}

export class UnitNotFoundError extends Error {
  constructor(
    message: string,
    readonly available: string[],
  ) {
    super(message);
    this.name = 'UnitNotFoundError';
  }
}

/**
 * Reads one unit out of the Participant Handbook.
 *
 * This is the single reading path for both video flows and the exact-reading flow.
 * That is deliberate: the transcript is grounded in exactly the text a user can ask
 * to see, so "show me what the handbook actually says" and "make a video from it"
 * can never disagree about what the unit contains.
 */
export function readPhUnit(courseId: string, unitCode: string): PhUnitReading {
  const rows = unitChunks(courseId, unitCode);
  if (rows.length === 0) {
    const outline = getPhOutline(courseId);
    const available = outline.modules.flatMap((m) => m.units.map((u) => u.unit_code));
    throw new UnitNotFoundError(
      available.length === 0
        ? `Course "${courseId}" has no indexed Participant Handbook units. Run ` +
          `ingest_course_documents for "${courseId}" first.`
        : `Course "${courseId}" has no Participant Handbook unit "${unitCode}". ` +
          `Available units: ${available.join(', ')}.`,
      available,
    );
  }

  const blocks: PhUnitBlock[] = [];
  let accumulated: string[] = [];
  for (const row of rows) {
    const lines = row.content.split('\n');
    const fresh = appendWithoutOverlap(accumulated, lines);
    if (fresh.length === 0) continue; // wholly contained in what came before
    accumulated = accumulated.concat(fresh);
    const text = fresh.join('\n');
    blocks.push({
      chunk_id: row.chunk_id,
      pdf_page: row.pdf_page,
      ...(row.printed_page !== null ? { printed_page: row.printed_page } : {}),
      text,
      char_count: text.length,
    });
  }

  const heading = rows[0]!.section;
  const pages = rows.map((r) => r.pdf_page);
  const printed = rows.map((r) => r.printed_page).filter((p): p is number => p !== null);
  const unit: PhUnit = {
    unit_code: unitCode,
    module_number: rows[0]!.chapter ?? chapterOf(unitCode),
    title: stripUnitPrefix(heading),
    heading,
    pdf_page_start: Math.min(...pages),
    pdf_page_end: Math.max(...pages),
    ...(printed.length > 0
      ? { printed_page_start: Math.min(...printed), printed_page_end: Math.max(...printed) }
      : {}),
    chunk_count: rows.length,
    char_count: rows.reduce((a, r) => a + r.char_count, 0),
  };

  const text = accumulated.join('\n');
  const subject = findSubjectByCourseId(courseId);

  return {
    course_id: courseId,
    ...(subject ? { subject_id: subject.subject_id, subject_code: subject.code } : {}),
    unit,
    text,
    word_count: countWords(text),
    char_count: text.length,
    blocks,
    chunk_ids: rows.map((r) => r.chunk_id),
    sources: rows.map((r) => ({
      document_type: 'PH' as const,
      pdf_page: r.pdf_page,
      ...(r.printed_page !== null ? { printed_page: r.printed_page } : {}),
      section: r.section,
      chunk_id: r.chunk_id,
    })),
    fidelity_note: FIDELITY_NOTE,
  };
}

export interface PhModuleReading {
  course_id: string;
  subject_id?: string;
  subject_code?: string;
  module_number: number;
  module_title: string;
  /** Every unit of the module, in handbook order, each read whole. */
  units: PhUnitReading[];
  word_count: number;
  char_count: number;
  fidelity_note: string;
}

/**
 * Reads a whole module: every unit in it, in the handbook's order.
 *
 * This is the source for a module content package. Reading the units through the
 * same path as a single-unit reading matters: the 12 minutes of content a learner
 * gets and the text a reviewer can ask to see are then the same words, and no unit
 * of the module can be quietly left out of one or the other.
 */
export function readPhModule(courseId: string, moduleNumber: number): PhModuleReading {
  const outline = getPhOutline(courseId);
  const module = outline.modules.find((m) => m.module_number === moduleNumber);
  if (!module) {
    throw new UnitNotFoundError(
      `Course "${courseId}" has no Participant Handbook module ${moduleNumber}. ` +
        `It has modules ${outline.modules.map((m) => m.module_number).join(', ')}.`,
      [],
    );
  }
  if (!module.has_units) {
    throw new UnitNotFoundError(
      `Module ${moduleNumber} (${module.title}) has no units in the handbook, so there is ` +
        `nothing to build content from. ${module.note ?? ''}`.trim(),
      [],
    );
  }

  const units = module.units.map((u) => readPhUnit(courseId, u.unit_code));
  return {
    course_id: courseId,
    ...(outline.subject_id ? { subject_id: outline.subject_id } : {}),
    ...(outline.subject_code ? { subject_code: outline.subject_code } : {}),
    module_number: module.module_number,
    module_title: module.title,
    units,
    word_count: units.reduce((a, u) => a + u.word_count, 0),
    char_count: units.reduce((a, u) => a + u.char_count, 0),
    fidelity_note: FIDELITY_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Heading resolution (the shortcut flow's entry point)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'of', 'in', 'to', 'a', 'an', 'with', 'on', 'at', 'by', 'from', 'unit',
  'module', 'chapter', 'its', 'is', 'are', 'as', 'or', 'video', 'script', 'transcript', 'create',
  'make', 'about', 'this', 'that',
]);

function headingTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/** Unit code stated anywhere in the query, e.g. "unit 7.2" or just "7.2". */
function statedUnitCode(query: string): string | undefined {
  const m = /\b(\d{1,2})\.(\d{1,2})\b/.exec(query);
  return m ? `${m[1]}.${m[2]}` : undefined;
}

export interface UnitCandidate {
  course_id: string;
  subject_id?: string;
  subject_code?: string;
  track?: CourseTrack;
  unit: PhUnit;
  /** 0-1. Harmonic mean of how much of the query and of the heading matched. */
  score: number;
  matched_terms: string[];
  matched_unit_code: boolean;
}

export interface FindUnitOptions {
  /** Restrict to one subject's handbook. */
  courseId?: string;
  track?: CourseTrack;
  limit?: number;
}

export interface FindUnitResult {
  query: string;
  searched_courses: string[];
  /** True when the top candidate is clearly ahead: safe to proceed without asking. */
  confident: boolean;
  candidates: UnitCandidate[];
  /** Set when nothing was searchable, explaining why. */
  message?: string;
}

/**
 * Finds the unit a free-text heading refers to, across every indexed handbook.
 *
 * Scoring is a deterministic token F-measure, not a model judgement: it rewards
 * covering the query *and* covering the heading, so "Financial Planning" does not
 * beat "Financial Planning and Budgeting" on a query that named both. Ambiguity is
 * reported rather than resolved -- `confident` is false when the top two candidates
 * are close, and the client is expected to ask the user which one they meant.
 */
export function findPhUnits(query: string, options: FindUnitOptions = {}): FindUnitResult {
  const limit = options.limit ?? 5;
  const wanted = headingTokens(query);
  const code = statedUnitCode(query);

  const subjects = listSubjects(options.track).filter(
    (s) => options.courseId === undefined || s.course_id === options.courseId,
  );
  const usable = subjects.filter((s) => subjectStatus(s).ready);

  if (usable.length === 0) {
    return {
      query,
      searched_courses: [],
      confident: false,
      candidates: [],
      message:
        'No subject has an indexed Participant Handbook to search. Supply the handbook PDF ' +
        'and run ingest_course_documents, or call list_video_subjects to see what each ' +
        'subject is waiting for.',
    };
  }

  const candidates: UnitCandidate[] = [];
  for (const subject of usable) {
    const outline = getPhOutline(subject.course_id);
    for (const module of outline.modules) {
      for (const unit of module.units) {
        const found = new Set(headingTokens(`${unit.title} ${module.title}`));
        const matched = wanted.filter((t) => found.has(t));

        // Recall over the query and over the heading, combined. Either alone is
        // gameable: a one-word heading matches everything on the first, and a very
        // long query matches nothing on the second.
        const queryRecall = wanted.length === 0 ? 0 : matched.length / wanted.length;
        const headingRecall =
          found.size === 0 ? 0 : new Set(matched).size / Math.min(found.size, 8);
        const f =
          queryRecall + headingRecall === 0
            ? 0
            : (2 * queryRecall * headingRecall) / (queryRecall + headingRecall);

        const codeMatch = code !== undefined && unit.unit_code === code;
        // A stated unit code is an explicit instruction, not a hint, so it
        // dominates the lexical score without discarding it entirely.
        const score = codeMatch ? Math.min(1, 0.8 + f * 0.2) : f;
        if (score <= 0) continue;

        candidates.push({
          course_id: subject.course_id,
          subject_id: subject.subject_id,
          subject_code: subject.code,
          track: subject.track,
          unit,
          score: Number(score.toFixed(3)),
          matched_terms: [...new Set(matched)],
          matched_unit_code: codeMatch,
        });
      }
    }
  }

  candidates.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.unit.unit_code.localeCompare(b.unit.unit_code),
  );
  const top = candidates.slice(0, limit);
  const confident =
    top.length > 0 &&
    top[0]!.score >= 0.55 &&
    (top.length === 1 || top[0]!.score - top[1]!.score >= 0.15);

  return {
    query,
    searched_courses: usable.map((s) => s.course_id),
    confident,
    candidates: top,
    ...(top.length === 0
      ? {
          message:
            `No unit heading in the indexed handbooks shares a significant word with ` +
            `"${query}". Check the wording, or navigate with get_ph_outline instead.`,
        }
      : {}),
  };
}
