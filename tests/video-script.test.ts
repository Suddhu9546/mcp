/**
 * The video-script feature, end to end and in pieces.
 *
 * Three things are worth testing here and the rest is not. The arithmetic --
 * scene count, seconds, word bands, unit allocation -- because it is what the
 * server exists to guarantee and a wrong constant would be invisible in a
 * finished script. The validator, because every check it makes corresponds to a
 * way a real script has failed. And the flow, because its whole purpose is that
 * the three features cannot be mixed.
 *
 * Whether the writing is any good is not tested, because it is not decided here.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runTool } from '../src/mcp/tools/index.js';

const COURSE = 'biofuels';
const MODULE = 7;

async function call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await runTool(tool, args);
  const json = JSON.parse(res.content[0]!.text);
  if (res.isError) throw new Error(`${tool} failed: ${json.message}`);
  return json;
}

const PROFILE = {
  gender: 'female',
  age_range: '30-40',
  skin_tone: 'medium-wheatish',
  demographic: 'north-indian',
  attire: 'saree',
  environment: 'rural',
} as const;

beforeAll(async () => {
  await call('ingest_course_documents', { course_id: COURSE });
}, 300_000);

describe('video profile', () => {
  it('offers the six questions when nothing is saved, and saves what is chosen', async () => {
    const saved = await call('set_video_profile', PROFILE);
    expect(saved.profile.attire).toBe('saree');
    expect(saved.described.background_environment).toBe('Rural');

    const read = await call('get_video_profile');
    expect(read.saved).toBe(true);
    expect(read.profile.gender).toBe('female');
  });

  it('refuses an attire that is not offered for the chosen gender', async () => {
    const res = await runTool('set_video_profile', { ...PROFILE, gender: 'male', attire: 'saree' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).message).toMatch(/not an attire option for a male/);
  });

  it('writes one character description and repeats it, rather than one per scene', async () => {
    await call('set_video_profile', PROFILE);
    const { plan } = await call('plan_video_script', { subject: COURSE, module_number: MODULE });
    // The lock must state every attribute the user chose: this is the only thing
    // holding the presenter still across separately generated clips.
    expect(plan.character.description).toMatch(/Indian woman/);
    expect(plan.character.description).toMatch(/aged 30 to 40/);
    expect(plan.character.description).toMatch(/wheatish/);
    expect(plan.character.description).toMatch(/North Indian/);
    expect(plan.character.attire_description).toMatch(/saree/i);
    expect(plan.character.consistency_clause).toMatch(/identical/i);
  });
});

describe('the plan', () => {
  let plan: any;
  beforeAll(async () => {
    await call('set_video_profile', PROFILE);
    plan = (await call('plan_video_script', { subject: COURSE, module_number: MODULE })).plan;
  });

  it('is 6-7 scenes running 60-90 seconds, and the seconds sum exactly', () => {
    expect(plan.scene_count).toBeGreaterThanOrEqual(6);
    expect(plan.scene_count).toBeLessThanOrEqual(7);
    expect(plan.total_seconds).toBeGreaterThanOrEqual(60);
    expect(plan.total_seconds).toBeLessThanOrEqual(90);
    expect(plan.scenes.reduce((a: number, s: any) => a + s.seconds, 0)).toBe(plan.total_seconds);
  });

  it('lays the scenes end to end with no gap and no overlap', () => {
    let cursor = 0;
    for (const scene of plan.scenes) {
      expect(scene.start_seconds).toBe(cursor);
      cursor = scene.end_seconds;
    }
    expect(cursor).toBe(plan.total_seconds);
  });

  it('follows the fixed teaching structure', () => {
    const roles = plan.scenes.map((s: any) => s.role);
    expect(roles[0]).toBe('opening');
    expect(roles[1]).toBe('topic_introduction');
    expect(roles[2]).toBe('learning_transition');
    expect(roles[roles.length - 1]).toBe('closing');
    expect(roles.filter((r: string) => r === 'roadmap').length).toBeGreaterThanOrEqual(2);
  });

  it('gives every scene a word band matching its seconds', () => {
    for (const scene of plan.scenes) {
      expect(scene.min_words).toBe(Math.floor(scene.seconds * 1.1));
      expect(scene.max_words).toBe(Math.ceil(scene.seconds * 1.7));
      expect(scene.target_words).toBeGreaterThan(scene.min_words - 1);
      expect(scene.target_words).toBeLessThan(scene.max_words + 1);
    }
  });

  it('allocates every unit of the module to a roadmap scene, in handbook order', () => {
    for (const unit of plan.module_units) {
      expect(unit.scenes.length).toBeGreaterThan(0);
    }
    const covered = plan.scenes
      .filter((s: any) => s.role === 'roadmap')
      .flatMap((s: any) => s.units.map((u: any) => u.unit_code));
    expect(covered).toEqual([...covered].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('attaches the handbook text and the citable chunks to every scene', () => {
    for (const scene of plan.scenes) {
      expect(scene.source_text.length).toBeGreaterThan(100);
      expect(scene.citable_chunk_ids.length).toBeGreaterThan(0);
    }
  });

  it('carries the writing rules, so nothing else has to be fetched first', async () => {
    const res = await call('plan_video_script', { subject: COURSE, module_number: MODULE });
    expect(res.spec.grounding.length).toBeGreaterThan(0);
    expect(res.next_call.tool).toBe('submit_video_script');
  });

  it('refuses a module the handbook gives no units', async () => {
    const res = await runTool('plan_video_script', { subject: COURSE, module_number: 6 });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).message).toMatch(/no units/i);
  });
});

// ---------------------------------------------------------------------------

/** A script that passes, written from the plan's own bands. */
function goodScenes(plan: any) {
  const filler = (words: number) =>
    ['Namastey', ...Array.from({ length: words - 1 }, (_, i) => `word${i}`)].join(' ');
  return plan.scenes.map((s: any) => ({
    scene_number: s.scene_number,
    educational_purpose: s.educational_purpose,
    location: 'The yard outside a small village pellet unit',
    visual_description: 'The presenter faces camera with the equipment visible behind.',
    character_action: 'Points to the item being described',
    camera_framing: 'Medium shot, presenter centre-left, chest up',
    camera_movement: 'Locked off',
    educational_visual_elements: s.role === 'roadmap' ? ['the die plate, labelled'] : [],
    narration: filler(s.target_words),
    sources: s.role === 'roadmap' ? s.citable_chunk_ids.slice(0, 2) : [],
  }));
}

describe('validation', () => {
  let scriptId: string;
  let plan: any;

  beforeAll(async () => {
    await call('set_video_profile', PROFILE);
    const res = await call('plan_video_script', { subject: COURSE, module_number: MODULE });
    scriptId = res.script_id;
    plan = res.plan;
  });

  it('accepts a script that fits, and commits it', async () => {
    const res = await call('submit_video_script', { script_id: scriptId, scenes: goodScenes(plan) });
    expect(res.committed).toBe(true);
    expect(res.validation.passed).toBe(true);
    expect(res.validation.error_count).toBe(0);
    expect(res.scenes).toHaveLength(plan.scene_count);
    expect(res.file.path).toMatch(/\.txt$/);
  });

  it('rejects narration that overruns its scene, and commits nothing', async () => {
    const scenes = goodScenes(plan);
    scenes[0].narration = `Namastey ${'word '.repeat(60)}`;
    const res = await call('submit_video_script', { script_id: scriptId, scenes });
    expect(res.committed).toBe(false);
    expect(res.validation.findings.some((f: any) => f.check === 'narration_fit')).toBe(true);
  });

  it('rejects an opening without the greeting', async () => {
    const scenes = goodScenes(plan);
    scenes[0].narration = 'Hello everyone and welcome to this short introduction video';
    const res = await call('submit_video_script', { script_id: scriptId, scenes });
    expect(res.validation.findings.some((f: any) => f.check === 'opening_greeting')).toBe(true);
  });

  it('rejects anything viewer-facing that names the handbook, a page or a unit number', async () => {
    for (const leak of ['see page 14 for this', 'as unit 7.2 explains', 'the handbook says so']) {
      const scenes = goodScenes(plan);
      scenes[1].narration = `Namastey ${leak}`;
      const res = await call('submit_video_script', { script_id: scriptId, scenes });
      expect(
        res.validation.findings.some((f: any) => f.check === 'no_source_leak'),
        `"${leak}" should be reported as a leak`,
      ).toBe(true);
    }
  });

  it('rejects a duplicated word, which is what a stuttered line sounds like', async () => {
    const scenes = goodScenes(plan);
    scenes[2].narration = 'Namastey this is is the part that repeats itself';
    const res = await call('submit_video_script', { script_id: scriptId, scenes });
    expect(res.validation.findings.some((f: any) => f.check === 'audio_accuracy')).toBe(true);
  });

  it('rejects a citation from outside the scene\'s own allocation', async () => {
    const scenes = goodScenes(plan);
    const roadmap = scenes.findIndex((s: any) => s.sources.length > 0);
    scenes[roadmap].sources = ['not-a-chunk-id'];
    const res = await call('submit_video_script', { script_id: scriptId, scenes });
    expect(res.validation.findings.some((f: any) => f.check === 'grounding')).toBe(true);
  });

  it('rejects a partial submission', async () => {
    const scenes = goodScenes(plan).slice(0, 3);
    const res = await call('submit_video_script', { script_id: scriptId, scenes });
    expect(res.committed).toBe(false);
    expect(res.validation.findings.some((f: any) => f.check === 'scene_set')).toBe(true);
  });
});

describe('the composed generation prompt', () => {
  it('carries the same presenter block in every scene, and the audio rules in each', async () => {
    await call('set_video_profile', PROFILE);
    const planned = await call('plan_video_script', { subject: COURSE, module_number: MODULE });
    const res = await call('submit_video_script', {
      script_id: planned.script_id,
      scenes: goodScenes(planned.plan),
    });

    const character = planned.plan.character.description;
    for (const scene of res.scenes) {
      expect(scene.ai_video_prompt).toContain(character);
      expect(scene.ai_video_prompt).toContain(planned.plan.character.attire_description);
      expect(scene.ai_video_prompt).toMatch(/begins speaking within 0\.5-1 second/);
      expect(scene.ai_video_prompt).toMatch(/Speak this line once only/);
      expect(scene.ai_video_prompt).toContain(scene.narration.trim());
      // The setting is restated every time for the same reason the presenter is.
      expect(scene.ai_video_prompt).toContain('ENVIRONMENT:');
    }
  });
});

describe('the guided flow', () => {
  it('reaches the plan through course, subject, module, video type and the profile', async () => {
    const menu = await call('start_flow');
    expect(menu.options.map((o: any) => o.value)).toEqual([
      'storyboard',
      'video_script',
      'ph_reading',
    ]);
    const sid = menu.session_id;

    const course = await call('flow_choose', { session_id: sid, choice: '2' });
    expect(course.flow).toBe('video_script');
    expect(course.step).toBe('choose_video_course');

    const subjects = await call('flow_choose', { session_id: sid, choice: 'Entrepreneur' });
    expect(subjects.step).toBe('choose_video_subject');
    // The role titles, which are this flow's names for the subjects.
    expect(subjects.options.map((o: any) => o.label)).toContain('2. Bio-Energy Micro Entrepreneur');

    const modules = await call('flow_choose', { session_id: sid, choice: '2' });
    expect(modules.step).toBe('choose_video_module');
    // Read from the handbook, not from a list in code.
    expect(modules.options.length).toBeGreaterThan(5);

    const types = await call('flow_choose', { session_id: sid, choice: String(MODULE) });
    expect(types.step).toBe('choose_video_type');
    expect(types.options[1].disabled).toBe(true);

    const afterType = await call('flow_choose', { session_id: sid, choice: '1' });
    // A profile is saved by the tests above, so it is offered back rather than re-asked.
    expect(['confirm_video_profile', 'choose_video_character']).toContain(afterType.step);

    const ready =
      afterType.step === 'confirm_video_profile'
        ? await call('flow_choose', { session_id: sid, choice: '1' })
        : await (async () => {
            await call('flow_choose', { session_id: sid, choice: '2, 3, 3, 1, 4' });
            return call('flow_choose', { session_id: sid, choice: 'rural' });
          })();

    expect(ready.step).toBe('video_script_ready');
    expect(ready.done).toBe(true);
    expect(ready.options).toBeUndefined();
    expect(ready.data.plan.scene_count).toBeGreaterThanOrEqual(6);
    expect(ready.data.spec).toBeDefined();
  });

  it('asks the five presenter questions in one step and reads one reply', async () => {
    const menu = await call('start_flow');
    const sid = menu.session_id;
    await call('flow_choose', { session_id: sid, choice: 'video_script' });
    await call('flow_choose', { session_id: sid, choice: '1' });
    await call('flow_choose', { session_id: sid, choice: 'biofuels' });
    await call('flow_choose', { session_id: sid, choice: String(MODULE) });
    await call('flow_choose', { session_id: sid, choice: '1' });
    const confirm = await call('flow_choose', { session_id: sid, choice: 'change' });
    expect(confirm.step).toBe('choose_video_character');
    expect(confirm.data.questions).toHaveLength(5);

    const short = await call('flow_choose', { session_id: sid, choice: 'male' });
    expect(short.step).toBe('choose_video_character');
    expect(short.error).toMatch(/Five answers are needed/);

    // Words work as well as numbers, and the attire list follows the gender.
    const bg = await call('flow_choose', {
      session_id: sid,
      choice: 'male, 40-50, deep, south indian, kurta',
    });
    expect(bg.step).toBe('choose_video_background');

    const ready = await call('flow_choose', { session_id: sid, choice: 'factory' });
    expect(ready.step).toBe('video_script_ready');
    expect(ready.data.plan.character.description).toMatch(/Indian man aged 40 to 50/);
    expect(ready.data.plan.environment.label).toMatch(/Factory/);
  });

  it('refuses the 15-minute type, which is not built', async () => {
    const menu = await call('start_flow');
    const sid = menu.session_id;
    await call('flow_choose', { session_id: sid, choice: '2' });
    await call('flow_choose', { session_id: sid, choice: '1' });
    await call('flow_choose', { session_id: sid, choice: 'biofuels' });
    await call('flow_choose', { session_id: sid, choice: String(MODULE) });
    const refused = await call('flow_choose', { session_id: sid, choice: '2' });
    expect(refused.step).toBe('choose_video_type');
    expect(refused.error).toMatch(/Not implemented yet/);
  });

  it('cannot reach the reading or storyboard terminal steps', async () => {
    const menu = await call('start_flow');
    const sid = menu.session_id;
    await call('flow_choose', { session_id: sid, choice: '2' });
    await call('flow_choose', { session_id: sid, choice: '1' });
    await call('flow_choose', { session_id: sid, choice: 'biofuels' });
    // The video branch stops at the module and asks for a type; it never offers
    // units, which is the reading flow's question.
    const types = await call('flow_choose', { session_id: sid, choice: String(MODULE) });
    expect(types.step).not.toBe('choose_unit');
    expect(types.step).not.toBe('storyboard_ready');
  });

  it('"back" from the background returns to the presenter questions', async () => {
    const menu = await call('start_flow');
    const sid = menu.session_id;
    await call('flow_choose', { session_id: sid, choice: '2' });
    await call('flow_choose', { session_id: sid, choice: '1' });
    await call('flow_choose', { session_id: sid, choice: 'biofuels' });
    await call('flow_choose', { session_id: sid, choice: String(MODULE) });
    await call('flow_choose', { session_id: sid, choice: '1' });
    const step = await call('flow_choose', { session_id: sid, choice: 'change' });
    expect(step.step).toBe('choose_video_character');
    await call('flow_choose', { session_id: sid, choice: '1, 1, 1, 1, 1' });
    const back = await call('flow_choose', { session_id: sid, choice: 'back' });
    expect(back.step).toBe('choose_video_character');
  });
});

describe('storage', () => {
  it('continues one script per module rather than opening a new one each time', async () => {
    await call('set_video_profile', PROFILE);
    const first = await call('plan_video_script', { subject: COURSE, module_number: MODULE });
    const second = await call('plan_video_script', { subject: COURSE, module_number: MODULE });
    expect(second.script_id).toBe(first.script_id);

    const list = await call('list_video_scripts', { subject: COURSE });
    const forModule = list.scripts.filter((s: any) => s.module_number === MODULE);
    expect(forModule).toHaveLength(1);
  });

  it('versions each committed submission and can read an earlier one back', async () => {
    await call('set_video_profile', PROFILE);
    const planned = await call('plan_video_script', { subject: COURSE, module_number: MODULE });
    const one = await call('submit_video_script', {
      script_id: planned.script_id,
      scenes: goodScenes(planned.plan),
      note: 'first',
    });
    const two = await call('submit_video_script', {
      script_id: planned.script_id,
      scenes: goodScenes(planned.plan),
      note: 'second',
    });
    expect(two.version).toBe(one.version + 1);

    const history = await call('get_video_script_history', { script_id: planned.script_id });
    expect(history.versions.map((v: any) => v.note)).toContain('first');

    const old = await call('get_video_script', { script_id: planned.script_id, version: one.version });
    expect(old.version).toBe(one.version);
    expect(old.script_text).toContain('AI VIDEO PROMPT');
  });
});
