/**
 * The storyboard work order: one module at a time, everything it needs, once.
 *
 * This replaces a per-row task queue that handed out one field group per call.
 * That design was correct about *what* to write and badly wrong about the cost of
 * asking. A six-module course took 130 round trips, and a round trip to an MCP
 * client is not cheap: it re-sends the tool list, re-sends the whole conversation
 * so far, and buys one small answer. Measured on Green Hydrogen, those 130 calls
 * carried ~300K tokens of tool results and re-described the tool surface ~130
 * times, on top of conversation history that grows with every step. The work was
 * seconds; the asking was minutes.
 *
 * Worse, the queue retrieved source text per task, so the same chunk was sent
 * again for every row that happened to match it -- 774 chunk sends for 228
 * distinct chunks, one chunk repeated 24 times.
 *
 * A module is the right batch. It is the unit the template repeats, the unit the
 * crosswalk scopes, and the unit a writer can hold in mind at once: its rows all
 * draw on the same chapter, so sending that chapter once and writing every row
 * from it is both cheaper and more coherent than pulling six fresh chunks per row.
 * Six modules become six calls, and each chunk is sent exactly once.
 *
 * Nothing here writes content or invents a citation. It reports what is still
 * blank and attaches the material that may be cited for it.
 */

import { moduleScope } from '../courses/module-scope.js';
import { listChunksInScope } from '../documents/retriever.js';
import { config } from '../util/config.js';
import { isInsufficientSource } from '../types/source.js';
import type { StoryboardModule, StoryboardState } from '../types/storyboard.js';

/** One chunk a module may cite, as the client sees it. */
export interface BatchSource {
  chunk_id: string;
  document_type: string;
  doc_key?: string;
  pdf_page?: number;
  section?: string;
  /**
   * The unit this chunk belongs to, where the document attributes it to one.
   *
   * Reported because it tells the client which Part A row a chunk is material
   * for. Without it, matching forty chunks to nine rows is guesswork the server
   * has already done.
   */
  unit_code?: string;
  text: string;
}

export interface PartASlot {
  row_id: string;
  unit_code: string;
  unit_label: string;
  duration_label: string;
  /** Field names still blank on this row. */
  needs: string[];
}

export interface PartBSlot {
  row_id: string;
  time_range: string;
  needs: string[];
}

export interface LmsSlot {
  unit_range: string;
  /** Copied from that unit's Part A activity_name; supply the rest. */
  activity_type: string;
  needs: string[];
}

export interface PartCSlot {
  slide_id: string;
  number: number;
  title: string;
  needs: string[];
}

export interface ModuleWorkOrder {
  number: number;
  title: string;
  nos_code: string;
  duration_label: string;
  /** Set while the module's one-paragraph description is still blank. */
  needs_description: boolean;
  part_a: PartASlot[];
  /**
   * Rows the LMS table still needs, or an empty list when it is already built.
   *
   * Each row states its own unit_range and activity_type, because both are copies
   * of that unit's Part A values rather than anything to be written: the unit code
   * is fixed by the timing document, and the activity type has to match the Part A
   * activity_name exactly or the two tables describe different activities. Having
   * the client retype them cost output tokens and introduced a mismatch that
   * validation then had to catch.
   */
  lms_rows: LmsSlot[];
  part_b: PartBSlot[];
  part_c: PartCSlot[];
  questions_needed: number;
  /**
   * Glossary lines this module still owes.
   *
   * Gathered per module so each term is written from the sources that use it and
   * carries their citations. The rendered glossary merges every module's, dedupes
   * by term and sorts alphabetically.
   */
  glossary_terms_needed: number;
  /** Every chunk this module may cite, deduplicated, in document order. */
  sources: BatchSource[];
}

/**
 * How much source text one module carries.
 *
 * Sizing this by the chapter does not work: chapters run from 9 to 145 chunks, so
 * one budget either starves a long chapter or wastes tokens on a short one. Worse,
 * a chapter-wide listing truncated at a fixed limit drops the *end* of the
 * chapter, which is exactly the material the module's last units are written from.
 *
 * So the budget is per unit instead. Every Part A row is a unit, and the row is
 * written about that unit, so each unit contributes its own slice and no row can
 * end up with nothing to cite. Size then scales with how many units the module
 * has -- which is what the module actually needs -- rather than with how long its
 * chapter happens to be.
 */
const PER_UNIT_CHUNKS = config.search.moduleChunksPerUnit;

/** Facilitator-guide and un-unitised material, on top of the per-unit slices. */
const MODULE_LEVEL_CHUNKS = config.search.moduleContextChunks;

/**
 * Which document a module reads first.
 *
 * The Participant Handbook is the teaching content and the Facilitator Guide is
 * notes on delivering it, so the handbook comes first: it reads in the order a
 * person would read it, and the budget is spent on the handbook before the guide.
 */
const DOCUMENT_PRIORITY: Record<string, number> = { PH: 0, REF: 0, FG: 1, QP: 2 };

function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

function toBatchSource(c: {
  chunk_id: string;
  document_type: string;
  doc_key?: string | undefined;
  pdf_page?: number | undefined;
  section?: string | undefined;
  unit_code?: string | undefined;
  content: string;
}): BatchSource {
  return {
    chunk_id: c.chunk_id,
    document_type: c.document_type,
    ...(c.doc_key ? { doc_key: c.doc_key } : {}),
    ...(c.pdf_page !== undefined ? { pdf_page: c.pdf_page } : {}),
    ...(c.section ? { section: c.section } : {}),
    ...(c.unit_code ? { unit_code: c.unit_code } : {}),
    text: c.content,
  };
}

/**
 * The module's citable source material, retrieved once and deduplicated.
 *
 * Indexed scans in document order, not searches. Per-row searching was what
 * produced the duplication -- the same chunk returned for every row whose wording
 * happened to match it -- and it bought nothing, because the scope is the module's
 * own material either way.
 */
function sourcesFor(state: StoryboardState, module: StoryboardModule): BatchSource[] {
  const scope = moduleScope(state.course_id, module.number);
  const within = scope.kind === 'chapter' ? { chapters: scope.chapters } : { docKeys: scope.doc_keys };
  const picked = new Map<string, BatchSource>();

  // Each unit's own slice first, so every Part A row has material about the unit
  // it is written about however long the chapter is.
  const units = isInsufficientSource(module.part_a)
    ? []
    : module.part_a.rows.map((r) => r.unit_code);
  for (const unitCode of units) {
    const forUnit = listChunksInScope({
      courseId: state.course_id,
      ...within,
      unitCode,
      limit: PER_UNIT_CHUNKS,
    });
    for (const c of forUnit) if (!picked.has(c.chunk_id)) picked.set(c.chunk_id, toBatchSource(c));
  }

  // Then the module's wider context: its opening pages, and the Facilitator
  // Guide's notes, which carry no unit code but are what Part A activities and
  // Part C scripts are built from.
  const context = listChunksInScope({
    courseId: state.course_id,
    ...within,
    limit: config.search.maxScopeChunks,
  });
  context.sort(
    (a, b) =>
      (DOCUMENT_PRIORITY[a.document_type] ?? 9) - (DOCUMENT_PRIORITY[b.document_type] ?? 9) ||
      a.pdf_page - b.pdf_page ||
      a.chunk_id.localeCompare(b.chunk_id),
  );
  let added = 0;
  for (const c of context) {
    if (added >= MODULE_LEVEL_CHUNKS) break;
    if (picked.has(c.chunk_id)) continue;
    picked.set(c.chunk_id, toBatchSource(c));
    added += 1;
  }

  // Returned in document order, so the set reads as the chapter does.
  return [...picked.values()].sort(
    (a, b) =>
      (DOCUMENT_PRIORITY[a.document_type] ?? 9) - (DOCUMENT_PRIORITY[b.document_type] ?? 9) ||
      (a.pdf_page ?? 0) - (b.pdf_page ?? 0) ||
      a.chunk_id.localeCompare(b.chunk_id),
  );
}

/** What one module still needs written, without its sources. */
function outstanding(state: StoryboardState, module: StoryboardModule): Omit<ModuleWorkOrder, 'sources'> {
  const partA: PartASlot[] = [];
  if (!isInsufficientSource(module.part_a)) {
    for (const row of module.part_a.rows) {
      const needs: string[] = [];
      if (blank(row.activity_name)) needs.push('activity_name');
      if (blank(row.interactive_description)) needs.push('interactive_description');
      if (blank(row.correlation)) needs.push('correlation');
      if (needs.length > 0) {
        partA.push({
          row_id: row.row_id,
          unit_code: row.unit_code,
          unit_label: row.unit_label,
          duration_label: row.duration.label,
          needs,
        });
      }
    }
  }

  const partB: PartBSlot[] = [];
  if (!isInsufficientSource(module.part_b)) {
    for (const row of module.part_b.rows) {
      const needs: string[] = [];
      if (blank(row.visual)) needs.push('visual');
      if (blank(row.audio)) needs.push('audio');
      if (needs.length > 0) partB.push({ row_id: row.row_id, time_range: row.time_range, needs });
    }
  }

  const partC: PartCSlot[] = [];
  if (!isInsufficientSource(module.part_c)) {
    for (const slide of module.part_c.slides) {
      const needs: string[] = [];
      if (blank(slide.visual_cues)) needs.push('visual_cues');
      if (blank(slide.instructor_script)) needs.push('instructor_script');
      if (needs.length > 0) {
        partC.push({ slide_id: slide.slide_id, number: slide.number, title: slide.title, needs });
      }
    }
  }

  // The LMS table is built rather than filled: how many rows it needs is one per
  // Part A activity, which is a property of the module, not a client decision.
  // Its unit_range and activity_type come from that Part A row, so they are stated
  // here rather than asked for.
  let lmsRows: LmsSlot[] = [];
  if (!isInsufficientSource(module.lms_mapping) && !isInsufficientSource(module.part_a)) {
    const incomplete = module.lms_mapping.rows.some(
      (r) => blank(r.tracking) || blank(r.completion_criteria),
    );
    if (module.lms_mapping.rows.length === 0 || incomplete) {
      lmsRows = module.part_a.rows.map((r) => ({
        unit_range: r.unit_code,
        activity_type: r.activity_name,
        needs: ['recommended_standard', 'tracking', 'completion_criteria'],
      }));
    }
  }

  const existingQuestions =
    state.assessment && !isInsufficientSource(state.assessment)
      ? state.assessment.questions.filter((q) => q.module_number === module.number).length
      : 0;

  const existingTerms = (state.glossary ?? []).filter(
    (g) => g.module_number === module.number,
  ).length;

  return {
    number: module.number,
    title: module.title,
    nos_code: module.nos_code,
    duration_label: module.duration_label,
    needs_description: blank(module.description),
    part_a: partA,
    lms_rows: lmsRows,
    part_b: partB,
    part_c: partC,
    questions_needed: Math.max(0, config.assessment.questionsPerModule - existingQuestions),
    glossary_terms_needed: Math.max(0, config.assessment.glossaryTermsPerModule - existingTerms),
  };
}

/** True when a work order has nothing left to write. */
export function isComplete(order: Omit<ModuleWorkOrder, 'sources'>): boolean {
  return (
    !order.needs_description &&
    order.part_a.length === 0 &&
    order.lms_rows.length === 0 &&
    order.part_b.length === 0 &&
    order.part_c.length === 0 &&
    order.questions_needed === 0 &&
    order.glossary_terms_needed === 0
  );
}

/** Modules that are work, in order. A module the sources cannot support is not. */
export function buildableModules(state: StoryboardState): StoryboardModule[] {
  return [...state.modules]
    .sort((a, b) => a.number - b.number)
    .filter((m) => !isInsufficientSource(m.part_a));
}

export interface Progress {
  modules_done: number;
  modules_total: number;
  fields_remaining: number;
  percent_complete: number;
}

export interface NextModule {
  order?: ModuleWorkOrder;
  progress: Progress;
  complete: boolean;
}

/**
 * The next module to write, with its sources attached.
 *
 * A module that was only partly written -- because a reply was truncated, or a
 * submission was corrected -- comes back with just the slots still blank, so the
 * loop converges instead of restarting the module. That is why every slot carries
 * its own `needs` list rather than the module carrying a single "done" flag.
 */
export function nextModule(state: StoryboardState): NextModule {
  const modules = buildableModules(state);
  const orders = modules.map((m) => outstanding(state, m));
  const remaining = orders.filter((o) => !isComplete(o));

  const fieldsRemaining = remaining.reduce(
    (total, o) =>
      total +
      (o.needs_description ? 1 : 0) +
      o.part_a.reduce((a, s) => a + s.needs.length, 0) +
      o.lms_rows.length +
      o.part_b.reduce((a, s) => a + s.needs.length, 0) +
      o.part_c.reduce((a, s) => a + s.needs.length, 0) +
      o.questions_needed +
      o.glossary_terms_needed,
    0,
  );

  const done = orders.length - remaining.length;
  const progress: Progress = {
    modules_done: done,
    modules_total: orders.length,
    fields_remaining: fieldsRemaining,
    percent_complete: orders.length === 0 ? 100 : Math.round((done / orders.length) * 100),
  };

  const head = remaining[0];
  if (!head) return { progress: { ...progress, percent_complete: 100 }, complete: true };

  return {
    order: { ...head, sources: sourcesFor(state, modules[orders.indexOf(head)]!) },
    progress,
    complete: false,
  };
}
