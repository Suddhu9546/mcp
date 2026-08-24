/**
 * The storyboard build loop: one module out, one module back.
 *
 * Two tools. `storyboard_next_module` reports everything one module still needs
 * and attaches the chapter it is written from; `storyboard_submit_module` writes
 * all of it in a single version and returns the next module. A six-module course
 * is six calls.
 *
 * The client's job is unchanged -- write the words -- and so is everything that
 * made the previous per-row loop safe: the module order, the row ids, which
 * fields each row needs, and which chunks may be cited are all decided here, and
 * a citation the work order did not offer is refused rather than passed through.
 * What changed is only how much is asked for per call.
 *
 * Submissions are additive and partial ones are accepted, because a reply
 * carrying a whole module is long enough to be truncated. Whatever arrives is
 * committed and the next call returns just the slots still blank, so a truncated
 * reply costs one extra call rather than the module.
 */

import { z } from 'zod';
import { isInsufficientSource } from '../../types/source.js';
import type { SourceRef } from '../../types/source.js';
import type { Question, StoryboardState } from '../../types/storyboard.js';
import { commitVersion, getArtifact, getState } from '../../storage/artifact-store.js';
import type { ChangeInput } from '../../storage/artifact-store.js';
import { nextModule } from '../../storyboard/module-batch.js';
import type { ModuleWorkOrder } from '../../storyboard/module-batch.js';
import type { ToolDefinition } from './result.js';
import { fail, ok } from './result.js';

const optionSchema = z.enum(['a', 'b', 'c', 'd']);

/**
 * The SCGJ assessment strategy, reproduced verbatim from the reference document.
 *
 * These are the Sector Skill Council's own words about how assessment works. They
 * are boilerplate of the qualification, not content derived from a course's
 * sources, so they are stated once here rather than asked of the client.
 */
const DEFAULT_STRATEGY_POINTS = [
  'Criteria for assessment for each Qualification will be created by the Sector Skill Council. Each Element/ Performance Criteria (PC) will be assigned marks proportional to its importance in NOS. SSC will also lay down proportion of marks for Theory and Skills Practical for each Element/ PC.',
  'The assessment for the theory part will be based on knowledge bank of questions created by the SSC.',
  'Assessment will be conducted for all compulsory NOS, and where applicable, on the selected elective/option NOS/set of NOS.',
  'Individual assessment agencies will create unique question papers for theory part for each candidate at each examination/training center (as per assessment criteria below).',
  'Individual assessment agencies will create unique evaluations for skill practical for every student at each examination/ training center based on these criteria.',
  'To pass the Qualification assessment, every trainee should score the Recommended Pass % aggregate for the QP.',
  'In case of unsuccessful completion, the trainee may seek reassessment on the Qualification.',
];

/**
 * The disclosure the reference document carries, reproduced because the same
 * exception applies: a source document has no answer key, so the wrong options
 * must be authored. Saying so in the artifact is what keeps the exception honest.
 */
function buildDisclosure(questionCount: number, verbatimNumbers: number[]): string {
  const base =
    `Note on this question bank: Every question stem, correct answer and explanation below is ` +
    `based on content contained in the approved course source documents. The distractor sets and ` +
    `the wording of the explanations have been authored for this blueprint, as the source ` +
    `documents do not contain an answer key.`;
  if (verbatimNumbers.length === 0) return base;
  const list = verbatimNumbers.join(', ');
  return `${base} Question${verbatimNumbers.length === 1 ? '' : 's'} ${list} ${
    verbatimNumbers.length === 1 ? 'is' : 'are'
  } reproduced verbatim from an exercise in the source documents.`;
}

/**
 * What to write into each field, in one line each.
 *
 * Sent with every work order because it is what the fields mean, and it is
 * cheaper to restate a dozen short lines than to have the client call a spec tool
 * before each module.
 */
const FIELD_SPEC = {
  description: 'One paragraph introducing the module, drawn from the sources.',
  activity_name: 'Short noun phrase naming the interactive activity, e.g. "Guided Simulation".',
  interactive_description: 'What the learner does in it and what it teaches, two or three sentences.',
  correlation:
    'The NOS code, then " / ", then the performance criteria: "SGJ/N1817 / PC1, PC3". The two ' +
    'halves render as separate lines in the cell, so keep the separator.',
  lms_row:
    'One entry per row in module.lms_rows, in that order: recommended_standard, tracking and ' +
    'completion_criteria. Write tracking as a label and a value -- "xAPI Verbs: explored, ' +
    'identified" or "SCORM: cmi.score.raw" -- with a newline between them if the row needs both ' +
    'a verbs line and a data line. completion_criteria is a plain sentence with no label.',
  visual:
    'What is on screen for this segment, written as a label and a description: "Wide ' +
    'establishing shot of ...". Whatever precedes the first ": " renders as the label.',
  audio:
    'The spoken track, attributed to a speaker, e.g. Host (On-Camera): "...". The speaker ' +
    'renders as the label and the dialogue after the colon as the body.',
  visual_cues: 'What appears on the slide: headings, bullets, diagrams, poll options.',
  instructor_script: 'What the instructor says while this slide is up.',
  questions:
    'Multiple-choice questions on this module: stem, options a-d, correct_option, explanation. ' +
    'The three wrong options are authored, not sourced, and must not assert anything the ' +
    'sources do not state.',
  glossary_terms:
    'Technical, financial, regulatory and operational terms and abbreviations this module uses. ' +
    'Each is three fields: the term as the documents write it, its full form, and a ' +
    'one-sentence definition. They are merged with the other modules into one alphabetical ' +
    'table at the end of the document, so do not repeat a term another module has defined.',
} as const;

/** Fields that must carry a citation. The rest are structural or authored. */
const REQUIRES_CITATION = new Set([
  'description',
  'interactive_description',
  'audio',
  'instructor_script',
  'lms_row',
  'questions',
  'glossary_terms',
]);

/** The shape of the submission a work order expects, so the client need not infer it. */
function submissionSkeleton(order: ModuleWorkOrder) {
  return {
    artifact_id: '<artifact_id>',
    module: order.number,
    ...(order.needs_description
      ? { description: '<text>', description_chunk_ids: ['<chunk_id>'] }
      : {}),
    ...(order.part_a.length > 0
      ? {
          part_a: order.part_a.map((s) => ({
            row_id: s.row_id,
            ...Object.fromEntries(s.needs.map((n) => [n, `<${n}>`])),
            chunk_ids: ['<chunk_id>'],
          })),
        }
      : {}),
    ...(order.lms_rows.length > 0
      ? {
          // unit_range and activity_type are omitted on purpose: they are copied
          // from the work order's own lms_rows, not written.
          lms_rows: order.lms_rows.map(() => ({
            recommended_standard: 'xAPI',
            tracking: '<text>',
            completion_criteria: '<text>',
            chunk_ids: ['<chunk_id>'],
          })),
        }
      : {}),
    ...(order.part_b.length > 0
      ? {
          part_b: order.part_b.map((s) => ({
            row_id: s.row_id,
            ...Object.fromEntries(s.needs.map((n) => [n, `<${n}>`])),
            chunk_ids: ['<chunk_id>'],
          })),
        }
      : {}),
    ...(order.part_c.length > 0
      ? {
          part_c: order.part_c.map((s) => ({
            slide_id: s.slide_id,
            ...Object.fromEntries(s.needs.map((n) => [n, `<${n}>`])),
            chunk_ids: ['<chunk_id>'],
          })),
        }
      : {}),
    ...(order.questions_needed > 0
      ? {
          questions: [
            {
              stem: '<question>',
              options: { a: '<a>', b: '<b>', c: '<c>', d: '<d>' },
              correct_option: 'a',
              explanation: '<why>',
              chunk_ids: ['<chunk_id>'],
            },
          ],
        }
      : {}),
    ...(order.glossary_terms_needed > 0
      ? {
          glossary_terms: [
            {
              term: '<abbreviation or term>',
              full_form: '<what it stands for>',
              definition: '<one sentence>',
              chunk_ids: ['<chunk_id>'],
            },
          ],
        }
      : {}),
  };
}

/** Everything the client needs to act, in the same shape every time. */
function envelope(artifactId: string, state: StoryboardState) {
  const { order, progress, complete } = nextModule(state);
  const artifact = getArtifact(artifactId);

  if (complete) {
    return {
      status: 'READY_TO_RENDER' as const,
      artifact_id: artifactId,
      version: artifact.current_version,
      progress,
      next_call: {
        tool: 'validate_storyboard',
        args: { artifact_id: artifactId },
        then: 'render_storyboard_docx with the same artifact_id, and give the user the .docx.',
      },
      message:
        'Every module is written. Call validate_storyboard, fix any errors it reports by ' +
        'resubmitting the affected module, then render_storyboard_docx and give the user the file.',
    };
  }

  const spec = Object.fromEntries(
    (
      [
        ...(order!.needs_description ? ['description'] : []),
        ...new Set(order!.part_a.flatMap((s) => s.needs)),
        ...(order!.lms_rows.length > 0 ? ['lms_row'] : []),
        ...new Set(order!.part_b.flatMap((s) => s.needs)),
        ...new Set(order!.part_c.flatMap((s) => s.needs)),
        ...(order!.questions_needed > 0 ? ['questions'] : []),
        ...(order!.glossary_terms_needed > 0 ? ['glossary_terms'] : []),
      ] as (keyof typeof FIELD_SPEC)[]
    ).map((k) => [
      k,
      REQUIRES_CITATION.has(k) ? `${FIELD_SPEC[k]} Must cite chunk_ids.` : FIELD_SPEC[k],
    ]),
  );

  return {
    status: 'WRITE_THIS' as const,
    artifact_id: artifactId,
    version: artifact.current_version,
    progress,
    module: order,
    spec,
    next_call: { tool: 'storyboard_submit_module', args: submissionSkeleton(order!) },
    message:
      `Module ${order!.number} of ${progress.modules_total}: ${order!.title}. Write every slot ` +
      'listed above from the sources attached, then call storyboard_submit_module once with all ' +
      'of it. It returns the next module. Keep going until status is READY_TO_RENDER. Do not ' +
      'stop to summarise and do not ask the user whether to continue.',
  };
}

const nextModuleTool: ToolDefinition = {
  name: 'storyboard_next_module',
  title: 'Get the next module to write',
  description:
    'Returns one whole module to write -- every row, segment, slide and question still blank -- ' +
    'with the source text to write it from attached once. Call it after ' +
    'create_storyboard_draft, then answer with storyboard_submit_module and repeat. Status is ' +
    'WRITE_THIS with a module, or READY_TO_RENDER when nothing is left. You never choose a ' +
    'module, a row or a citation: the order is fixed and the sources are already scoped to the ' +
    'module, so citing any of them is correct.',
  inputSchema: { artifact_id: z.string() },
  handler: (args) => {
    const artifactId = String(args.artifact_id);
    return ok(envelope(artifactId, getState(artifactId)));
  },
};

const submitModuleTool: ToolDefinition = {
  name: 'storyboard_submit_module',
  title: 'Submit a module and get the next',
  description:
    'Writes a whole module and returns the NEXT one, in the same shape. This is the entire build ' +
    'loop: submit, write what comes back, submit again, until status is READY_TO_RENDER. Pass ' +
    'every slot the work order listed, using its row_id and slide_id values exactly. Cite ' +
    'chunk_ids taken from module.sources -- those are already scoped to this module, so any of ' +
    'them is correct, and one from elsewhere is refused. A partial submission is accepted and ' +
    'committed, and the next call returns only what is still blank, so a reply cut short costs ' +
    'one extra call rather than the module.',
  inputSchema: {
    artifact_id: z.string(),
    module: z.number().int().describe('The module number from the work order.'),
    description: z.string().optional(),
    description_chunk_ids: z.array(z.string()).optional(),
    part_a: z
      .array(
        z.object({
          row_id: z.string(),
          activity_name: z.string().optional(),
          interactive_description: z.string().optional(),
          correlation: z.string().optional(),
          chunk_ids: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    lms_rows: z
      .array(
        z.object({
          recommended_standard: z.enum(['xAPI', 'SCORM 2004', 'SCORM 1.2']),
          tracking: z.string(),
          completion_criteria: z.string(),
          chunk_ids: z.array(z.string()),
        }),
      )
      .optional()
      .describe(
        'One entry per row in module.lms_rows, in that order. Do not send unit_range or ' +
          'activity_type: both are copied from the module Part A rows.',
      ),
    part_b: z
      .array(
        z.object({
          row_id: z.string(),
          visual: z.string().optional(),
          gfx: z.string().optional(),
          audio: z.string().optional(),
          chunk_ids: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    part_c: z
      .array(
        z.object({
          slide_id: z.string(),
          visual_cues: z.string().optional(),
          instructor_script: z.string().optional(),
          chunk_ids: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    questions: z
      .array(
        z.object({
          stem: z.string(),
          options: z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string() }),
          correct_option: optionSchema,
          explanation: z.string(),
          chunk_ids: z.array(z.string()),
        }),
      )
      .optional(),
    glossary_terms: z
      .array(
        z.object({
          term: z.string().describe('The abbreviation or term, as the documents write it.'),
          full_form: z.string().describe('What it stands for. Repeat the term if it is not an abbreviation.'),
          definition: z.string().describe('One sentence explaining it.'),
          chunk_ids: z.array(z.string()),
        }),
      )
      .optional()
      .describe(
        'Terms and abbreviations this module uses. Merged with the other modules into one ' +
          'alphabetical glossary at the end of the document.',
      ),
    note: z.string().optional(),
  },
  handler: (args) => {
    const artifactId = String(args.artifact_id);
    const moduleNumber = Number(args.module);
    const state = structuredClone(getState(artifactId)) as StoryboardState;
    const baseVersion = getArtifact(artifactId).current_version;

    const current = nextModule(state);
    if (current.complete) {
      return ok({
        ...envelope(artifactId, state),
        note: 'Nothing was written: every module is already done.',
      });
    }
    const order = current.order!;
    if (order.number !== moduleNumber) {
      return fail(
        `Module ${moduleNumber} is not the module being built. The current one is ${order.number} ` +
          `(${order.title}). Call storyboard_next_module and answer the module it returns.`,
        { current_module: order.number, progress: current.progress },
      );
    }

    const module = state.modules.find((m) => m.number === moduleNumber)!;
    const changes: ChangeInput[] = [];
    const errors: string[] = [];
    const allowed = new Set(order.sources.map((s) => s.chunk_id));

    /**
     * Citations are checked against the work order's own sources, so scope holds.
     *
     * Those chunks are already crosswalk-scoped to this module, which is what
     * makes a wrong-chapter citation unreachable by following the loop.
     */
    function refs(chunkIds: unknown, where: string): SourceRef[] {
      const ids = Array.isArray(chunkIds) ? (chunkIds as string[]) : [];
      const bad = ids.filter((id) => !allowed.has(id));
      if (bad.length > 0) {
        errors.push(`${where}: chunk_id ${bad.join(', ')} is not in module.sources.`);
      }
      return ids.filter((id) => allowed.has(id)).map((id) => ({ chunk_id: id }) as SourceRef);
    }

    /** Writes the named text fields of one row, recording a change for each. */
    function writeRow(
      row: Record<string, unknown> & { sources: SourceRef[] },
      supplied: Record<string, unknown>,
      fields: readonly string[],
      kind: string,
      rowKey: string,
      cited: SourceRef[],
    ): void {
      for (const field of fields) {
        const value = supplied[field];
        if (value === undefined) continue;
        const text = String(value).trim();
        if (text === '') continue;
        changes.push({
          target: { kind, module: moduleNumber, row_id: rowKey, field } as never,
          field,
          change_type: 'updated',
          old_value: String(row[field] ?? ''),
          new_value: text,
          ...(cited.length > 0 ? { sources: cited as never } : {}),
        });
        row[field] = text;
      }
      if (cited.length > 0) row.sources = cited;
    }

    // --- module description ------------------------------------------------
    if (typeof args.description === 'string' && args.description.trim() !== '') {
      const cited = refs(args.description_chunk_ids, 'description');
      if (cited.length === 0) errors.push('description: cite at least one chunk_id.');
      module.description = args.description.trim();
      module.description_sources = cited;
      changes.push({
        target: { kind: 'module_description', module: moduleNumber } as never,
        field: 'description',
        change_type: 'updated',
        old_value: '',
        new_value: module.description,
      });
    }

    // --- Part A ------------------------------------------------------------
    if (Array.isArray(args.part_a) && !isInsufficientSource(module.part_a)) {
      for (const supplied of args.part_a as Record<string, unknown>[]) {
        const rowId = String(supplied.row_id);
        const row = module.part_a.rows.find((r) => r.row_id === rowId);
        if (!row) {
          errors.push(`part_a: no row "${rowId}" in module ${moduleNumber}.`);
          continue;
        }
        const cited = refs(supplied.chunk_ids, `part_a ${rowId}`);
        const describing =
          typeof supplied.interactive_description === 'string' &&
          supplied.interactive_description.trim() !== '';
        if (describing && cited.length === 0) {
          errors.push(`part_a ${rowId}: interactive_description must cite a chunk_id.`);
          continue;
        }
        writeRow(
          row as never,
          supplied,
          ['activity_name', 'interactive_description', 'correlation'],
          'part_a_cell',
          rowId,
          cited,
        );
      }
    }

    // --- LMS Technical Mapping --------------------------------------------
    if (Array.isArray(args.lms_rows) && args.lms_rows.length > 0) {
      if (isInsufficientSource(module.lms_mapping)) {
        errors.push(`Module ${moduleNumber} has no LMS Technical Mapping table.`);
      } else {
        // unit_range and activity_type come from the module's Part A rows, not from
        // the client: the unit is fixed by the timing document and the activity
        // type has to equal that unit's Part A activity_name, so a retyped value
        // could only ever agree or be wrong.
        //
        // They are read from `module` -- the state as just mutated above -- and not
        // from the work order. The work order was computed before this call, when
        // Part A was still blank, so taking activity_type from it produced an empty
        // Activity Type column in every module written in one pass.
        const partARows = isInsufficientSource(module.part_a) ? [] : module.part_a.rows;
        const built = (args.lms_rows as Record<string, unknown>[]).map((r, i) => {
          const row = partARows[i];
          return {
            row_id: `m${String(moduleNumber).padStart(2, '0')}-lms-${i + 1}`,
            unit_range: row?.unit_code ?? order.lms_rows[i]?.unit_range ?? '',
            activity_type: row?.activity_name ?? order.lms_rows[i]?.activity_type ?? '',
            recommended_standard: (r.recommended_standard ?? 'xAPI') as never,
            tracking: String(r.tracking ?? '').trim(),
            completion_criteria: String(r.completion_criteria ?? '').trim(),
            sources: refs(r.chunk_ids, `lms row ${i + 1}`),
          };
        });
        if (args.lms_rows.length !== order.lms_rows.length) {
          errors.push(
            `lms_rows: expected ${order.lms_rows.length} entries, one per row in ` +
              `module.lms_rows, and got ${args.lms_rows.length}.`,
          );
        }
        // An activity type can only be copied from a Part A row that has one. A
        // blank here means Part A was not written in this call and had no
        // activity_name already, and it would render as an empty column.
        for (const [i, row] of built.entries()) {
          if (row.activity_type.trim() === '') {
            errors.push(
              `lms row ${i + 1}: this unit has no Part A activity_name to take its activity ` +
                'type from. Write Part A in the same submission, or before it.',
            );
          }
        }
        for (const [i, row] of built.entries()) {
          if (row.tracking === '') errors.push(`lms row ${i + 1}: tracking is empty.`);
          if (row.completion_criteria === '') {
            errors.push(`lms row ${i + 1}: completion_criteria is empty.`);
          }
          if (row.sources.length === 0) errors.push(`lms row ${i + 1}: cite a chunk_id.`);
        }
        module.lms_mapping.rows = built;
        changes.push({
          target: { kind: 'lms_mapping', module: moduleNumber } as never,
          field: 'rows',
          change_type: 'updated',
          old_value: '0',
          new_value: String(built.length),
        });
      }
    }

    // --- Part B ------------------------------------------------------------
    if (Array.isArray(args.part_b) && !isInsufficientSource(module.part_b)) {
      for (const supplied of args.part_b as Record<string, unknown>[]) {
        const rowId = String(supplied.row_id);
        const row = module.part_b.rows.find((r) => r.row_id === rowId);
        if (!row) {
          errors.push(`part_b: no row "${rowId}" in module ${moduleNumber}.`);
          continue;
        }
        const cited = refs(supplied.chunk_ids, `part_b ${rowId}`);
        if (typeof supplied.audio === 'string' && supplied.audio.trim() !== '' && cited.length === 0) {
          errors.push(`part_b ${rowId}: audio must cite a chunk_id.`);
          continue;
        }
        writeRow(row as never, supplied, ['visual', 'gfx', 'audio'], 'part_b_cell', rowId, cited);
      }
    }

    // --- Part C ------------------------------------------------------------
    if (Array.isArray(args.part_c) && !isInsufficientSource(module.part_c)) {
      for (const supplied of args.part_c as Record<string, unknown>[]) {
        const slideId = String(supplied.slide_id);
        const slide = module.part_c.slides.find((s) => s.slide_id === slideId);
        if (!slide) {
          errors.push(`part_c: no slide "${slideId}" in module ${moduleNumber}.`);
          continue;
        }
        const cited = refs(supplied.chunk_ids, `part_c ${slideId}`);
        const scripting =
          typeof supplied.instructor_script === 'string' && supplied.instructor_script.trim() !== '';
        if (scripting && cited.length === 0) {
          errors.push(`part_c ${slideId}: instructor_script must cite a chunk_id.`);
          continue;
        }
        writeRow(
          slide as never,
          supplied,
          ['visual_cues', 'instructor_script'],
          'slide',
          slideId,
          cited,
        );
      }
    }

    // --- Assessment --------------------------------------------------------
    if (Array.isArray(args.questions) && args.questions.length > 0) {
      // A fresh skeleton carries the blueprint as INSUFFICIENT_SOURCE_CONTENT
      // until something is written into it; the first module's questions are that
      // something, so they create it rather than being refused.
      if (!state.assessment || isInsufficientSource(state.assessment)) {
        state.assessment = {
          strategy_points: DEFAULT_STRATEGY_POINTS.map((text, i) => ({
            bullet_id: `as-${i + 1}`,
            group: 'Assessment Strategy',
            text,
            sources: [],
          })),
          minimum_aggregate_pass_pct: 70,
          weightage_compulsory: [],
          weightage_electives: {},
          remarks: '',
          disclosure_note: '',
          questions: [],
        };
      }
      const blueprint = state.assessment;
      const existing = blueprint.questions.filter((q) => q.module_number === moduleNumber).length;
      const built: Question[] = (args.questions as Record<string, unknown>[]).map((raw, i) => ({
        question_id: `q-m${String(moduleNumber).padStart(2, '0')}-${existing + i + 1}`,
        number: blueprint.questions.length + i + 1,
        module_number: moduleNumber,
        stem: String(raw.stem ?? ''),
        options: raw.options as Question['options'],
        correct_option: raw.correct_option as Question['correct_option'],
        explanation: String(raw.explanation ?? ''),
        sources: refs(raw.chunk_ids, `question ${i + 1}`),
        distractors_authored: true,
      }));

      blueprint.questions.push(...built);
      // Renumber in module order so the bank reads continuously however the
      // modules were submitted, and restate the authored-distractor disclosure.
      const order2 = state.modules.map((m) => m.number);
      blueprint.questions.sort(
        (a, b) =>
          order2.indexOf(a.module_number) - order2.indexOf(b.module_number) || a.number - b.number,
      );
      blueprint.questions.forEach((q, i) => {
        q.number = i + 1;
        q.question_id = `q-${String(i + 1).padStart(3, '0')}`;
      });
      blueprint.disclosure_note = buildDisclosure(
        blueprint.questions.length,
        blueprint.questions.filter((q) => q.verbatim_from_source).map((q) => q.number),
      );
      changes.push({
        target: { kind: 'question', module: moduleNumber } as never,
        field: 'questions',
        change_type: 'updated',
        old_value: String(existing),
        new_value: String(existing + built.length),
      });
    }

    // --- Glossary ----------------------------------------------------------
    if (Array.isArray(args.glossary_terms) && args.glossary_terms.length > 0) {
      const existing = state.glossary ?? [];
      const known = new Set(existing.map((g) => g.term.trim().toLowerCase()));
      const added: typeof existing = [];
      for (const [i, raw] of (args.glossary_terms as Record<string, unknown>[]).entries()) {
        const term = String(raw.term ?? '').trim();
        const fullForm = String(raw.full_form ?? '').trim();
        const definition = String(raw.definition ?? '').trim();
        if (term === '' || definition === '') {
          errors.push(`glossary term ${i + 1}: both term and definition are required.`);
          continue;
        }
        // A term another module already defined is dropped rather than rejected:
        // the modules are written independently and an overlap is expected, not a
        // mistake to send back.
        if (known.has(term.toLowerCase())) continue;
        known.add(term.toLowerCase());
        const cited = refs(raw.chunk_ids, `glossary term "${term}"`);
        if (cited.length === 0) {
          errors.push(`glossary term "${term}": cite at least one chunk_id.`);
          continue;
        }
        added.push({
          term,
          // Not every glossary line is an abbreviation; where it is not, the term
          // stands in for its own full form rather than leaving the column blank.
          full_form: fullForm === '' ? term : fullForm,
          definition,
          module_number: moduleNumber,
          sources: cited,
        });
      }
      if (added.length > 0) {
        state.glossary = [...existing, ...added];
        changes.push({
          target: { kind: 'module', module: moduleNumber } as never,
          field: 'glossary',
          change_type: 'updated',
          old_value: String(existing.length),
          new_value: String(existing.length + added.length),
        });
      }
    }

    if (errors.length > 0) {
      return fail(
        'Nothing was committed, so the whole module can be corrected and resent.',
        { errors, module: moduleNumber },
      );
    }
    if (changes.length === 0) {
      return fail(
        `No content was supplied for module ${moduleNumber}. Pass the slots the work order listed.`,
        { module: moduleNumber },
      );
    }

    commitVersion({
      artifact_id: artifactId,
      base_version: baseVersion,
      state,
      changes,
      ...(args.note ? { note: String(args.note) } : {}),
    });

    return ok({ ...envelope(artifactId, state), committed_module: moduleNumber });
  },
};

export const STORYBOARD_BUILD_TOOLS: ToolDefinition[] = [nextModuleTool, submitModuleTool];

