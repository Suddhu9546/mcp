/**
 * Proof that building a storyboard does not depend on how capable the client is.
 *
 * The client here is deliberately stupid. It plans nothing, remembers nothing and
 * never decides what to call next: it reads the `next_call` the server returns and
 * does exactly that, filling every field with a sentence lifted from whichever
 * source chunk the task handed it. It has no notion of modules, ordering, row ids,
 * citations or completion.
 *
 * If a valid storyboard comes out of that, the sequencing genuinely lives in the
 * server, which is the property that makes the same output reachable from a weaker
 * model as from a stronger one. When this test fails, some decision has leaked back
 * out to the client.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runTool } from '../src/mcp/tools/index.js';

const COURSE = 'biofuels';

function json(result: Awaited<ReturnType<typeof runTool>>): any {
  return { ...JSON.parse(result.content[0]!.text), __isError: result.isError === true };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return json(await runTool(name, args));
}

describe('model independence', () => {
  beforeAll(async () => {
    const ingested = await call('ingest_course_documents', { course_id: COURSE });
    expect(ingested.__isError).toBe(false);
  }, 300_000);

  it('builds a complete, valid storyboard from a client that only follows next_call', async () => {
    // --- the two questions the user answers -------------------------------
    const menu = await call('start_flow');
    expect(menu.options.map((o: any) => o.value)).toContain('storyboard');

    let step = await call('flow_choose', { session_id: menu.session_id, choice: 'storyboard' });
    step = await call('flow_choose', { session_id: menu.session_id, choice: COURSE });
    expect(step.step).toBe('storyboard_ready');
    expect(step.done).toBe(true);

    // --- everything after this point is the server's job ------------------
    const draft = await call('create_storyboard_draft', { course_id: step.data.course_id });
    expect(draft.next_call.tool).toBe('storyboard_next_task');

    let res = await call(draft.next_call.tool, draft.next_call.args);
    let submits = 0;
    const seen = new Set<string>();

    while (res.status === 'WRITE_THIS') {
      const task = res.task;

      // Every task must arrive ready to answer: sources attached, fields named.
      expect(task.sources.length, `task ${task.task_id} has no sources`).toBeGreaterThan(0);
      expect(task.fields.length).toBeGreaterThan(0);
      expect(seen.has(task.task_id), `task ${task.task_id} was handed out twice`).toBe(false);
      seen.add(task.task_id);

      const source = task.sources[0];
      const sentence = source.text.replace(/\s+/g, ' ').slice(0, 200);
      const args: Record<string, unknown> = {
        artifact_id: draft.artifact_id,
        task_id: task.task_id,
      };

      if (task.section === 'lms_mapping') {
        // The row count comes from the task, not from the client's judgement.
        expect(task.expected_rows.length).toBeGreaterThan(0);
        args.lms_rows = task.expected_rows.map((r: any) => ({
          unit_range: r.unit_range,
          activity_type: r.activity_type,
          recommended_standard: 'xAPI',
          tracking: `Completion and score verbs for ${r.unit_range}.`,
          completion_criteria: sentence,
          chunk_ids: [source.chunk_id],
        }));
      } else if (task.section === 'assessment') {
        args.questions = Array.from({ length: 10 }, (_, i) => ({
          stem: `Question ${i + 1} on ${task.module_title}?`,
          options: { a: 'First', b: 'Second', c: 'Third', d: 'Fourth' },
          correct_option: 'a',
          explanation: sentence,
          chunk_ids: [source.chunk_id],
        }));
      } else {
        args.entries = task.fields.map((f: any) => ({
          field_id: f.field_id,
          text: `${f.label}: ${sentence}`,
          ...(f.requires_citation ? { chunk_ids: [source.chunk_id] } : {}),
        }));
      }

      const before = res.progress.tasks_done;
      res = await call('storyboard_submit_task', args);
      submits++;

      expect(res.__isError, `submit failed on ${task.task_id}: ${res.message}`).toBe(false);
      // The queue must always shrink, or a loop like this never terminates.
      expect(res.progress.tasks_done, `no progress after ${task.task_id}`).toBeGreaterThan(before);
      expect(submits).toBeLessThan(400); // a runaway queue is a failure, not a slow pass
    }

    expect(res.status).toBe('READY_TO_RENDER');
    expect(res.progress.fields_remaining).toBe(0);
    expect(res.progress.percent_complete).toBe(100);

    // --- and it is genuinely valid, not merely finished --------------------
    const report = await call(res.next_call.tool, res.next_call.args);
    expect(report.summary.errors, JSON.stringify(report.levels.content.findings.slice(0, 3))).toBe(0);
    expect(report.passed).toBe(true);

    const rendered = await call('render_storyboard_docx', { artifact_id: draft.artifact_id });
    expect(rendered.__isError).toBe(false);
    expect(rendered.validation_passed).toBe(true);
    expect(rendered.docx_path).toMatch(/\.docx$/);
    expect(rendered.bytes).toBeGreaterThan(20_000);
  }, 600_000);

  it('refuses a citation the task did not offer, so scope cannot be widened', async () => {
    const draft = await call('create_storyboard_draft', { course_id: COURSE });
    const first = await call('storyboard_next_task', { artifact_id: draft.artifact_id });
    const task = first.task;

    const rejected = await call('storyboard_submit_task', {
      artifact_id: draft.artifact_id,
      task_id: task.task_id,
      entries: task.fields.map((f: any) => ({
        field_id: f.field_id,
        text: 'Some text.',
        ...(f.requires_citation ? { chunk_ids: ['not-a-real-chunk'] } : {}),
      })),
    });
    expect(rejected.__isError).toBe(true);

    // Nothing was committed, so the same task is still the one to answer.
    const again = await call('storyboard_next_task', { artifact_id: draft.artifact_id });
    expect(again.task.task_id).toBe(task.task_id);
  }, 120_000);

  it('rejects a stale task_id rather than writing into the wrong row', async () => {
    const draft = await call('create_storyboard_draft', { course_id: COURSE });
    const first = await call('storyboard_next_task', { artifact_id: draft.artifact_id });

    const wrong = await call('storyboard_submit_task', {
      artifact_id: draft.artifact_id,
      task_id: 'nonsense:task:id',
      entries: [{ field_id: first.task.fields[0].field_id, text: 'x' }],
    });
    expect(wrong.__isError).toBe(true);
    expect(wrong.message).toMatch(/is not the current task/);
    expect(wrong.detail.current_task_id).toBe(first.task.task_id);
  }, 120_000);

  it('skips a module the sources cannot support instead of offering it as work', async () => {
    // Biofuels module 8 is Employability Skills, which the supplied documents do
    // not contain. It must never appear in the queue.
    const draft = await call('create_storyboard_draft', { course_id: COURSE });
    const first = await call('storyboard_next_task', { artifact_id: draft.artifact_id });
    expect(first.task.module).toBe(1);

    const m8 = draft.modules.find((m: any) => m.number === 8);
    expect(m8.insufficient_source).toBe(true);
  }, 120_000);

  it('drives the same loop for Solar, whose crosswalk and unit counts differ', async () => {
    await call('ingest_course_documents', { course_id: 'solar-pv' });
    const draft = await call('create_storyboard_draft', { course_id: 'solar-pv' });
    expect(draft.module_count).toBe(10);

    let res = await call('storyboard_next_task', { artifact_id: draft.artifact_id });
    let submits = 0;
    while (res.status === 'WRITE_THIS' && submits < 400) {
      const task = res.task;
      expect(task.sources.length, `task ${task.task_id} has no sources`).toBeGreaterThan(0);
      const source = task.sources[0];
      const sentence = source.text.replace(/\s+/g, ' ').slice(0, 200);
      const args: Record<string, unknown> = { artifact_id: draft.artifact_id, task_id: task.task_id };
      if (task.section === 'lms_mapping') {
        args.lms_rows = task.expected_rows.map((r: any) => ({
          unit_range: r.unit_range,
          activity_type: r.activity_type,
          recommended_standard: 'xAPI',
          tracking: `Verbs for ${r.unit_range}.`,
          completion_criteria: sentence,
          chunk_ids: [source.chunk_id],
        }));
      } else if (task.section === 'assessment') {
        args.questions = Array.from({ length: 10 }, (_, i) => ({
          stem: `Question ${i + 1} on ${task.module_title}?`,
          options: { a: 'First', b: 'Second', c: 'Third', d: 'Fourth' },
          correct_option: 'a',
          explanation: sentence,
          chunk_ids: [source.chunk_id],
        }));
      } else {
        args.entries = task.fields.map((f: any) => ({
          field_id: f.field_id,
          text: `${f.label}: ${sentence}`,
          ...(f.requires_citation ? { chunk_ids: [source.chunk_id] } : {}),
        }));
      }
      res = await call('storyboard_submit_task', args);
      expect(res.__isError, `submit failed: ${res.message}`).toBe(false);
      submits++;
    }

    expect(res.status).toBe('READY_TO_RENDER');
    const rendered = await call('render_storyboard_docx', { artifact_id: draft.artifact_id });
    expect(rendered.validation_passed).toBe(true);
    expect(rendered.docx_path).toMatch(/\.docx$/);
  }, 600_000);

  it('reaches a unit reading in three answers and returns the handbook text', async () => {
    const menu = await call('start_flow');
    await call('flow_choose', { session_id: menu.session_id, choice: 'ph_reading' });
    await call('flow_choose', { session_id: menu.session_id, choice: COURSE });
    await call('flow_choose', { session_id: menu.session_id, choice: '7' });
    const done = await call('flow_choose', { session_id: menu.session_id, choice: '7.3' });

    expect(done.step).toBe('reading_complete');
    expect(done.done).toBe(true);
    expect(done.data.text.length).toBeGreaterThan(500);
    expect(done.data.fidelity_note).toMatch(/verbatim/);
  }, 120_000);

  it('reaches module-content generation in two answers, with the plan attached', async () => {
    const menu = await call('start_flow');
    await call('flow_choose', { session_id: menu.session_id, choice: 'module_content' });
    await call('flow_choose', { session_id: menu.session_id, choice: COURSE });
    const ready = await call('flow_choose', { session_id: menu.session_id, choice: '7' });

    expect(ready.step).toBe('module_ready');
    expect(ready.done).toBe(true);
    // Nothing further is asked: the plan is complete on arrival.
    expect(ready.options).toBeUndefined();
    expect(ready.data.plan.video.segment_count).toBe(18);
    expect(ready.data.plan.slides.slide_count).toBeGreaterThan(0);

    // And the generation chain names its own next step at every hop.
    const planned = await call('plan_module_content', { subject: COURSE, module_number: 7 });
    expect(planned.next_call.tool).toBe('get_module_content_spec');
    // The slide count in the guidance must be the plan's, not a hardcoded number.
    expect(planned.next_step).toContain(`${planned.plan.slides.slide_count} slides`);
  }, 120_000);
});
