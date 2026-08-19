/**
 * The storyboard work queue.
 *
 * A storyboard is roughly 240 fields across eight modules. Building one used to
 * require the client to work out, unaided, the module order, which row_ids exist,
 * which fields each row needs, what to search for, which chunk_id to cite so the
 * crosswalk is satisfied, and when the whole thing was finished. That is a lot of
 * orchestration to expect of a model, and the stronger the model the better it
 * went -- which is exactly the wrong property for a deterministic tool layer to
 * have. A weaker client did not produce a worse storyboard, it produced a
 * one-module storyboard, or a summary of its plan.
 *
 * So the sequencing lives here instead. This module turns the state into an
 * ordered queue of small tasks, hands out one at a time with its source material
 * already retrieved and its fields already enumerated, and knows when the queue is
 * empty. What is left for the client is the one thing a tool layer cannot do:
 * write the words.
 *
 * Nothing here writes content or invents a citation. It selects, scopes and
 * orders; the chunks it attaches are the same chunks search_course_content would
 * return, retrieved with the module's crosswalk already applied so a wrong-chapter
 * citation is not reachable by following the task.
 */

import { getCrosswalkEntry } from '../courses/course-config.js';
import { moduleScope } from '../courses/module-scope.js';
import { listChunksInScope, searchCourseContent } from '../documents/retriever.js';
import { config } from '../util/config.js';
import { isInsufficientSource } from '../types/source.js';
import type { SourceRef } from '../types/source.js';
import type { StoryboardModule, StoryboardState } from '../types/storyboard.js';

export type TaskSection = 'part_a' | 'lms_mapping' | 'part_b' | 'part_c' | 'assessment';

export interface TaskField {
  /** Identifies the field on submission; opaque to the client. */
  field_id: string;
  label: string;
  /** What this field must contain, in one sentence. */
  guidance: string;
  requires_citation: boolean;
  /** Present when the field already holds content, i.e. this is a rewrite. */
  current?: string;
}

export interface TaskSource {
  chunk_id: string;
  document_type: string;
  /** Which reference document, for a course routed per document. */
  doc_key?: string;
  pdf_page?: number;
  section?: string;
  text: string;
}

export interface StoryboardTask {
  task_id: string;
  module: number;
  module_title: string;
  section: TaskSection;
  /** Human-readable heading for this task, e.g. "Module 1, Part A, Unit 1.1". */
  title: string;
  instructions: string;
  fields: TaskField[];
  /**
   * For a task that creates rows rather than filling them: the rows to create,
   * already derived from what the module contains. The client supplies the words
   * for each; it does not decide how many there are.
   */
  expected_rows?: { unit_range: string; activity_type: string; unit_label: string }[];
  /** Handbook and guide text for this module, already scoped by the crosswalk. */
  sources: TaskSource[];
}

export interface TaskProgress {
  tasks_done: number;
  tasks_total: number;
  fields_remaining: number;
  percent_complete: number;
}

const SECTION_ORDER: TaskSection[] = ['part_a', 'lms_mapping', 'part_b', 'part_c', 'assessment'];

const SECTION_INSTRUCTIONS: Record<TaskSection, string> = {
  part_a:
    'Name the interactive eLMS activity for this unit and describe what the learner actually does ' +
    'in it. The description is educational content: it must come from the source text below and ' +
    'cite it.',
  lms_mapping:
    'State the tracking data an LMS records for this activity, and the criterion that marks it ' +
    'complete. Keep the activity_type wording identical to the Part A activity it maps to.',
  part_b:
    'Write this three-minute segment of the video production script: what is on screen, and what ' +
    'the presenter says. The audio is educational content and must cite the source text.',
  part_c:
    'Write this slide of the live instructor-led session: the visual cues on the slide, and the ' +
    'script the instructor delivers from it. The script must cite the source text.',
  assessment:
    'Write the module\'s question bank. Each question needs a stem, four options, the correct ' +
    'option, an explanation, and citations supporting the stem, the correct answer and the ' +
    'explanation. The three wrong options are authored, not sourced, and must not assert any ' +
    'fact the sources do not state.',
};

/** How much source text a task carries. Enough to write from, small enough to read. */
const SOURCE_CHUNKS_PER_TASK = 6;

function blank(text: string | undefined): boolean {
  return typeof text !== 'string' || text.trim() === '';
}

/**
 * The fields of one module that still need writing, grouped into tasks.
 *
 * A task is one row, one slide, or one module's question bank -- small enough
 * that a client writes it in a single response without truncating, and large
 * enough that the queue does not run to hundreds of entries.
 */
function moduleTasks(module: StoryboardModule, questionsPerModule: number): Omit<StoryboardTask, 'sources'>[] {
  const tasks: Omit<StoryboardTask, 'sources'>[] = [];
  const head = `Module ${module.number} - ${module.title}`;

  if (!isInsufficientSource(module.part_a)) {
    for (const row of module.part_a.rows) {
      const fields: TaskField[] = [];
      if (blank(row.activity_name)) {
        fields.push({
          field_id: `part_a:${row.row_id}:activity_name`,
          label: 'activity_name',
          guidance:
            'The name of the interactive activity, e.g. "Guided Simulation" or "Scenario Walkthrough". ' +
            'A short noun phrase, not a sentence.',
          requires_citation: false,
        });
      }
      if (blank(row.interactive_description)) {
        fields.push({
          field_id: `part_a:${row.row_id}:interactive_description`,
          label: 'interactive_description',
          guidance:
            'What the learner does in the activity and what it teaches, in two or three sentences, ' +
            'drawn from the source text.',
          requires_citation: true,
        });
      }
      if (blank(row.correlation)) {
        fields.push({
          field_id: `part_a:${row.row_id}:correlation`,
          label: 'correlation',
          guidance:
            `The NOS code and performance criteria this unit assesses, e.g. "${module.nos_code} / PC1, PC3".`,
          requires_citation: false,
        });
      }
      if (fields.length > 0) {
        tasks.push({
          task_id: `${module.number}:part_a:${row.row_id}`,
          module: module.number,
          module_title: module.title,
          section: 'part_a',
          title: `${head} / Part A / ${row.unit_label}`,
          instructions: SECTION_INSTRUCTIONS.part_a,
          fields,
        });
      }
    }
  }

  if (!isInsufficientSource(module.lms_mapping)) {
    // The skeleton leaves this table empty, because how many rows it needs is a
    // content decision: one per Part A activity. So this task creates the rows
    // rather than filling them, and it is one task for the whole module.
    const partARows = isInsufficientSource(module.part_a) ? [] : module.part_a.rows;
    const incomplete = module.lms_mapping.rows.filter(
      (r) => blank(r.tracking) || blank(r.completion_criteria),
    );
    if (module.lms_mapping.rows.length === 0 || incomplete.length > 0) {
      tasks.push({
        task_id: `${module.number}:lms_mapping:rows`,
        module: module.number,
        module_title: module.title,
        section: 'lms_mapping',
        title: `${head} / LMS Technical Mapping`,
        instructions: SECTION_INSTRUCTIONS.lms_mapping,
        fields: [
          {
            field_id: `lms_mapping:${module.number}:rows`,
            label: 'lms_rows',
            guidance:
              `One row per Part A activity in this module -- ${partARows.length} rows. Each needs ` +
              'unit_range, activity_type copied verbatim from that unit\'s Part A activity_name, ' +
              'recommended_standard, tracking and completion_criteria.',
            requires_citation: true,
          },
        ],
        expected_rows: partARows.map((r) => ({
          unit_range: r.unit_code,
          activity_type: r.activity_name,
          unit_label: r.unit_label,
        })),
      });
    }
  }

  if (!isInsufficientSource(module.part_b)) {
    for (const row of module.part_b.rows) {
      const fields: TaskField[] = [];
      if (blank(row.visual)) {
        fields.push({
          field_id: `part_b:${row.row_id}:visual`,
          label: 'visual',
          guidance: 'What is on screen during this segment: shots, demonstrations, on-screen graphics.',
          requires_citation: false,
        });
      }
      if (blank(row.audio)) {
        fields.push({
          field_id: `part_b:${row.row_id}:audio`,
          label: 'audio',
          guidance:
            'The spoken track, attributed to a speaker, e.g. \'Host (On-Camera): "..."\'. This is ' +
            'educational content and must come from the source text.',
          requires_citation: true,
        });
      }
      if (fields.length > 0) {
        tasks.push({
          task_id: `${module.number}:part_b:${row.row_id}`,
          module: module.number,
          module_title: module.title,
          section: 'part_b',
          title: `${head} / Part B / ${row.time_range}`,
          instructions: SECTION_INSTRUCTIONS.part_b,
          fields,
        });
      }
    }
  }

  if (!isInsufficientSource(module.part_c)) {
    for (const slide of module.part_c.slides) {
      const fields: TaskField[] = [];
      if (blank(slide.visual_cues)) {
        fields.push({
          field_id: `part_c:${slide.slide_id}:visual_cues`,
          label: 'visual_cues',
          guidance: 'What appears on the slide: headings, bullets, diagrams, poll options.',
          requires_citation: false,
        });
      }
      if (blank(slide.instructor_script)) {
        fields.push({
          field_id: `part_c:${slide.slide_id}:instructor_script`,
          label: 'instructor_script',
          guidance: 'What the instructor says while this slide is up, drawn from the source text.',
          requires_citation: true,
        });
      }
      if (fields.length > 0) {
        tasks.push({
          task_id: `${module.number}:part_c:${slide.slide_id}`,
          module: module.number,
          module_title: module.title,
          section: 'part_c',
          title: `${head} / Part C / slide ${slide.number}: ${slide.title}`,
          instructions: SECTION_INSTRUCTIONS.part_c,
          fields,
        });
      }
    }
  }

  return tasks.sort(
    (a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section),
  );
}

/** The assessment task for a module, when its question bank is short. */
function assessmentTask(
  state: StoryboardState,
  module: StoryboardModule,
  questionsPerModule: number,
): Omit<StoryboardTask, 'sources'> | undefined {
  const blueprint = state.assessment;
  const existing =
    blueprint && !isInsufficientSource(blueprint)
      ? blueprint.questions.filter((q) => q.module_number === module.number)
      : [];
  if (existing.length >= questionsPerModule) return undefined;
  return {
    task_id: `${module.number}:assessment`,
    module: module.number,
    module_title: module.title,
    section: 'assessment',
    title: `Module ${module.number} - ${module.title} / assessment question bank`,
    instructions: SECTION_INSTRUCTIONS.assessment,
    fields: [
      {
        field_id: `assessment:${module.number}:questions`,
        label: 'questions',
        guidance:
          `${questionsPerModule - existing.length} multiple-choice questions covering this ` +
          'module, each with stem, options a-d, correct_option, explanation and sources.',
        requires_citation: true,
      },
    ],
  };
}

/**
 * Retrieves the module's source material for a task.
 *
 * Scoped by module_number so the crosswalk is applied here rather than trusted to
 * the client: every chunk offered to a task is one the module is allowed to cite,
 * which is what makes wrong_chapter_citation unreachable by following the queue.
 */
function sourcesFor(state: StoryboardState, module: StoryboardModule, query: string): TaskSource[] {
  // The scope is applied here rather than left to the client, which is what
  // makes an out-of-scope citation unreachable by following the queue -- whether
  // the scope is a handbook chapter or a CDR module's own reference documents.
  const scope = moduleScope(state.course_id, module.number);
  const within = scope.kind === 'chapter' ? { chapter: scope.chapter } : { docKeys: scope.doc_keys };

  // Search first, because the task's own subject matter is what makes its sources
  // the useful ones. But a query can legitimately match nothing -- "LMS Technical
  // Mapping" is a template term, not a phrase any handbook uses -- and a task with
  // no text is one the client cannot answer. So an empty result falls back to the
  // module's material in document order, which is always in scope and always
  // non-empty for an indexed module.
  const hits = searchCourseContent({
    courseId: state.course_id,
    query,
    ...within,
    limit: SOURCE_CHUNKS_PER_TASK,
  });
  const sources =
    hits.length > 0
      ? hits
      : listChunksInScope({ courseId: state.course_id, ...within, limit: SOURCE_CHUNKS_PER_TASK });

  return sources.map((h) => ({
    chunk_id: h.chunk_id,
    document_type: h.document_type,
    ...(h.doc_key ? { doc_key: h.doc_key } : {}),
    ...(h.pdf_page !== undefined ? { pdf_page: h.pdf_page } : {}),
    ...(h.section ? { section: h.section } : {}),
    text: h.content,
  }));
}

/** Every outstanding task, in the order they must be done. */
export function pendingTasks(state: StoryboardState): Omit<StoryboardTask, 'sources'>[] {
  const questionsPerModule = config.assessment.questionsPerModule;
  const out: Omit<StoryboardTask, 'sources'>[] = [];
  for (const module of [...state.modules].sort((a, b) => a.number - b.number)) {
    // A module the sources cannot support is not work; it renders as
    // INSUFFICIENT_SOURCE_CONTENT and must not be written into.
    if (isInsufficientSource(module.part_a)) continue;
    out.push(...moduleTasks(module, questionsPerModule));
    const assessment = assessmentTask(state, module, questionsPerModule);
    if (assessment) out.push(assessment);
  }
  return out;
}

/** Total tasks in a fresh storyboard, so progress has a denominator. */
export function totalTasks(state: StoryboardState): number {
  const questionsPerModule = config.assessment.questionsPerModule;
  let total = 0;
  for (const module of state.modules) {
    if (isInsufficientSource(module.part_a)) continue;
    if (!isInsufficientSource(module.part_a)) total += module.part_a.rows.length;
    if (!isInsufficientSource(module.lms_mapping)) total += 1;
    if (!isInsufficientSource(module.part_b)) total += module.part_b.rows.length;
    if (!isInsufficientSource(module.part_c)) total += module.part_c.slides.length;
    total += 1; // the question bank
  }
  return total || 1;
}

export interface NextTask {
  task?: StoryboardTask;
  progress: TaskProgress;
  complete: boolean;
}

/**
 * The next task to do, with its sources attached.
 *
 * Returns `complete` when the queue is empty, which is the only signal a client
 * needs in order to know it may render.
 */
export function nextTask(state: StoryboardState): NextTask {
  const pending = pendingTasks(state);
  const total = totalTasks(state);
  const done = Math.max(0, total - pending.length);
  const progress: TaskProgress = {
    tasks_done: done,
    tasks_total: total,
    fields_remaining: pending.reduce((a, t) => a + t.fields.length, 0),
    percent_complete: Math.round((done / total) * 100),
  };

  const head = pending[0];
  if (!head) return { progress: { ...progress, percent_complete: 100 }, complete: true };

  const module = state.modules.find((m) => m.number === head.module)!;
  // The query is the task's own subject matter, so the chunks that come back are
  // the ones that unit or slide is about rather than the module's opening pages.
  const query = `${module.title} ${head.title.split('/').pop() ?? ''}`.trim();
  return {
    task: { ...head, sources: sourcesFor(state, module, query) },
    progress,
    complete: false,
  };
}

/** Parses a field_id back into the target set_storyboard_content understands. */
export interface ParsedField {
  section: TaskSection;
  row_id: string;
  field: string;
}

export function parseFieldId(fieldId: string): ParsedField {
  const [section, rowId, field] = fieldId.split(':');
  if (!section || !rowId || !field) {
    throw new Error(`Malformed field_id "${fieldId}". Expected "<section>:<row_id>:<field>".`);
  }
  return { section: section as TaskSection, row_id: rowId, field };
}

/** The citation every task field carries by default: the chunks it was given. */
export function defaultSources(sources: readonly TaskSource[]): SourceRef[] {
  return sources.slice(0, 2).map((s) => ({ chunk_id: s.chunk_id }) as SourceRef);
}

export function crosswalkChapter(state: StoryboardState, moduleNumber: number): number {
  return getCrosswalkEntry(state.course_id, moduleNumber).source_chapter;
}
