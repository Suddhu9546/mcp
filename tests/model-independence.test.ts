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
import { buildStoryboard } from './helpers/build-storyboard.js';

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
    // --- the three questions the user answers ------------------------------
    const menu = await call('start_flow');
    expect(menu.options.map((o: any) => o.value)).toContain('storyboard');

    let step = await call('flow_choose', { session_id: menu.session_id, choice: 'storyboard' });
    step = await call('flow_choose', { session_id: menu.session_id, choice: 'entrepreneur' });
    step = await call('flow_choose', { session_id: menu.session_id, choice: COURSE });
    // A subject already storyboarded is offered the saved one first. This test is
    // about authoring, so it asks for a fresh one.
    if (step.step === 'choose_storyboard_source') {
      step = await call('flow_choose', { session_id: menu.session_id, choice: 'generate' });
    }
    expect(step.step).toBe('storyboard_ready');
    expect(step.done).toBe(true);

    // --- everything after this point is the server's job ------------------
    const built = await buildStoryboard(call, step.data.course_id);

    // One call per module, plus the first next_module. The whole point of the
    // module loop is the call count: a regression to per-row batching would still
    // produce a valid document, just slowly and expensively, and nothing else
    // here would notice.
    expect(built.calls).toBe(built.modules + 1);
    expect(built.modules).toBeLessThanOrEqual(10);

    expect(built.final.status).toBe('READY_TO_RENDER');
    expect(built.final.progress.fields_remaining).toBe(0);
    expect(built.final.progress.percent_complete).toBe(100);

    // --- and it is genuinely valid, not merely finished --------------------
    const report = await call(built.final.next_call.tool, built.final.next_call.args);
    expect(report.summary.errors, JSON.stringify(report.levels.content.findings.slice(0, 3))).toBe(0);
    expect(report.passed).toBe(true);

    const rendered = await call('render_storyboard_docx', { artifact_id: built.artifactId });
    expect(rendered.__isError).toBe(false);
    expect(rendered.validation_passed).toBe(true);
    expect(rendered.docx_path).toMatch(/\.docx$/);
    expect(rendered.bytes).toBeGreaterThan(20_000);
  }, 600_000);

  it('refuses a citation the work order did not offer, so scope cannot be widened', async () => {
    const draft = await call('create_storyboard_draft', { course_id: COURSE, regenerate: true });
    const first = await call('storyboard_next_module', { artifact_id: draft.artifact_id });

    const rejected = await call('storyboard_submit_module', {
      artifact_id: draft.artifact_id,
      module: first.module.number,
      part_a: first.module.part_a.map((s: any) => ({
        row_id: s.row_id,
        interactive_description: 'Some text.',
        chunk_ids: ['not-a-real-chunk'],
      })),
    });
    expect(rejected.__isError).toBe(true);
    expect(JSON.stringify(rejected.detail)).toMatch(/not in module.sources/);

    // Nothing was committed, so the same module is still the one to answer.
    const again = await call('storyboard_next_module', { artifact_id: draft.artifact_id });
    expect(again.module.number).toBe(first.module.number);
    expect(again.module.part_a.length).toBe(first.module.part_a.length);
  }, 120_000);

  it('rejects a module that is not the current one rather than writing elsewhere', async () => {
    const draft = await call('create_storyboard_draft', { course_id: COURSE, regenerate: true });
    const first = await call('storyboard_next_module', { artifact_id: draft.artifact_id });

    const wrong = await call('storyboard_submit_module', {
      artifact_id: draft.artifact_id,
      module: 99,
      description: 'x',
      description_chunk_ids: [first.module.sources[0].chunk_id],
    });
    expect(wrong.__isError).toBe(true);
    expect(wrong.message).toMatch(/is not the module being built/);
    expect(wrong.detail.current_module).toBe(first.module.number);
  }, 120_000);

  it('commits a partial submission and asks only for what is still blank', async () => {
    // A reply carrying a whole module can be truncated. When that happens the
    // work already written must survive, or every truncation costs a module.
    const draft = await call('create_storyboard_draft', { course_id: COURSE, regenerate: true });
    const first = await call('storyboard_next_module', { artifact_id: draft.artifact_id });
    const module = first.module;
    const chunk = module.sources[0].chunk_id;

    const partial = await call('storyboard_submit_module', {
      artifact_id: draft.artifact_id,
      module: module.number,
      part_a: module.part_a.map((s: any) => ({
        row_id: s.row_id,
        activity_name: 'Guided Simulation',
        interactive_description: 'What the learner does here.',
        correlation: 'PC1',
        chunk_ids: [chunk],
      })),
    });
    expect(partial.__isError, partial.message).toBe(false);

    // Same module, Part A now settled, everything else still outstanding.
    expect(partial.status).toBe('WRITE_THIS');
    expect(partial.module.number).toBe(module.number);
    expect(partial.module.part_a).toHaveLength(0);
    expect(partial.module.part_c.length).toBe(module.part_c.length);
    expect(partial.module.questions_needed).toBe(module.questions_needed);
  }, 120_000);

  it('skips a module the sources cannot support instead of offering it as work', async () => {
    // Biofuels module 8 is Employability Skills, which the supplied documents do
    // not contain. It must never appear in the loop.
    const draft = await call('create_storyboard_draft', { course_id: COURSE, regenerate: true });
    const first = await call('storyboard_next_module', { artifact_id: draft.artifact_id });
    expect(first.module.number).toBe(1);

    const m8 = draft.modules.find((m: any) => m.number === 8);
    expect(m8.insufficient_source).toBe(true);
  }, 120_000);

  it('drives the same loop for Solar, whose crosswalk and unit counts differ', async () => {
    await call('ingest_course_documents', { course_id: 'solar-pv' });
    const built = await buildStoryboard(call, 'solar-pv');

    expect(built.modules).toBe(10);
    expect(built.calls).toBe(11);
    expect(built.final.status).toBe('READY_TO_RENDER');

    const rendered = await call('render_storyboard_docx', { artifact_id: built.artifactId });
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

});
