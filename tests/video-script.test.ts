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

  it('is 15-18 scenes running 150-180 seconds, and the seconds sum exactly', () => {
    expect(plan.scene_count).toBeGreaterThanOrEqual(15);
    expect(plan.scene_count).toBeLessThanOrEqual(18);
    expect(plan.total_seconds).toBeGreaterThanOrEqual(150);
    expect(plan.total_seconds).toBeLessThanOrEqual(180);
    expect(plan.scenes.reduce((a: number, s: any) => a + s.seconds, 0)).toBe(plan.total_seconds);
  });

  it('gives every scene exactly ten seconds, which no scene may exceed', () => {
    for (const scene of plan.scenes) expect(scene.seconds).toBe(10);
    expect(plan.scene_seconds).toBe(10);
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
    expect(roles.slice(0, 4)).toEqual([
      'opening',
      'topic_introduction',
      'topic_introduction',
      'learning_transition',
    ]);
    expect(roles[roles.length - 2]).toBe('consolidation');
    expect(roles[roles.length - 1]).toBe('closing');
    // Nine to twelve teaching scenes is what a six-scene frame leaves inside
    // 15-18, and it is what lets every unit have two or three of its own.
    const roadmap = roles.filter((r: string) => r === 'roadmap').length;
    expect(roadmap).toBeGreaterThanOrEqual(9);
    expect(roadmap).toBeLessThanOrEqual(12);
  });

  it('gives every scene the same 22-25 word band', () => {
    expect(plan.words_per_scene).toEqual({ target: 23, min: 22, max: 25 });
    for (const scene of plan.scenes) {
      expect(scene.min_words).toBe(22);
      expect(scene.max_words).toBe(25);
      expect(scene.target_words).toBe(23);
    }
  });

  it('carries the breathing spec, which is what stops clips running together', () => {
    expect(plan.breathing.between_sentences).toMatch(/0\.3-0\.5/);
    expect(plan.breathing.end_of_scene).toMatch(/0\.5/);
    expect(plan.breathing.max_sentences).toBe(3);
  });

  it('gives every unit two or three consecutive scenes, in handbook order', () => {
    for (const unit of plan.module_units) {
      expect(unit.scenes.length).toBeGreaterThanOrEqual(2);
      // Consecutive: a unit's scenes are never interleaved with another's.
      for (let i = 1; i < unit.scenes.length; i++) {
        expect(unit.scenes[i]).toBe(unit.scenes[i - 1] + 1);
      }
    }
    const covered = plan.scenes
      .filter((s: any) => s.role === 'roadmap')
      .map((s: any) => s.units[0].unit_code);
    expect(covered).toEqual([...covered].sort());
  });

  it('gives each scene of a unit its own slice, so the second does not repeat the first', () => {
    const roadmap = plan.scenes.filter((s: any) => s.role === 'roadmap');
    for (const scene of roadmap) {
      expect(scene.units).toHaveLength(1);
      expect(scene.units[0].portion).toMatch(/^\d+ of \d+$/);
    }
    const multi = plan.module_units.find((u: any) => u.scenes.length > 1);
    expect(multi).toBeDefined();
    const slices = roadmap
      .filter((s: any) => s.units[0].unit_code === multi.unit_code)
      .map((s: any) => s.source_text);
    expect(new Set(slices).size).toBe(slices.length);
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

/**
 * A script that passes: 22-25 words a scene, complete sentences, nothing borrowed
 * from the next scene.
 */
function goodScenes(plan: any) {
  const filler = (words: number) =>
    `Namastey. ${Array.from({ length: words - 1 }, (_, i) => `word${i}`).join(' ')}.`;
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
    scenes[0].narration = `Namastey. ${Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')}.`;
    const res = await call('submit_video_script', { script_id: scriptId, scenes });
    expect(res.committed).toBe(false);
    expect(res.validation.findings.some((f: any) => f.check === 'narration_fit')).toBe(true);
  });

  it('rejects narration under twenty-two words', async () => {
    const scenes = goodScenes(plan);
    scenes[3].narration = 'This scene says far too little to fill ten seconds properly.';
    const res = await call('submit_video_script', { script_id: scriptId, scenes });
    expect(res.committed).toBe(false);
    const fit = res.validation.findings.find((f: any) => f.check === 'narration_fit');
    expect(fit.message).toMatch(/at least 22/);
  });

  it('rejects a sentence left open for the next scene to finish', async () => {
    const cases: [string, RegExp][] = [
      // No terminal punctuation at all.
      [`Namastey. ${Array.from({ length: 22 }, (_, i) => `w${i}`).join(' ')}`, /does not end on a full stop/],
      // Ends on a word that promises a continuation.
      [`Namastey. ${Array.from({ length: 21 }, (_, i) => `w${i}`).join(' ')} and.`, /promises something after it/],
    ];
    for (const [narration, expected] of cases) {
      const scenes = goodScenes(plan);
      scenes[1].narration = narration;
      const res = await call('submit_video_script', { script_id: scriptId, scenes });
      const finding = res.validation.findings.find((f: any) => f.check === 'self_contained');
      expect(finding, `"${narration.slice(-30)}" should not be self-contained`).toBeDefined();
      expect(finding.message).toMatch(expected);
    }
  });

  it('rejects a sentence fragment', async () => {
    const scenes = goodScenes(plan);
    scenes[2].narration =
      'Which is why moisture matters so much when the pellets are being formed and cooled. And then.';
    const res = await call('submit_video_script', { script_id: scriptId, scenes });
    const finding = res.validation.findings.find((f: any) => f.check === 'self_contained');
    expect(finding).toBeDefined();
  });

  it('rejects a scene holding more sentences than the breaths fit', async () => {
    const scenes = goodScenes(plan);
    scenes[4].narration =
      'One two three four. Five six seven eight. Nine ten eleven twelve. Thirteen fourteen fifteen sixteen. Seventeen eighteen nineteen twenty.';
    const res = await call('submit_video_script', { script_id: scriptId, scenes });
    const finding = res.validation.findings.find(
      (f: any) => f.check === 'self_contained' && /sentences/.test(f.message),
    );
    expect(finding).toBeDefined();
  });

  it('rejects an opening without the greeting', async () => {
    const scenes = goodScenes(plan);
    scenes[0].narration =
      'Hello everyone and welcome to this short introduction video about how the whole of this ' +
      'subject fits together today.';
    const res = await call('submit_video_script', { script_id: scriptId, scenes });
    expect(res.validation.findings.some((f: any) => f.check === 'opening_greeting')).toBe(true);
  });

  it('rejects anything viewer-facing that names the handbook, a page or a unit number', async () => {
    for (const leak of ['see page 14 for this', 'as unit 7.2 explains', 'the handbook says so']) {
      const scenes = goodScenes(plan);
      scenes[1].narration = `Namastey. Please ${leak}, ${Array.from({ length: 14 }, (_, i) => `w${i}`).join(' ')}.`;
      const res = await call('submit_video_script', { script_id: scriptId, scenes });
      expect(
        res.validation.findings.some((f: any) => f.check === 'no_source_leak'),
        `"${leak}" should be reported as a leak`,
      ).toBe(true);
    }
  });

  it('rejects a duplicated word, which is what a stuttered line sounds like', async () => {
    const scenes = goodScenes(plan);
    scenes[2].narration =
      `Namastey. This is is the part that repeats itself, ${Array.from({ length: 13 }, (_, i) => `w${i}`).join(' ')}.`;
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
      expect(scene.ai_video_prompt).toMatch(/starts speaking within 0\.5-1 second/);
      expect(scene.ai_video_prompt).toMatch(/Speak that line once/);
      // Breathing space is stated in every prompt, at both ends.
      expect(scene.ai_video_prompt).toMatch(/0\.5 seconds of silence after the final word/);
      expect(scene.ai_video_prompt).toMatch(/begins and ends inside these 10 seconds/);
      // The prompt must foreclose the common generator errors explicitly.
      expect(scene.ai_video_prompt).toMatch(/^DO NOT: /m);
      expect(scene.ai_video_prompt).toContain(scene.narration.trim());
      // The setting is restated every time for the same reason the presenter is.
      expect(scene.ai_video_prompt).toContain('SETTING:');
    }
  });
});

describe('the on-screen accuracy block', () => {
  let plan: any;
  let scriptId: string;

  beforeAll(async () => {
    await call('set_video_profile', PROFILE);
    const res = await call('plan_video_script', { subject: COURSE, module_number: MODULE });
    plan = res.plan;
    scriptId = res.script_id;
  });

  /** Submits one variant and returns the composed prompts. */
  async function composed(mutate: (scenes: any[]) => void) {
    const scenes = goodScenes(plan);
    mutate(scenes);
    const res = await call('submit_video_script', { script_id: scriptId, scenes });
    expect(res.committed, JSON.stringify(res.validation?.findings)).toBe(true);
    return res.scenes;
  }

  it('appears in every scene, whether or not the scene shows any text', async () => {
    const scenes = await composed(() => {});
    for (const scene of scenes) {
      expect(scene.ai_video_prompt).toContain('ACCURACY -- this is critical:');
      expect(scene.ai_video_prompt).toMatch(/correctly spelled/);
      expect(scene.ai_video_prompt).toMatch(/Missing text is acceptable; misspelled text is not/);
      expect(scene.ai_video_prompt).toMatch(/^DO NOT: misspell any word on screen/m);
    }
  });

  it('names the exact caption as the only permitted text, character for character', async () => {
    const scenes = await composed((s) => {
      s[0].on_screen_text = 'Gross Calorific Value';
      s[0].educational_visual_elements = [];
    });
    const prompt = scenes[0].ai_video_prompt;
    expect(prompt).toContain('the caption "Gross Calorific Value", exactly as written');
    expect(prompt).toContain('character for character');
    expect(prompt).toMatch(/Add no other text of any kind/);
  });

  it('forbids all text outright when the scene shows none', async () => {
    const scenes = await composed((s) => {
      s[1].on_screen_text = undefined;
      s[1].educational_visual_elements = [];
    });
    const prompt = scenes[1].ai_video_prompt;
    expect(prompt).toMatch(/No text of any kind appears in this frame/);
    expect(prompt).toMatch(/do not invent background lettering/i);
  });

  it('does not forbid text on a scene whose teaching visual carries labels', async () => {
    // The contradiction worth guarding: "no text may appear" alongside "the
    // labels must be spelled correctly" leaves the generator to pick one.
    const scenes = await composed((s) => {
      const roadmap = s.findIndex((x: any) => x.educational_visual_elements.length > 0);
      s[roadmap].on_screen_text = undefined;
      s[roadmap].educational_visual_elements = ['a moisture meter, labelled Moisture Content'];
    });
    const withLabels = scenes.find((x: any) =>
      x.educational_visual_elements.includes('a moisture meter, labelled Moisture Content'),
    );
    expect(withLabels).toBeDefined();
    expect(withLabels.ai_video_prompt).toContain('the labels on the teaching visual named above');
    expect(withLabels.ai_video_prompt).not.toMatch(/No text of any kind appears in this frame/);
  });

  it('permits both the caption and the labels when a scene has both', async () => {
    const scenes = await composed((s) => {
      s[0].on_screen_text = 'Moisture matters';
      s[0].educational_visual_elements = ['a moisture meter showing its reading'];
    });
    const prompt = scenes[0].ai_video_prompt;
    expect(prompt).toContain('the caption "Moisture matters", exactly as written');
    expect(prompt).toContain('and the labels on the teaching visual named above');
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
    expect(types.options[0].label).toBe('1. 2.5-3 minute AI Info Video');
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
    expect(ready.data.plan.scene_count).toBeGreaterThanOrEqual(15);
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
    const forModule = list.scripts.filter(
      (s: any) => s.module_number === MODULE && s.video_type === first.plan.video_type,
    );
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
