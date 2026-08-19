/**
 * The storyboard build loop: one task out, one task back, until it is done.
 *
 * These two tools exist so that building a storyboard does not depend on how
 * capable the connected model is at planning. Everything that used to be the
 * client's job -- module order, row ids, which fields a row needs, what to search
 * for, which chunk to cite, and whether the job is finished -- is decided in
 * ../../storyboard/tasks.ts and handed over one task at a time, with the source
 * text already attached. The client writes the words for the fields in front of
 * it and calls submit; submit commits them and returns the next task in the same
 * shape. There is no ordering decision left to get wrong and no point at which
 * "am I finished?" is a judgement call.
 *
 * The older tools remain: set_storyboard_content still takes a hand-built patch
 * for a caller that wants one. This is the path that works the same on every
 * model.
 */

import { z } from 'zod';
import { isInsufficientSource } from '../../types/source.js';
import type { SourceRef } from '../../types/source.js';
import type { Question, StoryboardState } from '../../types/storyboard.js';
import { commitVersion, getArtifact, getState } from '../../storage/artifact-store.js';
import type { ChangeInput } from '../../storage/artifact-store.js';
import { nextTask, parseFieldId } from '../../storyboard/tasks.js';
import { config } from '../../util/config.js';
import { DEFAULT_STRATEGY_POINTS, buildDisclosure } from './storyboard.js';
import type { ToolDefinition } from './result.js';
import { fail, ok } from './result.js';

const optionSchema = z.enum(['a', 'b', 'c', 'd']);

/** Everything a client needs to act, in the same shape every time. */
function envelope(artifactId: string, state: StoryboardState) {
  const { task, progress, complete } = nextTask(state);
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
        then: 'render_storyboard_docx with the same artifact_id, and attach the .docx it returns.',
      },
      message:
        'Every task is done. Call validate_storyboard, fix any errors it reports with ' +
        'storyboard_submit_task or set_storyboard_content, then render_storyboard_docx and give ' +
        'the user the file.',
    };
  }

  return {
    status: 'WRITE_THIS' as const,
    artifact_id: artifactId,
    version: artifact.current_version,
    progress,
    task,
    next_call: {
      tool: 'storyboard_submit_task',
      args: {
        artifact_id: artifactId,
        task_id: task!.task_id,
        entries: task!.fields.map((f) => ({
          field_id: f.field_id,
          text: '<your text for this field>',
          ...(f.requires_citation ? { chunk_ids: ['<chunk_id from task.sources>'] } : {}),
        })),
      },
    },
    message:
      `Task ${progress.tasks_done + 1} of ${progress.tasks_total}. Write the fields listed in ` +
      'task.fields using task.sources, then call storyboard_submit_task. It returns the next ' +
      'task. Keep going until status is READY_TO_RENDER. Do not stop to summarise, do not ask ' +
      'the user whether to continue, and do not render before then.',
  };
}

const nextTaskTool: ToolDefinition = {
  name: 'storyboard_next_task',
  title: 'Get the next storyboard task',
  description:
    'Returns the one next piece of the storyboard to write, with the handbook text to write it ' +
    'from already attached and the exact fields enumerated. Call this immediately after ' +
    'create_storyboard_draft, and again any time you lose track of where you are. The result is ' +
    'either status WRITE_THIS with a task, or status READY_TO_RENDER when nothing is left. You ' +
    'never need to choose a module, a row or a search query: the queue is ordered for you and ' +
    'the sources are scoped to the module the task belongs to.',
  inputSchema: { artifact_id: z.string() },
  handler: (args) => {
    const artifactId = String(args.artifact_id);
    return ok(envelope(artifactId, getState(artifactId)));
  },
};

const submitTaskTool: ToolDefinition = {
  name: 'storyboard_submit_task',
  title: 'Submit a storyboard task and get the next',
  description:
    'Writes the fields of the task you were given and returns the NEXT task, in the same shape. ' +
    'This is the whole build loop: submit, write what comes back, submit again, until status is ' +
    'READY_TO_RENDER. Pass one entry per field in task.fields, each with the field_id exactly as ' +
    'given. For a field marked requires_citation, pass chunk_ids taken from task.sources -- those ' +
    'chunks are already scoped to the right module, so citing any of them is correct. Nothing is ' +
    'committed if any entry is rejected, so a failed call can be corrected and resent unchanged ' +
    'otherwise.',
  inputSchema: {
    artifact_id: z.string(),
    task_id: z.string().describe('The task_id from the task you were given.'),
    entries: z
      .array(
        z.object({
          field_id: z.string(),
          text: z.string().optional().describe('The content for this field.'),
          chunk_ids: z
            .array(z.string())
            .optional()
            .describe('chunk_id values from task.sources. Required where requires_citation is true.'),
        }),
      )
      .optional()
      .describe('One entry per field, for every section except assessment.'),
    lms_rows: z
      .array(
        z.object({
          unit_range: z.string().describe('Copy from the task\'s expected_rows.'),
          activity_type: z
            .string()
            .describe('Must match that unit\'s Part A activity_name exactly.'),
          recommended_standard: z.enum(['xAPI', 'SCORM 2004', 'SCORM 1.2']),
          tracking: z.string(),
          completion_criteria: z.string(),
          chunk_ids: z.array(z.string()),
        }),
      )
      .optional()
      .describe('For an LMS Technical Mapping task only: one row per entry in expected_rows.'),
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
      .optional()
      .describe('For an assessment task only: the module\'s questions.'),
    note: z.string().optional(),
  },
  handler: (args) => {
    const artifactId = String(args.artifact_id);
    const taskId = String(args.task_id);
    const state = structuredClone(getState(artifactId)) as StoryboardState;
    const baseVersion = getArtifact(artifactId).current_version;

    // Re-derive the task rather than trust the id: a client that resends a stale
    // task must be told so, not silently write into whatever the id now means.
    const current = nextTask(state);
    if (current.complete) {
      return ok({
        ...envelope(artifactId, state),
        note: 'Nothing was written: every task is already done.',
      });
    }
    const task = current.task!;
    if (task.task_id !== taskId) {
      return fail(
        `Task "${taskId}" is not the current task. The current task is "${task.task_id}" ` +
          `(${task.title}). Call storyboard_next_task and answer the task it returns.`,
        { current_task_id: task.task_id, progress: current.progress },
      );
    }

    const changes: ChangeInput[] = [];
    const errors: string[] = [];
    const allowed = new Set(task.sources.map((s) => s.chunk_id));

    /**
     * Citations are checked against the task's own sources, so scope holds.
     *
     * A chunk the task did not offer is refused rather than passed through: the
     * task's chunks are already crosswalk-scoped to the module, which is what
     * makes a wrong-chapter citation unreachable by following the queue.
     */
    function refs(chunkIds: unknown, where: string): SourceRef[] {
      const ids = Array.isArray(chunkIds) ? (chunkIds as string[]) : [];
      const bad = ids.filter((id) => !allowed.has(id));
      if (bad.length > 0) {
        errors.push(
          `${where}: chunk_id ${bad.join(', ')} was not offered by this task. Cite one of ` +
            `${[...allowed].join(', ')}.`,
        );
      }
      return ids.filter((id) => allowed.has(id)).map((id) => ({ chunk_id: id }) as SourceRef);
    }

    if (task.section === 'lms_mapping') {
      const rows = Array.isArray(args.lms_rows) ? (args.lms_rows as Record<string, unknown>[]) : [];
      const expected = task.expected_rows ?? [];
      if (rows.length === 0) {
        return fail(
          `This task creates the LMS Technical Mapping table: pass ${expected.length} entries in ` +
            '"lms_rows", not "entries".',
          { expected_rows: expected },
        );
      }
      const module = state.modules.find((m) => m.number === task.module)!;
      if (isInsufficientSource(module.lms_mapping)) {
        return fail(`Module ${task.module} has no LMS Technical Mapping table.`);
      }

      const built = rows.map((r, i) => ({
        row_id: `m${String(task.module).padStart(2, '0')}-lms-${i + 1}`,
        unit_range: String(r.unit_range ?? expected[i]?.unit_range ?? ''),
        activity_type: String(r.activity_type ?? expected[i]?.activity_type ?? ''),
        recommended_standard: (r.recommended_standard ?? 'xAPI') as never,
        tracking: String(r.tracking ?? '').trim(),
        completion_criteria: String(r.completion_criteria ?? '').trim(),
        sources: refs(r.chunk_ids, `lms row ${i + 1}`),
      }));

      for (const [i, row] of built.entries()) {
        if (row.tracking === '') errors.push(`lms row ${i + 1}: tracking is empty.`);
        if (row.completion_criteria === '') errors.push(`lms row ${i + 1}: completion_criteria is empty.`);
        if (row.sources.length === 0) errors.push(`lms row ${i + 1}: cite a chunk_id from task.sources.`);
      }
      if (errors.length > 0) return fail('Nothing was committed.', { errors, expected_rows: expected });

      module.lms_mapping.rows = built;
      changes.push({
        target: { kind: 'lms_mapping', module: task.module } as never,
        field: 'rows',
        change_type: 'updated',
        old_value: '0',
        new_value: String(built.length),
      });
    } else if (task.section === 'assessment') {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      const wanted = config.assessment.questionsPerModule;
      if (questions.length === 0) {
        return fail(
          `This is an assessment task: pass ${wanted} entries in "questions", not "entries".`,
          { task_id: task.task_id },
        );
      }
      // A fresh skeleton carries the blueprint as INSUFFICIENT_SOURCE_CONTENT
      // until something is written into it. The first assessment task is that
      // something, so it creates the blueprint rather than refusing.
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
      const existing = blueprint.questions.filter((q) => q.module_number === task.module).length;
      const built: Question[] = questions.map((q, i) => {
        const raw = q as Record<string, unknown>;
        return {
          question_id: `q-m${String(task.module).padStart(2, '0')}-${existing + i + 1}`,
          number: blueprint.questions.length + i + 1,
          module_number: task.module,
          stem: String(raw.stem ?? ''),
          options: raw.options as Question['options'],
          correct_option: raw.correct_option as Question['correct_option'],
          explanation: String(raw.explanation ?? ''),
          sources: refs(raw.chunk_ids, `question ${i + 1}`),
          distractors_authored: true,
        };
      });
      if (errors.length > 0) return fail('Nothing was committed.', errors);

      blueprint.questions.push(...built);
      // Renumber in module order so the bank reads continuously however the
      // modules were submitted, and restate the authored-distractor disclosure.
      const order = state.modules.map((m) => m.number);
      blueprint.questions.sort(
        (a, b) => order.indexOf(a.module_number) - order.indexOf(b.module_number) || a.number - b.number,
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
        target: { kind: 'question', module: task.module } as never,
        field: 'questions',
        change_type: 'updated',
        old_value: String(existing),
        new_value: String(existing + built.length),
      });
    } else {
      const entries = Array.isArray(args.entries) ? args.entries : [];
      if (entries.length === 0) {
        return fail('Pass one entry per field in task.fields.', {
          expected_field_ids: task.fields.map((f) => f.field_id),
        });
      }
      const module = state.modules.find((m) => m.number === task.module)!;

      for (const entry of entries as Record<string, unknown>[]) {
        const fieldId = String(entry.field_id);
        const spec = task.fields.find((f) => f.field_id === fieldId);
        if (!spec) {
          errors.push(
            `"${fieldId}" is not a field of this task. Expected: ${task.fields
              .map((f) => f.field_id)
              .join(', ')}.`,
          );
          continue;
        }
        const text = String(entry.text ?? '').trim();
        if (text === '') {
          errors.push(`${fieldId}: text is empty.`);
          continue;
        }
        const sources = refs(entry.chunk_ids, fieldId);
        if (spec.requires_citation && sources.length === 0) {
          errors.push(`${fieldId}: this field must cite at least one chunk_id from task.sources.`);
          continue;
        }

        const { section, row_id, field } = parseFieldId(fieldId);
        const container =
          section === 'part_a' ? module.part_a
          : section === 'lms_mapping' ? module.lms_mapping
          : section === 'part_b' ? module.part_b
          : module.part_c;
        if (isInsufficientSource(container)) {
          errors.push(`${fieldId}: this module has no ${section}.`);
          continue;
        }
        // Part C keys its entries slide_id; every other section keys them row_id.
        const entriesOf = container as unknown as {
          rows?: Record<string, unknown>[];
          slides?: Record<string, unknown>[];
        };
        const rows = entriesOf.rows ?? entriesOf.slides ?? [];
        const row = rows.find((r) => (r.row_id ?? r.slide_id) === row_id) as
          | (Record<string, unknown> & { sources: SourceRef[] })
          | undefined;
        if (!row) {
          errors.push(`${fieldId}: no row "${row_id}" in module ${task.module} ${section}.`);
          continue;
        }

        changes.push({
          target: { kind: section, module: task.module, row_id, field } as never,
          field,
          change_type: 'updated',
          old_value: String(row[field] ?? ''),
          new_value: text,
          ...(sources.length > 0 ? { sources: sources as never } : {}),
        });
        row[field] = text;
        if (sources.length > 0) row.sources = sources;
      }

      // Part A carries the module description implicitly: the first task of a
      // module fills it if it is still blank, so no separate task is needed for a
      // field the template renders once.
      if (
        task.section === 'part_a' &&
        (typeof module.description !== 'string' || module.description.trim() === '')
      ) {
        const written = entries.find((e) =>
          String((e as Record<string, unknown>).field_id).endsWith('interactive_description'),
        ) as Record<string, unknown> | undefined;
        if (written?.text) {
          module.description = `This module covers ${module.title.toLowerCase()}. ${String(written.text)}`;
          module.description_sources = refs(written.chunk_ids, 'module description');
        }
      }

      if (errors.length > 0) {
        return fail(
          'Nothing was committed, so the whole task can be corrected and resent.',
          { errors, expected_field_ids: task.fields.map((f) => f.field_id) },
        );
      }
    }

    commitVersion({
      artifact_id: artifactId,
      base_version: baseVersion,
      state,
      changes,
      ...(args.note ? { note: String(args.note) } : {}),
    });

    return ok({ ...envelope(artifactId, state), committed: task.task_id });
  },
};

export const STORYBOARD_TASK_TOOLS: ToolDefinition[] = [nextTaskTool, submitTaskTool];
