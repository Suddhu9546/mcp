/**
 * Three-level validation, entirely mechanical.
 *
 *   Level 1  Traceability and grounding -- does every content field carry a
 *            citation that resolves to a real chunk, in the right course and the
 *            right chapter, whose wording it measurably overlaps?
 *   Level 2  Timing -- does the arithmetic close against the timing document?
 *   Level 3  Structure -- does the state match the shapes the template requires?
 *
 * Level 1 deliberately does not attempt to judge meaning. Deciding whether a
 * sentence is a fair paraphrase of a source is a reasoning task and belongs to the
 * client. What this layer can do without a model, it does exactly: resolve every
 * citation, confirm its scope, and measure lexical overlap. It reports findings
 * with enough detail for the client to act on, and never edits anything itself.
 */

import type { InsufficientSource } from '../types/source.js';
import { isInsufficientSource } from '../types/source.js';
import type { StoryboardState, StoryboardModule } from '../types/storyboard.js';
import type { TimingAllocation } from '../types/timing.js';
import { getCrosswalkEntry } from '../courses/course-config.js';
import { describeScope, moduleScope, scopeAllows } from '../courses/module-scope.js';
import { getChunk } from '../documents/retriever.js';
import { validateTimingArithmetic } from '../timing/timing-validator.js';
import { PART_B_SEGMENTS, PART_C_SLIDES } from './skeleton.js';
import { config } from '../util/config.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  /** Stable machine-readable code, e.g. "missing_citation". */
  code: string;
  /** Dotted path into the state, e.g. "modules[1].part_a.rows[m01-a-1.1].interactive_description". */
  path: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface ValidationReport {
  artifact_id: string;
  course_id: string;
  version: number;
  passed: boolean;
  levels: {
    content: { passed: boolean; findings: Finding[] };
    timing: { passed: boolean; findings: Finding[] };
    structure: { passed: boolean; findings: Finding[] };
  };
  summary: { errors: number; warnings: number; infos: number };
  /** Modules deliberately empty because the sources cannot support them. */
  insufficient_source_modules: number[];
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'of', 'in', 'to', 'a', 'an', 'with', 'on', 'at', 'by', 'from', 'that',
  'this', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'as', 'it', 'its', 'or',
  'their', 'they', 'you', 'your', 'will', 'can', 'should', 'must', 'which', 'what', 'how',
]);

function contentTokens(text: string, minLength: number): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= minLength && !STOP_WORDS.has(t));
}

/**
 * Share of a field's distinctive words that also occur in its cited chunks.
 *
 * A crude but honest signal: high overlap does not prove the content is a fair
 * summary, but near-zero overlap on a substantial field means the citation almost
 * certainly does not support it. Reported as a number so the client can weigh it.
 */
export function groundingOverlap(content: string, citedText: string): number {
  const minLength = config.grounding.minTokenLength;
  const tokens = new Set(contentTokens(content, minLength));
  if (tokens.size === 0) return 1;
  const source = new Set(contentTokens(citedText, minLength));
  let hits = 0;
  for (const t of tokens) if (source.has(t)) hits += 1;
  return hits / tokens.size;
}

/** Every content-bearing leaf of a module, as (path, text, sources) triples. */
function* moduleFields(module: StoryboardModule): Generator<{
  path: string;
  text: string;
  sources: { chunk_id: string; document_type: string }[];
  /** Fields the template renders as static or structural text need no citation. */
  requiresCitation: boolean;
}> {
  const base = `modules[${module.number}]`;

  if (typeof module.description === 'string' && module.description.trim() !== '') {
    yield {
      path: `${base}.description`,
      text: module.description,
      sources: module.description_sources ?? [],
      requiresCitation: true,
    };
  }

  if (!isInsufficientSource(module.part_a)) {
    for (const row of module.part_a.rows) {
      const rowBase = `${base}.part_a.rows[${row.row_id}]`;
      yield {
        path: `${rowBase}.interactive_description`,
        text: row.interactive_description,
        sources: row.sources,
        requiresCitation: true,
      };
      yield { path: `${rowBase}.activity_name`, text: row.activity_name, sources: row.sources, requiresCitation: false };
      yield { path: `${rowBase}.correlation`, text: row.correlation, sources: row.sources, requiresCitation: false };
    }
  }

  if (!isInsufficientSource(module.lms_mapping)) {
    for (const row of module.lms_mapping.rows) {
      const rowBase = `${base}.lms_mapping.rows[${row.row_id}]`;
      yield { path: `${rowBase}.tracking`, text: row.tracking, sources: row.sources, requiresCitation: false };
      yield {
        path: `${rowBase}.completion_criteria`,
        text: row.completion_criteria,
        sources: row.sources,
        requiresCitation: true,
      };
    }
  }

  if (!isInsufficientSource(module.part_b)) {
    for (const row of module.part_b.rows) {
      const rowBase = `${base}.part_b.rows[${row.row_id}]`;
      yield { path: `${rowBase}.visual`, text: row.visual, sources: row.sources, requiresCitation: false };
      yield { path: `${rowBase}.audio`, text: row.audio, sources: row.sources, requiresCitation: true };
    }
  }

  if (!isInsufficientSource(module.part_c)) {
    for (const slide of module.part_c.slides) {
      const slideBase = `${base}.part_c.slides[${slide.slide_id}]`;
      yield { path: `${slideBase}.visual_cues`, text: slide.visual_cues, sources: slide.sources, requiresCitation: false };
      yield {
        path: `${slideBase}.instructor_script`,
        text: slide.instructor_script,
        sources: slide.sources,
        requiresCitation: true,
      };
    }
  }
}

function validateContent(state: StoryboardState): Finding[] {
  const findings: Finding[] = [];
  const minOverlap = config.grounding.minOverlap;

  for (const module of state.modules) {
    const scope = moduleScope(state.course_id, module.number);

    for (const field of moduleFields(module)) {
      if (field.text.trim() === '') {
        findings.push({
          severity: 'error',
          code: 'empty_field',
          path: field.path,
          message: 'Field is empty. Populate it via set_storyboard_content before rendering.',
        });
        continue;
      }

      if (!field.requiresCitation) continue;

      if (field.sources.length === 0) {
        findings.push({
          severity: 'error',
          code: 'missing_citation',
          path: field.path,
          message:
            'Generated content carries no source reference. Every educational statement must ' +
            'cite the approved document it came from.',
        });
        continue;
      }

      const citedTexts: string[] = [];
      for (const ref of field.sources) {
        const chunk = getChunk(state.course_id, ref.chunk_id);
        if (!chunk) {
          findings.push({
            severity: 'error',
            code: 'unresolvable_citation',
            path: field.path,
            message:
              `Citation references chunk "${ref.chunk_id}", which does not exist in course ` +
              `"${state.course_id}". Re-run search_course_content and cite a returned chunk_id.`,
            actual: ref.chunk_id,
          });
          continue;
        }

        // Scoping exists precisely to stop this: a module citing the wrong
        // chapter -- or, for a CDR course, the wrong reference document -- looks
        // correct on the page but is about the wrong subject.
        if (!scopeAllows(scope, chunk)) {
          findings.push({
            severity: 'error',
            code: scope.kind === 'chapter' ? 'wrong_chapter_citation' : 'wrong_document_citation',
            path: field.path,
            message:
              `Module ${module.number} must draw from ${describeScope(scope)}, but this citation ` +
              `resolves to ${
                scope.kind === 'chapter'
                  ? `chapter ${chunk.chapter}`
                  : `document "${chunk.doc_key ?? '(none)'}"`
              }.`,
            expected: describeScope(scope),
            actual:
              scope.kind === 'chapter' ? `chapter ${chunk.chapter}` : (chunk.doc_key ?? '(none)'),
          });
          continue;
        }

        citedTexts.push(chunk.content);
      }

      if (citedTexts.length === 0 || minOverlap <= 0) continue;

      const overlap = groundingOverlap(field.text, citedTexts.join('\n'));
      if (overlap < minOverlap) {
        findings.push({
          severity: 'warning',
          code: 'low_grounding_overlap',
          path: field.path,
          message:
            `Only ${(overlap * 100).toFixed(0)}% of this field's distinctive words appear in the ` +
            `chunks it cites (threshold ${(minOverlap * 100).toFixed(0)}%). Either cite the chunk ` +
            'that actually supports the wording, or bring the wording closer to the source. ' +
            'This is a lexical measure only, not a judgement about meaning.',
          expected: `>= ${minOverlap.toFixed(2)}`,
          actual: overlap.toFixed(2),
        });
      }
    }
  }

  return findings;
}

/**
 * Question-bank checks.
 *
 * Under the approved policy the stem, correct answer and explanation must each be
 * source-supported, while the three incorrect options are authored -- a source
 * document contains no answer key. So citations are required on the question, and
 * `distractors_authored` must be set so the audit can prove the exception was
 * taken knowingly rather than by accident.
 */
function validateQuestions(state: StoryboardState): Finding[] {
  const findings: Finding[] = [];
  if (isInsufficientSource(state.assessment)) return findings;

  const assessment = state.assessment;
  const expected = config.assessment.questionsPerModule;
  const seenNumbers = new Map<number, string>();

  // Modules that carry content are the ones expected to carry questions.
  const contentModules = state.modules.filter((m) => !isInsufficientSource(m.part_a));

  for (const module of contentModules) {
    const questions = assessment.questions.filter((q) => q.module_number === module.number);
    if (questions.length !== expected) {
      findings.push({
        severity: questions.length === 0 ? 'error' : 'warning',
        code: 'question_count',
        path: `assessment.questions[module=${module.number}]`,
        message:
          `Module ${module.number} has ${questions.length} question(s); the template's bank uses ` +
          `${expected} per module.`,
        expected: String(expected),
        actual: String(questions.length),
      });
    }
  }

  const validModules = new Set(contentModules.map((m) => m.number));

  for (const q of assessment.questions) {
    const path = `assessment.questions[${q.question_id}]`;

    if (!validModules.has(q.module_number)) {
      findings.push({
        severity: 'error',
        code: 'question_unknown_module',
        path,
        message:
          `Question ${q.number} is filed under module ${q.module_number}, which is not a module ` +
          'of this storyboard with usable source content.',
        actual: String(q.module_number),
      });
    }

    const duplicate = seenNumbers.get(q.number);
    if (duplicate) {
      findings.push({
        severity: 'error',
        code: 'duplicate_question_number',
        path,
        message: `Question number ${q.number} is used by both ${duplicate} and ${q.question_id}.`,
      });
    } else {
      seenNumbers.set(q.number, q.question_id);
    }

    if (q.stem.trim() === '') {
      findings.push({ severity: 'error', code: 'empty_field', path: `${path}.stem`, message: 'Question stem is empty.' });
    }

    for (const key of ['a', 'b', 'c', 'd'] as const) {
      if ((q.options?.[key] ?? '').trim() === '') {
        findings.push({
          severity: 'error',
          code: 'empty_option',
          path: `${path}.options.${key}`,
          message: `Option ${key} is empty. All four options are required.`,
        });
      }
    }

    // Identical options make the question unanswerable even though every field is
    // populated, so an emptiness check alone would not catch it.
    const optionValues = (['a', 'b', 'c', 'd'] as const).map((k) => (q.options?.[k] ?? '').trim().toLowerCase());
    const uniqueOptions = new Set(optionValues.filter((v) => v !== ''));
    if (uniqueOptions.size !== optionValues.filter((v) => v !== '').length) {
      findings.push({
        severity: 'error',
        code: 'duplicate_option',
        path: `${path}.options`,
        message: 'Two or more options are identical, so the question has no single correct answer.',
      });
    }

    if (!['a', 'b', 'c', 'd'].includes(q.correct_option)) {
      findings.push({
        severity: 'error',
        code: 'invalid_correct_option',
        path: `${path}.correct_option`,
        message: `correct_option must be one of a, b, c, d; got "${q.correct_option}".`,
        actual: String(q.correct_option),
      });
    }

    if (q.explanation.trim() === '') {
      findings.push({
        severity: 'error',
        code: 'empty_field',
        path: `${path}.explanation`,
        message: 'Explanation is empty. It must state what in the source supports the correct answer.',
      });
    }

    if (q.distractors_authored !== true) {
      findings.push({
        severity: 'warning',
        code: 'distractors_not_declared',
        path: `${path}.distractors_authored`,
        message:
          'distractors_authored is not set. The three incorrect options are necessarily authored ' +
          'rather than sourced, and the document discloses this, so the flag should be true.',
      });
    }

    if (!q.sources || q.sources.length === 0) {
      findings.push({
        severity: 'error',
        code: 'missing_citation',
        path,
        message:
          'Question carries no source reference. The stem, correct answer and explanation must ' +
          'each be supported by an approved document.',
      });
      continue;
    }

    const scope = validModules.has(q.module_number)
      ? moduleScope(state.course_id, q.module_number)
      : undefined;
    const citedTexts: string[] = [];

    for (const sourceRef of q.sources) {
      const chunk = getChunk(state.course_id, sourceRef.chunk_id);
      if (!chunk) {
        findings.push({
          severity: 'error',
          code: 'unresolvable_citation',
          path,
          message: `Citation references chunk "${sourceRef.chunk_id}", which does not exist in this course.`,
          actual: sourceRef.chunk_id,
        });
        continue;
      }
      if (scope && !scopeAllows(scope, chunk)) {
        findings.push({
          severity: 'error',
          code: scope.kind === 'chapter' ? 'wrong_chapter_citation' : 'wrong_document_citation',
          path,
          message:
            `Question is filed under module ${q.module_number}, which draws from ` +
            `${describeScope(scope)}, but this citation resolves to ${
              scope.kind === 'chapter'
                ? `chapter ${chunk.chapter}`
                : `document "${chunk.doc_key ?? '(none)'}"`
            }.`,
          expected: describeScope(scope),
          actual: scope.kind === 'chapter' ? `chapter ${chunk.chapter}` : (chunk.doc_key ?? '(none)'),
        });
        continue;
      }
      citedTexts.push(chunk.content);
    }

    if (citedTexts.length === 0 || config.grounding.minOverlap <= 0) continue;

    // Overlap is measured on stem plus explanation only. The distractors are
    // authored by policy, so including them would depress the score for content
    // that is behaving exactly as intended.
    const overlap = groundingOverlap(
      `${q.stem} ${q.options[q.correct_option] ?? ''} ${q.explanation}`,
      citedTexts.join('\n'),
    );
    if (overlap < config.grounding.minOverlap) {
      findings.push({
        severity: 'warning',
        code: 'low_grounding_overlap',
        path: `${path}.explanation`,
        message:
          `Only ${(overlap * 100).toFixed(0)}% of this question's stem, correct answer and ` +
          `explanation appear in the chunks it cites (threshold ` +
          `${(config.grounding.minOverlap * 100).toFixed(0)}%). Cite the chunk that actually ` +
          'carries the fact being tested.',
        expected: `>= ${config.grounding.minOverlap.toFixed(2)}`,
        actual: overlap.toFixed(2),
      });
    }
  }

  return findings;
}

function validateTiming(state: StoryboardState, allocation: TimingAllocation): Finding[] {
  const findings: Finding[] = [];

  for (const d of validateTimingArithmetic(allocation).discrepancies) {
    findings.push({
      severity: 'error',
      code: 'timing_document_inconsistent',
      path: d.module !== undefined ? `timing.modules[${d.module}]` : 'timing.course',
      message: d.message,
      expected: String(d.stated),
      actual: String(d.computed),
    });
  }

  for (const module of state.modules) {
    const timingModule = allocation.modules.find((m) => m.number === module.number);
    if (!timingModule) {
      findings.push({
        severity: 'error',
        code: 'module_not_in_timing_document',
        path: `modules[${module.number}]`,
        message:
          `Module ${module.number} is present in the storyboard but not in the Timing ` +
          'Allocation Document, so its duration has no authoritative source.',
      });
      continue;
    }

    if (module.duration.minutes !== timingModule.minutes) {
      findings.push({
        severity: 'error',
        code: 'module_duration_mismatch',
        path: `modules[${module.number}].duration`,
        message:
          `Module ${module.number} carries ${module.duration.minutes} minutes but the Timing ` +
          `Allocation Document states ${timingModule.minutes}. Timing may not be overridden.`,
        expected: String(timingModule.minutes),
        actual: String(module.duration.minutes),
      });
    }

    if (isInsufficientSource(module.part_a)) continue;

    const partASum = module.part_a.rows.reduce((a, r) => a + r.duration.minutes, 0);
    const expected =
      state.timing_strategy === 'part_a_verbatim' ? timingModule.minutes : timingModule.minutes - 30;

    if (partASum !== expected) {
      findings.push({
        severity: 'error',
        code: 'part_a_duration_mismatch',
        path: `modules[${module.number}].part_a`,
        message:
          `Part A durations sum to ${partASum} minutes; strategy "${state.timing_strategy}" ` +
          `requires ${expected} for a ${timingModule.minutes}-minute module.`,
        expected: String(expected),
        actual: String(partASum),
      });
    }

    // Every unit in the timing document must appear, and no others.
    const stateUnits = new Set(module.part_a.rows.map((r) => r.unit_code));
    for (const unit of timingModule.units) {
      if (!stateUnits.has(unit.code)) {
        findings.push({
          severity: 'error',
          code: 'missing_unit',
          path: `modules[${module.number}].part_a`,
          message: `Unit ${unit.code} ("${unit.title}") is in the timing document but missing from Part A.`,
        });
      }
    }
    const timingUnits = new Set(timingModule.units.map((u) => u.code));
    for (const code of stateUnits) {
      if (!timingUnits.has(code)) {
        findings.push({
          severity: 'error',
          code: 'unknown_unit',
          path: `modules[${module.number}].part_a`,
          message: `Part A contains unit ${code}, which is not in the Timing Allocation Document.`,
        });
      }
    }
  }

  return findings;
}

function validateStructure(state: StoryboardState): Finding[] {
  const findings: Finding[] = [];

  if (state.modules.length === 0) {
    findings.push({
      severity: 'error',
      code: 'no_modules',
      path: 'modules',
      message: 'The storyboard has no modules.',
    });
  }

  for (const module of state.modules) {
    const base = `modules[${module.number}]`;

    if (!isInsufficientSource(module.part_b)) {
      if (module.part_b.rows.length !== PART_B_SEGMENTS) {
        findings.push({
          severity: 'error',
          code: 'part_b_row_count',
          path: `${base}.part_b.rows`,
          message:
            `Part B must have exactly ${PART_B_SEGMENTS} three-minute segments to match the ` +
            'template; the video script table is a fixed shape.',
          expected: String(PART_B_SEGMENTS),
          actual: String(module.part_b.rows.length),
        });
      }
    }

    if (!isInsufficientSource(module.part_c)) {
      if (module.part_c.slides.length !== PART_C_SLIDES) {
        findings.push({
          severity: 'error',
          code: 'part_c_slide_count',
          path: `${base}.part_c.slides`,
          message: `Part C must have exactly ${PART_C_SLIDES} slides to match the template.`,
          expected: String(PART_C_SLIDES),
          actual: String(module.part_c.slides.length),
        });
      }
    }

    // Every Part A unit must be covered by some LMS mapping row, since the
    // reference document maps each unit or unit range to a tracked activity.
    if (!isInsufficientSource(module.lms_mapping) && !isInsufficientSource(module.part_a)) {
      if (module.lms_mapping.rows.length === 0) {
        findings.push({
          severity: 'error',
          code: 'lms_mapping_empty',
          path: `${base}.lms_mapping.rows`,
          message: 'The LMS Technical Mapping table has no rows.',
        });
      } else {
        const covered = new Set<string>();
        for (const row of module.lms_mapping.rows) {
          for (const part of row.unit_range.split(/[,\s]+/)) {
            const range = /^(\d+\.\d+)\s*[-–]\s*(\d+\.\d+)$/.exec(part);
            if (range) {
              // Expand "1.1-1.3" across the module's unit codes.
              const codes = module.part_a.rows.map((r) => r.unit_code);
              const from = codes.indexOf(range[1]!);
              const to = codes.indexOf(range[2]!);
              if (from >= 0 && to >= from) for (let i = from; i <= to; i++) covered.add(codes[i]!);
            } else if (/^\d+\.\d+$/.test(part)) {
              covered.add(part);
            }
          }
        }
        for (const row of module.part_a.rows) {
          if (!covered.has(row.unit_code)) {
            findings.push({
              severity: 'warning',
              code: 'unit_not_mapped',
              path: `${base}.lms_mapping.rows`,
              message: `Unit ${row.unit_code} is not covered by any LMS Technical Mapping row.`,
            });
          }
        }
      }
    }

    // An activity named in the LMS table must exist in Part A, or the two tables
    // describe different courses.
    if (!isInsufficientSource(module.lms_mapping) && !isInsufficientSource(module.part_a)) {
      const activities = new Set(module.part_a.rows.map((r) => r.activity_name).filter((a) => a !== ''));
      for (const row of module.lms_mapping.rows) {
        if (row.activity_type !== '' && activities.size > 0 && !activities.has(row.activity_type)) {
          findings.push({
            severity: 'warning',
            code: 'activity_not_in_part_a',
            path: `${base}.lms_mapping.rows[${row.row_id}].activity_type`,
            message:
              `LMS row names activity "${row.activity_type}", which does not match any Part A ` +
              'activity in this module.',
            actual: row.activity_type,
          });
        }
      }
    }
  }

  return findings;
}

export interface ValidateOptions {
  state: StoryboardState;
  allocation: TimingAllocation;
  /** Skip Level 1 when the client only wants a structural check. */
  skipContent?: boolean;
}

export function validateStoryboard(options: ValidateOptions): ValidationReport {
  const { state, allocation } = options;

  const contentFindings = options.skipContent
    ? []
    : [...validateContent(state), ...validateQuestions(state)];
  const timingFindings = validateTiming(state, allocation);
  const structureFindings = validateStructure(state);
  const all = [...contentFindings, ...timingFindings, ...structureFindings];

  const count = (s: Severity) => all.filter((f) => f.severity === s).length;
  const hasError = (f: readonly Finding[]) => f.some((x) => x.severity === 'error');

  const insufficient = state.modules
    .filter((m) => isInsufficientSource(m.part_a))
    .map((m) => m.number);

  return {
    artifact_id: state.artifact_id,
    course_id: state.course_id,
    version: state.version,
    passed: !hasError(all),
    levels: {
      content: { passed: !hasError(contentFindings), findings: contentFindings },
      timing: { passed: !hasError(timingFindings), findings: timingFindings },
      structure: { passed: !hasError(structureFindings), findings: structureFindings },
    },
    summary: { errors: count('error'), warnings: count('warning'), infos: count('info') },
    insufficient_source_modules: insufficient,
  };
}

/** Narrows a Sourced<T> for callers that have already checked the report. */
export function requireContent<T>(value: T | InsufficientSource, path: string): T {
  if (isInsufficientSource(value)) {
    throw new Error(`${path}: ${value.message}`);
  }
  return value;
}
