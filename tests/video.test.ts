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
    const extracted = await extractPdf('courses/entrepreneur/biofuels/ph.pdf');
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

  it('offers three bare options and re-asks rather than guessing', async () => {
    const start = await call('start_flow');
    const session = start.session_id;
    expect(start.options.map((o: any) => o.value)).toEqual([
      'storyboard', 'module_content', 'ph_reading',
    ]);
    // The menu is a list of three choices and nothing else. Explaining them here
    // means the first thing a user sees is a wall of text about choices they have
    // not made yet; every option's detail belongs to the step that follows it.
    expect(start.options.map((o: any) => o.label)).toEqual([
      '1. Generate storyboard', '2. Generate video script', '3. Read handbook content',
    ]);
    for (const option of start.options) expect(option.detail).toBeUndefined();

    const bad = await call('flow_choose', { session_id: session, choice: 'something else' });
    expect(bad.step).toBe('choose_flow');
    expect(bad.error).toBeTruthy();

    // The menu number the user is shown is an answer the menu accepts.
    const picked = await call('flow_choose', { session_id: session, choice: '3' });
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

  it('hands the storyboard flow over in three answers, course already resolved', async () => {
    const start = await call('start_flow');
    const session = start.session_id;

    // The storyboard asks which programme first, because the three tracks are
    // different documents built to different templates from different sources.
    const tracks = await call('flow_choose', { session_id: session, choice: 'storyboard' });
    expect(tracks.step).toBe('choose_track');
    expect(tracks.options.map((o: any) => o.value)).toEqual(['entrepreneur', 'orientation', 'cdr']);

    const subjects = await call('flow_choose', { session_id: session, choice: '1' });
    expect(subjects.step).toBe('choose_subject');
    expect(subjects.options.map((o: any) => o.value)).toEqual([
      'solar-pv', 'biofuels', 'green-hydrogen', 'agri-residue-aggregator',
    ]);
    // Every Entrepreneur subject has its documents and a reviewed crosswalk.
    for (const option of subjects.options) expect(option.disabled).toBeUndefined();

    // The subject is the storyboard's last question: it generates from here.
    const handoff = await call('flow_choose', { session_id: session, choice: 'biofuels' });
    expect(handoff.step).toBe('storyboard_ready');
    expect(handoff.done).toBe(true);
    expect(handoff.data.course_id).toBe(COURSE);
    expect(handoff.data.track).toBe('entrepreneur');
    expect(handoff.next_action).toMatch(/create_storyboard_draft/);
  });

  it('resolves an Entrepreneur subject by number, folder name or course_id', async () => {
    for (const answer of ['1', 'solar', 'solar-pv', 'Solar Photovoltaic Entrepreneur']) {
      const start = await call('start_flow');
      await call('flow_choose', { session_id: start.session_id, choice: '1' });
      await call('flow_choose', { session_id: start.session_id, choice: 'entrepreneur' });
      const done = await call('flow_choose', { session_id: start.session_id, choice: answer });
      expect(done.step, answer).toBe('storyboard_ready');
      expect(done.data.course_id, answer).toBe('solar-pv');
    }
  });

  it('goes back from a subject to the subject list, not to the programme', async () => {
    const start = await call('start_flow');
    const session = start.session_id;
    await call('flow_choose', { session_id: session, choice: 'storyboard' });
    await call('flow_choose', { session_id: session, choice: 'entrepreneur' });
    await call('flow_choose', { session_id: session, choice: 'biofuels' });

    const back = await call('flow_choose', { session_id: session, choice: 'back' });
    expect(back.step).toBe('choose_subject');
    expect(back.selections.track).toBe('entrepreneur');
    expect(back.selections.course_id).toBeUndefined();

    const backAgain = await call('flow_choose', { session_id: session, choice: 'back' });
    expect(backAgain.step).toBe('choose_track');
  });

  it('returns exact handbook text with no added or removed content', async () => {
    const res = await runTool('read_ph_unit', { subject: 'biofuels', unit_code: '7.3' });
    const body = res.content[0]!.text;
    const reading = readPhUnit(COURSE, '7.3');
    // The rendered output contains the unit's text as one contiguous, unmodified run.
    expect(body).toContain(reading.text);
  });

  it('refuses a subject whose handbook has not been supplied', async () => {
    const res = await call('plan_module_content', { subject: 'esg', module_number: 1 });
    expect(res.__isError).toBe(true);
    expect(res.message).toMatch(/not available yet|No Participant Handbook|no handbook/i);
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
