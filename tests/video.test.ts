/**
 * The video and reading flows, exercised as a client would drive them.
 *
 * The assertions concentrate on the properties that make the feature trustworthy
 * rather than on wording: the duration arithmetic closes exactly, the handbook
 * structure is derived from the document, the exact-reading mode returns text with
 * no overlap duplication, and a citation from the wrong unit is refused.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'sbmcp-video-')), 'test.db');
process.env.ARTIFACT_DIR = mkdtempSync(path.join(tmpdir(), 'sbmcp-video-art-'));

const { runTool } = await import('../src/mcp/tools/index.js');
const { parseDuration } = await import('../src/video/duration.js');
const { buildScenePlan } = await import('../src/video/scene-plan.js');
const { readPhUnit, getPhOutline } = await import('../src/documents/ph-outline.js');

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await runTool(name, args);
  const text = result.content[result.content.length - 1]?.text ?? '{}';
  const parsed = text.trimStart().startsWith('{') ? JSON.parse(text) : { __text: text };
  return { ...parsed, __isError: result.isError ?? false, __body: result.content[0]?.text ?? '' };
}

const COURSE = 'biofuels';

describe('duration parsing', () => {
  it('reads the forms a user actually says', () => {
    expect(parseDuration('2 min')).toBe(120);
    expect(parseDuration('90 seconds')).toBe(90);
    expect(parseDuration('1:30')).toBe(90);
    expect(parseDuration('2')).toBe(120); // a bare number means minutes
    expect(parseDuration(2)).toBe(120);
  });

  it('refuses what it cannot read rather than guessing', () => {
    expect(() => parseDuration('soonish')).toThrow(/Could not read/);
    expect(() => parseDuration(0)).toThrow();
  });
});

describe('video flows', () => {
  beforeAll(async () => {
    const ingested = await call('ingest_course_documents', { course_id: COURSE, force: true });
    expect(ingested.total_chunks).toBeGreaterThan(500);
  }, 300_000);

  it('offers every subject and says what each unavailable one is waiting for', async () => {
    const res = await call('list_video_subjects');
    expect(res.subject_count).toBe(8);
    const subjects = res.tracks.flatMap((t: any) => t.subjects);
    expect(subjects.filter((s: any) => s.track === 'orientation').map((s: any) => s.code)).toEqual([
      'ESG', 'GHG', 'GL', 'BG',
    ]);
    // Only a missing handbook is a blocker. A handbook that is present but not yet
    // indexed is selectable: the flow indexes it when the subject is chosen.
    for (const subject of subjects) {
      if (subject.selectable) expect(subject.blocker).toBeUndefined();
      else expect(subject.blocker).toMatch(/Place the course's PDFs|registry/);
      expect(subject.needs_index).toBe(subject.ph_present && !subject.ph_indexed);
    }
    expect(subjects.find((s: any) => s.subject_id === 'biofuels').ready).toBe(true);

    // Solar's documents were delivered in courses/solar, not courses/solar-pv;
    // the directory alias is what makes them visible.
    const solar = subjects.find((s: any) => s.subject_id === 'solar-pv');
    expect(solar.ph_present).toBe(true);
    expect(solar.selectable).toBe(true);
  });

  it('indexes a supplied-but-unindexed handbook when its subject is chosen', async () => {
    const start = await call('start_flow');
    const session = start.session_id;
    const subjects = await call('flow_choose', { session_id: session, choice: 'module_content' });

    const solar = subjects.options.find((o: any) => o.value === 'solar-pv');
    expect(solar.disabled).toBeUndefined(); // offered, not blocked

    const modules = await call('flow_choose', { session_id: session, choice: 'solar-pv' });
    expect(modules.step).toBe('choose_module');
    expect(modules.options.length).toBeGreaterThan(0);
  }, 300_000);

  it('derives the handbook outline from the document, not from configuration', async () => {
    const res = await call('get_ph_outline', { subject: 'biofuels' });
    expect(res.unit_count).toBeGreaterThan(20);
    for (const module of res.modules) {
      expect(module.unit_count).toBe(module.units.length);
      for (const unit of module.units) {
        // The unit code carries its own chapter, which is what makes the outline
        // derivable without a declared module table.
        expect(Number(unit.unit_code.split('.')[0])).toBe(module.module_number);
      }
    }
  });

  /**
   * The handbook's own contents page is the reference. Every unit it lists must be
   * offered, under the title it prints, and every module it declares must appear --
   * a user choosing from this list is choosing from the handbook.
   */
  it('lists every module and unit the handbook\'s contents page declares', async () => {
    const { extractPdf } = await import('../src/documents/pdf-extractor.js');
    const { collectContents } = await import('../src/documents/chunker.js');
    const extracted = await extractPdf('courses/biofuels/ph.pdf');
    const contents = collectContents(extracted.pages);

    const res = await call('get_ph_outline', { subject: 'biofuels' });
    const indexed = new Map<string, string>(
      res.modules.flatMap((m: any) => m.units.map((u: any) => [u.unit_code, u.title])),
    );

    expect(contents.unit_titles.size).toBe(30);
    expect(indexed.size).toBe(contents.unit_titles.size);
    for (const [code, title] of contents.unit_titles) {
      expect(indexed.get(code), `unit ${code}`).toBe(title);
    }

    // Eight modules, including Employability Skills, which the handbook declares
    // and then defers to an external workbook. Hiding it would misreport the
    // handbook; offering it as usable would be worse.
    expect(res.module_count).toBe(8);
    expect(res.modules.map((m: any) => m.module_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const employability = res.modules.find((m: any) => m.module_number === 6);
    expect(employability.has_units).toBe(false);
    expect(employability.unit_count).toBe(0);
    expect(employability.note).toMatch(/workbook/i);
    expect(res.selectable_module_count).toBe(7);
  }, 120_000);

  it('starts each unit at the handbook\'s own first line, with no heading debris', () => {
    const outline = getPhOutline(COURSE);
    for (const module of outline.modules) {
      for (const unit of module.units) {
        const reading = readPhUnit(COURSE, unit.unit_code);
        const first = reading.text.split('\n')[0]!;
        // A wrapped title's remainder ("manufacturing Facilities") used to survive
        // as the unit's opening line.
        expect(unit.title.toLowerCase(), `unit ${unit.unit_code}`).not.toContain(
          first.toLowerCase(),
        );
        expect(reading.word_count).toBeGreaterThan(200);
      }
    }
  });

  it('does not file a module\'s opening pages under its last unit', () => {
    // The module opener lists the chapter's units, and its Key Learning Outcomes
    // page follows. Both used to be attributed to the last unit listed.
    const unit = readPhUnit(COURSE, '1.4');
    expect(unit.unit.pdf_page_start).toBeGreaterThan(30);
    expect(unit.text).not.toContain('At the end of this module');
  });

  it('keeps a unit whole across an internal numbered list', () => {
    // A list item like "5. Environmental and Community Safety:" inside Unit 5.1
    // once matched the chapter-5 opener and ended the unit three pages early.
    const unit = readPhUnit(COURSE, '5.1');
    expect(unit.unit.pdf_page_end).toBeGreaterThanOrEqual(197);
    expect(unit.text).toContain('Gasification Unit Safety Procedures');
  });

  it('reports the timing module number separately from the handbook chapter', async () => {
    const res = await call('get_ph_outline', { subject: 'biofuels', module_number: 7 });
    expect(res.modules[0].module_number).toBe(7);
    expect(res.modules[0].timing_module).toBe(5); // they disagree, and both are shown
  });

  it('reassembles a unit with the indexing overlap removed', () => {
    const reading = readPhUnit(COURSE, '7.3');
    expect(reading.word_count).toBeGreaterThan(300);

    // Every block is text not already present in the blocks before it, so no
    // paragraph is served to the reader twice.
    const joined = reading.blocks.map((b) => b.text).join('\n');
    expect(joined).toBe(reading.text);

    const lines = reading.text.split('\n').filter((l) => l.length > 60);
    const seen = new Set<string>();
    const duplicates = lines.filter((l) => (seen.has(l) ? true : (seen.add(l), false)));
    expect(duplicates).toEqual([]);
  });

  it('plans scenes whose seconds and words add up to exactly what was asked for', () => {
    const reading = readPhUnit(COURSE, '7.3');
    for (const seconds of [60, 120, 300, 47 * 7]) {
      const plan = buildScenePlan({ reading, seconds });
      expect(plan.scenes.reduce((a, s) => a + s.seconds, 0)).toBe(seconds);
      expect(plan.scenes[0]!.start_seconds).toBe(0);
      expect(plan.scenes[plan.scenes.length - 1]!.end_seconds).toBe(seconds);
      expect(plan.scenes[0]!.role).toBe('hook');
      expect(plan.scenes[plan.scenes.length - 1]!.role).toBe('recap');
      // Contiguous: each scene starts where the previous one ended.
      for (let i = 1; i < plan.scenes.length; i++) {
        expect(plan.scenes[i]!.start_seconds).toBe(plan.scenes[i - 1]!.end_seconds);
      }
      // Every scene has source text to work from and a chunk to cite.
      for (const scene of plan.scenes) {
        expect(scene.source_chunk_ids.length).toBeGreaterThan(0);
        expect(scene.source_text.length).toBeGreaterThan(0);
      }
    }
  });

  it('covers the whole unit across the body scenes, in the handbook\'s order', () => {
    const reading = readPhUnit(COURSE, '7.3');
    const plan = buildScenePlan({ reading, seconds: 300 });
    const body = plan.scenes.filter((s) => s.role === 'body');
    const covered = new Set(body.flatMap((s) => s.source_chunk_ids));
    for (const chunkId of reading.chunk_ids) expect(covered.has(chunkId)).toBe(true);

    const order = body.flatMap((s) => s.source_chunk_ids);
    const positions = order.map((id) => reading.chunk_ids.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('resolves a unit from a heading and refuses to guess when ambiguous', async () => {
    const confident = await call('find_ph_unit', { heading: 'quality control and testing of pellets' });
    expect(confident.confident).toBe(true);
    expect(confident.candidates[0].unit.unit_code).toBe('7.3');

    const vague = await call('find_ph_unit', { heading: 'biomass' });
    expect(vague.confident).toBe(false);
    expect(vague.candidates.length).toBeGreaterThan(1);
  });

  it('runs the shortcut flow end to end and lands on the requested duration', async () => {
    const planned = await call('plan_video_transcript', {
      heading: 'quality control and testing of pellets',
      duration: '2 min',
    });
    expect(planned.plan.unit_code).toBe('7.3');
    expect(planned.plan.requested_seconds).toBe(120);

    // Write each scene at its target length, quoting the source so the grounding
    // check has something real to measure.
    const scenes = planned.plan.scenes.map((s: any) => ({
      scene_number: s.scene_number,
      title: `Scene ${s.scene_number}`,
      visual: 'Camera pushes in on the pellet sample.',
      narration: s.source_text.split(/\s+/).slice(0, s.target_words).join(' '),
      sources: s.source_chunk_ids.map((chunk_id: string) => ({ chunk_id })),
    }));

    const submitted = await call('submit_video_transcript', {
      transcript_id: planned.transcript_id,
      base_version: planned.base_version,
      scenes,
    });
    expect(submitted.__isError).toBe(false);
    expect(submitted.scenes_written).toBe(planned.plan.scene_count);

    const report = await call('validate_video_transcript', { transcript_id: planned.transcript_id });
    expect(report.passed).toBe(true);
    expect(Math.abs(report.duration.variance_pct)).toBeLessThanOrEqual(10);

    const script = await call('get_video_transcript', { transcript_id: planned.transcript_id });
    expect(script.__body).toContain('SCENE 1');
    expect(script.__body).toContain('NARRATION');
    expect(script.validation_passed).toBe(true);

    // The copy-ready script carries no sourcing furniture: the user pastes it as it
    // is, and a page reference under a scene would have to be deleted by hand.
    expect(script.__body).not.toMatch(/Participant Handbook/i);
    expect(script.__body).not.toMatch(/\bpp?\.\s?\d+/i);
    expect(script.__body).not.toMatch(/source\s*:/i);
    expect(script.__body).not.toMatch(/budget/i);
    expect(script.__body).not.toMatch(/chunk/i);

    // The same transcript still renders with its sourcing for a reviewer.
    const production = await call('get_video_transcript', {
      transcript_id: planned.transcript_id,
      format: 'production',
    });
    expect(production.__body).toMatch(/Participant Handbook/);
  });

  it('rejects a script that refers to the handbook, a page or a figure', async () => {
    const planned = await call('plan_video_transcript', {
      subject: 'biofuels',
      unit_code: '7.3',
      duration: '1 min',
    });
    const scenes = planned.plan.scenes.map((s: any) => ({
      scene_number: s.scene_number,
      title: 'Measuring moisture',
      visual: 'Close-up of the meter display.',
      narration: 'Moisture content is shown as a percentage on the meter display.',
      sources: s.source_chunk_ids.map((chunk_id: string) => ({ chunk_id })),
    }));
    // One scene points the viewer at the source, the way a handbook exercise would.
    scenes[0].on_screen_text = 'Watch: NREL Energy Basics — Biomass (QR in handbook, p.11)';

    await call('submit_video_transcript', {
      transcript_id: planned.transcript_id,
      base_version: planned.base_version,
      scenes,
    });
    const report = await call('validate_video_transcript', { transcript_id: planned.transcript_id });
    expect(report.passed).toBe(false);
    const leak = report.findings.find((f: any) => f.code === 'source_reference_in_script');
    expect(leak).toBeTruthy();
    expect(leak.path).toBe('scenes[1].on_screen_text');
  });

  it('refuses a citation that belongs to another unit', async () => {
    const planned = await call('plan_video_transcript', {
      subject: 'biofuels',
      unit_code: '7.3',
      duration: '1 min',
    });
    const otherUnit = readPhUnit(COURSE, '1.1').chunk_ids[0]!;
    await call('submit_video_transcript', {
      transcript_id: planned.transcript_id,
      base_version: planned.base_version,
      scenes: planned.plan.scenes.map((s: any) => ({
        scene_number: s.scene_number,
        title: 't',
        visual: 'v',
        narration: 'narration text for this scene',
        sources: [{ chunk_id: otherUnit }],
      })),
    });
    const report = await call('validate_video_transcript', { transcript_id: planned.transcript_id });
    expect(report.passed).toBe(false);
    expect(report.findings.some((f: any) => f.code === 'citation_outside_unit')).toBe(true);
  });

  it('rejects a stale base_version instead of overwriting newer work', async () => {
    const planned = await call('plan_video_transcript', {
      subject: 'biofuels',
      unit_code: '7.3',
      duration: '1 min',
    });
    const scene = (n: number) => ({
      scene_number: n,
      title: 't',
      visual: 'v',
      narration: 'some narration',
      sources: [],
    });
    const numbers = planned.plan.scenes.map((s: any) => s.scene_number);
    await call('submit_video_transcript', {
      transcript_id: planned.transcript_id,
      base_version: 1,
      scenes: numbers.map(scene),
    });
    const stale = await call('submit_video_transcript', {
      transcript_id: planned.transcript_id,
      base_version: 1,
      scenes: numbers.map(scene),
    });
    expect(stale.__isError).toBe(true);
    expect(stale.message).toMatch(/Version conflict/);
  });

  it('offers four distinct options and re-asks rather than guessing', async () => {
    const start = await call('start_flow');
    const session = start.session_id;
    expect(start.options.map((o: any) => o.value)).toEqual([
      'module_content', 'ph_reading', 'storyboard', 'cdr_storyboard',
    ]);
    // Each option says what comes out of it, not merely what it is called.
    for (const option of start.options) expect(option.detail.length).toBeGreaterThan(40);

    const bad = await call('flow_choose', { session_id: session, choice: 'something else' });
    expect(bad.step).toBe('choose_flow');
    expect(bad.error).toBeTruthy();

    // The menu number the user is shown is an answer the menu accepts.
    const picked = await call('flow_choose', { session_id: session, choice: '2' });
    expect(picked.flow).toBe('ph_reading');
    expect(picked.step).toBe('choose_subject');
  });

  it('reaches a unit reading in three answers, with no mode or track question', async () => {
    const start = await call('start_flow');
    const session = start.session_id;

    const subjects = await call('flow_choose', { session_id: session, choice: 'ph_reading' });
    // Course type is a label on each subject, not a question of its own.
    expect(subjects.step).toBe('choose_subject');
    expect(subjects.options.some((o: any) => o.value === 'biofuels')).toBe(true);

    const modules = await call('flow_choose', { session_id: session, choice: 'biofuels' });
    expect(modules.step).toBe('choose_module');

    await call('flow_choose', { session_id: session, choice: '7' });
    const done = await call('flow_choose', { session_id: session, choice: '7.3' });

    // The reading branch has no duration step and no generation step to reach.
    expect(done.step).toBe('reading_complete');
    expect(done.done).toBe(true);
    expect(done.data.text).toContain('Gross Calorific Value');
    expect(done.data.fidelity_note).toMatch(/verbatim/);
  });

  it('stops the content flow at the module and never shows units', async () => {
    const start = await call('start_flow');
    const session = start.session_id;
    await call('flow_choose', { session_id: session, choice: 'module_content' });
    await call('flow_choose', { session_id: session, choice: 'biofuels' });

    // Choosing the module is the last question: no unit list, no duration.
    const ready = await call('flow_choose', { session_id: session, choice: '7' });
    expect(ready.step).toBe('module_ready');
    expect(ready.done).toBe(true);
    expect(ready.options).toBeUndefined();
    expect(ready.data.plan.video.segment_count).toBe(18);
    expect(ready.data.plan.video.parts.map((p: any) => p.seconds)).toEqual([60, 90, 30]);
    // The deck is sized to the module, not fixed, and no slide runs over 30 seconds.
    expect(ready.data.plan.slides.slide_count).toBeGreaterThanOrEqual(18);
    expect(ready.data.plan.units.length).toBe(4);
  });

  it('takes a typed topic to the module that holds it, without being asked for one', async () => {
    const start = await call('start_flow');
    const session = start.session_id;
    await call('flow_choose', { session_id: session, choice: 'module_content' });

    // Answered at the subject step: a topic is simply an answer the step understands.
    const typed = await call('flow_choose', {
      session_id: session,
      choice: 'quality control and testing of pellets',
    });
    expect(typed.step).toBe('module_ready');
    expect(typed.data.plan.module_number).toBe(7); // the module holding unit 7.3
  });

  it('asks which unit was meant when a typed topic is ambiguous', async () => {
    const start = await call('start_flow');
    const session = start.session_id;
    await call('flow_choose', { session_id: session, choice: 'ph_reading' });

    const ambiguous = await call('flow_choose', { session_id: session, choice: 'biomass' });
    expect(ambiguous.step).toBe('choose_candidate');
    expect(ambiguous.options.length).toBeGreaterThan(2);

    const chosen = await call('flow_choose', {
      session_id: session,
      choice: ambiguous.options[0].value,
    });
    expect(chosen.step).toBe('reading_complete');
  });

  it('rejects an unrecognised answer rather than treating it as a topic', async () => {
    const start = await call('start_flow');
    const session = start.session_id;
    await call('flow_choose', { session_id: session, choice: 'module_content' });
    const rejected = await call('flow_choose', { session_id: session, choice: 'nonsense-xyzzy' });
    expect(rejected.step).toBe('choose_subject');
    expect(rejected.error).toMatch(/not one of the subjects/);
  });

  it('restarts from any step, including after a finished package', async () => {
    const start = await call('start_flow');
    const session = start.session_id;
    await call('flow_choose', { session_id: session, choice: 'module_content' });
    const ready = await call('flow_choose', {
      session_id: session,
      choice: 'quality control and testing of pellets',
    });
    expect(ready.done).toBe(true);

    // The session a user has finished with is the same one they say "start over" to.
    const restarted = await call('flow_choose', { session_id: session, choice: 'restart' });
    expect(restarted.step).toBe('choose_flow');
    expect(restarted.selections).toEqual({});
    expect(restarted.done).toBe(false);

    // And it is genuinely usable again, for a different flow.
    const again = await call('flow_choose', { session_id: session, choice: 'ph_reading' });
    expect(again.flow).toBe('ph_reading');
    expect(again.step).toBe('choose_subject');
  });

  it('goes back from a package and plans a different module', async () => {
    const start = await call('start_flow');
    const session = start.session_id;
    await call('flow_choose', { session_id: session, choice: 'module_content' });
    await call('flow_choose', { session_id: session, choice: 'biofuels' });
    const first = await call('flow_choose', { session_id: session, choice: '7' });

    const back = await call('flow_choose', { session_id: session, choice: 'back' });
    expect(back.step).toBe('choose_module');
    expect(back.selections.package_id).toBeUndefined();

    const second = await call('flow_choose', { session_id: session, choice: '8' });
    expect(second.data.package_id).not.toBe(first.data.package_id);
    expect(second.data.plan.module_number).toBe(8);
  });

  it('hands the storyboard flow over with the course already resolved', async () => {
    const start = await call('start_flow');
    const session = start.session_id;
    const subjects = await call('flow_choose', { session_id: session, choice: 'storyboard' });
    expect(subjects.step).toBe('choose_subject');

    // The storyboard covers a whole course, so the subject is its last question.
    const handoff = await call('flow_choose', { session_id: session, choice: 'biofuels' });
    expect(handoff.step).toBe('storyboard_ready');
    expect(handoff.done).toBe(true);
    expect(handoff.data.course_id).toBe(COURSE);
    expect(handoff.next_action).toMatch(/create_storyboard_draft/);
  });

  it('returns exact handbook text with no added or removed content', async () => {
    const res = await runTool('read_ph_unit', { subject: 'biofuels', unit_code: '7.3' });
    const body = res.content[0]!.text;
    const reading = readPhUnit(COURSE, '7.3');
    // The rendered output contains the unit's text as one contiguous, unmodified run.
    expect(body).toContain(reading.text);
  });

  it('refuses a subject whose handbook has not been supplied', async () => {
    const res = await call('plan_video_transcript', { subject: 'esg', unit_code: '1.1', duration: 2 });
    expect(res.__isError).toBe(true);
    expect(res.message).toMatch(/not available yet/);
  });

  it('keeps the outline and the reading in agreement about every unit', () => {
    const outline = getPhOutline(COURSE);
    for (const module of outline.modules) {
      for (const unit of module.units) {
        const reading = readPhUnit(COURSE, unit.unit_code);
        expect(reading.unit.heading).toBe(unit.heading);
        expect(reading.text.length).toBeGreaterThan(0);
      }
    }
  });
});
