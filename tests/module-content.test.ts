/**
 * The module content package: 3-minute video, 9-minute deck, full unit coverage.
 *
 * The assertions concentrate on the promises that make the package usable: the
 * counts and timings are exact, every unit of the module is covered by both halves,
 * a segment that overruns ten seconds is rejected, the delivered text carries no
 * source references, and the .pptx is a structurally sound package with the speaker
 * notes attached.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'sbmcp-mod-')), 'test.db');
process.env.ARTIFACT_DIR = mkdtempSync(path.join(tmpdir(), 'sbmcp-mod-art-'));

const { runTool } = await import('../src/mcp/tools/index.js');
const { readPhModule } = await import('../src/documents/ph-outline.js');
const { buildModulePlan } = await import('../src/video/module-plan.js');

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await runTool(name, args);
  const text = result.content[result.content.length - 1]?.text ?? '{}';
  const parsed = text.trimStart().startsWith('{') ? JSON.parse(text) : {};
  return { ...parsed, __isError: result.isError ?? false, __body: result.content[0]?.text ?? '' };
}

const COURSE = 'biofuels';
const MODULE = 7;

/** Narration of about 23 words: what ten seconds actually holds. */
const NARRATION =
  'Operators check moisture and screen size before the press runs, because a wet batch jams the ' +
  'die and wastes a whole shift.';
const NOTES =
  'Two checks decide whether the shift produces sellable output or scrap. The first is moisture, ' +
  'measured on a sample drawn from inside the pile rather than off the top, because the surface ' +
  'dries first and flatters the reading. The second is particle size: oversized material bridges ' +
  'in the feeder and starves the press. Record both against the batch number.';


const STORY = {
  logline: 'Meera turns the straw left after harvest into a small pellet business.',
  protagonist: {
    name: 'Meera',
    gender: 'female',
    age_range: 'late 20s',
    role: 'smallholder farmer becoming a residue aggregator',
    appearance: 'slim build, hair tied back, sun-worn hands',
    clothing: 'faded blue cotton saree, grey shawl over one shoulder',
    footwear: 'worn rubber slippers',
    personality: 'watchful, practical, asks questions',
  },
  locations: [
    { name: 'paddy field', description: 'harvested field, straw in windrows' },
    { name: 'collection point', description: 'open yard with a weighing scale' },
    { name: 'pellet shed', description: 'small shed with a press and sacks' },
  ],
  visual_style: {
    palette: 'warm dust, straw gold, faded blue',
    lighting: 'low winter sun, long shadows',
    time_of_day: 'late afternoon',
    weather: 'dry and clear',
    camera_language: 'handheld medium shots, slow push-ins, no drone',
  },
  narrator: {
    accent: 'Indian English',
    gender: 'female',
    age_range: '30s',
    tone: 'warm and matter-of-fact',
    pace: 'unhurried',
  },
  opening_image: 'straw smouldering at the edge of a harvested paddy field',
  closing_callback: 'the same field edge, straw baled and loaded instead of burning',
  acts: {
    discovery: 'Meera sees the straw burning and wonders what it is worth.',
    exploration: 'She learns how residue is collected, checked and priced.',
    action: 'She sets up a routine and makes her first sale.',
    payoff: 'The field edge, clean, with the straw moving to the shed.',
  },
};

async function setStory(packageId: string, baseVersion: number) {
  return call('set_module_story', { package_id: packageId, base_version: baseVersion, story: STORY });
}

/**
 * Segments that form a continuous chain: each one opens on the straw bale the last
 * one ended with, which is what the continuity checks look for.
 */
function segmentsFrom(plan: any, overrides: Record<number, Record<string, unknown>> = {}) {
  const last = plan.video.segment_count;
  return plan.video.segments.map((s: any) => ({
    segment_number: s.segment_number,
    story_purpose: `Beat ${s.segment_number}: ${s.story.beat}.`.replace(/[0-9]+\./g, ''),
    continues_from: 'Meera holding the straw bale at the field edge.',
    narration: s.introduces_unit
      ? `Here we look at ${s.allocation.unit_title}, and what it takes to get it right.`
      : NARRATION,
    scene_description:
      s.segment_number === last
        ? 'Meera at the field edge again, the straw bale loaded and the field clear.'
        : 'Meera lifts a straw bale at the field edge, testing its weight.',
    visual_direction: 'Handheld medium shot, low winter sun, slow push in; dust in the light.',
    character_continuity:
      'Meera, late 20s, faded blue cotton saree and grey shawl, hair tied back, worn slippers.',
    location_continuity: 'paddy field, straw in windrows, late afternoon.',
    object_continuity: 'the straw bale she is holding, carried into the next shot.',
    ends_with: 'Meera holding the straw bale, turning towards the track.',
    ...(s.segment_number < last
      ? {
          next_segment_starts_with: 'Meera holding the straw bale, mid-turn.',
          transition: 'She carries the straw bale out of frame; camera follows.',
        }
      : {}),
    sources: s.allocation.source_chunk_ids.slice(0, 3).map((chunk_id: string) => ({ chunk_id })),
    ...(overrides[s.segment_number] ?? {}),
  }));
}

function slidesFrom(plan: any, overrides: Record<number, Record<string, unknown>> = {}) {
  return plan.slides.slides.map((s: any) => ({
    slide_number: s.slide_number,
    title: s.introduces_unit
      ? `${s.allocation.unit_title}: what it covers`
      : 'Two checks before the press runs',
    bullets: ['Moisture from a drawn sample', 'Particle size before feeding', 'Record against the batch'],
    // A unit-opening slide names the unit; it still has to fit its 30 seconds.
    speaker_notes: s.introduces_unit
      ? `This part covers ${s.allocation.unit_title}. ` +
        'Two checks decide whether the shift produces sellable output or scrap: moisture, measured ' +
        'on a sample drawn from inside the pile, and particle size, because oversized material ' +
        'starves the press. Record both against the batch.'
      : NOTES,
    key_takeaway: 'Check before you press, not after.',
    visual: {
      type: 'process',
      description: 'The order the two checks happen in before a batch is pressed.',
      labels: ['Draw a sample', 'Read moisture', 'Screen for size', 'Record and press'],
    },
    sources: s.allocation.source_chunk_ids.slice(0, 3).map((chunk_id: string) => ({ chunk_id })),
    ...(overrides[s.slide_number] ?? {}),
  }));
}

describe('module content package', () => {
  beforeAll(async () => {
    const ingested = await call('ingest_course_documents', { course_id: COURSE, force: true });
    expect(ingested.total_chunks).toBeGreaterThan(500);
  }, 300_000);

  it('plans 18 ten-second segments in three parts of 60, 90 and 30 seconds', () => {
    const plan = buildModulePlan({ reading: readPhModule(COURSE, MODULE) });

    expect(plan.video.segment_count).toBe(18);
    expect(plan.video.segments).toHaveLength(18);
    expect(plan.video.segments.reduce((a, s) => a + s.seconds, 0)).toBe(180);
    for (const [i, segment] of plan.video.segments.entries()) {
      expect(segment.seconds).toBe(10);
      expect(segment.start_seconds).toBe(i * 10);
    }

    expect(plan.video.parts.map((p) => p.seconds)).toEqual([60, 90, 30]);
    expect(plan.video.parts.map((p) => p.segments.length)).toEqual([6, 9, 3]);
    // Part 1 orients to the module, Part 2 teaches units, Part 3 consolidates.
    expect(plan.video.segments.filter((s) => s.part === 1)).toHaveLength(6);
    expect(plan.video.segments.filter((s) => s.part === 2)).toHaveLength(9);
    expect(plan.video.segments.filter((s) => s.part === 3)).toHaveLength(3);
    // Only Part 2 is allocated to individual units.
    for (const segment of plan.video.segments.filter((s) => s.part !== 2)) {
      expect(segment.allocation.portion).toBe('whole module');
    }
  });

  it('sizes the deck to the module and keeps every slide under half a minute', () => {
    for (const moduleNumber of [7, 8]) {
      const plan = buildModulePlan({ reading: readPhModule(COURSE, moduleNumber) });
      expect(plan.slides.slide_count).toBeGreaterThanOrEqual(18);
      expect(plan.slides.slides).toHaveLength(plan.slides.slide_count);
      expect(plan.slides.slides.reduce((a, s) => a + s.seconds, 0)).toBe(540);
      for (const slide of plan.slides.slides) {
        expect(slide.seconds, `module ${moduleNumber} slide ${slide.slide_number}`).toBeLessThanOrEqual(30);
      }
    }
    // A longer module gets more slides rather than denser ones.
    const short = buildModulePlan({ reading: readPhModule(COURSE, 7) }).slides.slide_count;
    const long = buildModulePlan({ reading: readPhModule(COURSE, 8) }).slides.slide_count;
    expect(long).toBeGreaterThan(short);
  });

  it('carries the handbook\'s own learning outcomes into Part 1 and the deck', () => {
    const plan = buildModulePlan({ reading: readPhModule(COURSE, MODULE) });

    // Module 7 states its outcomes on the opener page; they reach the plan verbatim.
    expect(plan.content_map.module_outcomes.length).toBeGreaterThan(5);
    expect(plan.content_map.module_outcomes.join(' ')).toMatch(/moisture|die|pellet/i);

    // Segments 4 and 5 carry them; the deck's second slide states them.
    const carried = plan.video.segments.filter((s) => s.part === 1 && s.learning_outcomes.length > 0);
    expect(carried.map((s) => s.segment_number)).toEqual([4, 5]);
    // Part 2 segments carry their own unit's outcomes.
    for (const segment of plan.video.segments.filter((s) => s.part === 2)) {
      expect(segment.learning_outcomes.length, `segment ${segment.segment_number}`).toBeGreaterThan(0);
    }
    expect(plan.slides.slides[1]!.learning_outcomes.length).toBeGreaterThan(0);

    // Every unit's own outcomes are mapped too.
    for (const unit of plan.content_map.units) {
      expect(unit.outcomes.length, `unit ${unit.unit_code}`).toBeGreaterThan(0);
    }
  });

  it('flags the segment and slide that open each unit', () => {
    const plan = buildModulePlan({ reading: readPhModule(COURSE, MODULE) });
    const openers = plan.video.segments.filter((s) => s.introduces_unit);
    // One opener per unit, all inside Part 2.
    expect(openers).toHaveLength(plan.units.length);
    for (const opener of openers) expect(opener.part).toBe(2);
    expect(openers.map((s) => s.allocation.unit_code)).toEqual(plan.units.map((u) => u.unit_code));

    const slideOpeners = plan.slides.slides.filter((s) => s.introduces_unit);
    expect(slideOpeners.map((s) => s.allocation.unit_code)).toEqual(plan.units.map((u) => u.unit_code));
  });

  it('allocates every unit of the module to both the video and the deck', () => {
    const reading = readPhModule(COURSE, MODULE);
    const plan = buildModulePlan({ reading });

    expect(plan.units).toHaveLength(reading.units.length);
    for (const unit of plan.units) {
      expect(unit.video_segments.length, `unit ${unit.unit_code} segments`).toBeGreaterThan(0);
      expect(unit.slides.length, `unit ${unit.unit_code} slides`).toBeGreaterThan(0);
    }

    // Part 2 runs in handbook order, so the video follows the module's own shape.
    const taught = plan.video.segments.filter((s) => s.part === 2).map((s) => s.allocation.unit_code);
    expect(taught).toEqual([...taught].sort());

    // And every body item has real source text to write from.
    for (const segment of plan.video.segments) {
      expect(segment.allocation.source_chunk_ids.length).toBeGreaterThan(0);
    }
    for (const slide of plan.slides.slides) {
      expect(slide.allocation.source_chunk_ids.length).toBeGreaterThan(0);
    }
  });

  it('builds a complete package and renders both deliverables', async () => {
    const planned = await call('plan_module_content', { subject: 'biofuels', module_number: MODULE });
    expect(planned.plan.units.length).toBe(4);

    const story = await setStory(planned.package_id, planned.base_version);
    const video = await call('submit_module_video', {
      package_id: planned.package_id,
      base_version: story.version,
      segments: segmentsFrom(planned.plan),
    });
    expect(video.__isError).toBe(false);
    expect(video.segments_written).toBe(18);
    // The unwritten deck is not reported against the video submission.
    expect(video.validation.errors, JSON.stringify(video.validation.findings)).toBe(0);

    const deck = await call('submit_module_slides', {
      package_id: planned.package_id,
      base_version: video.version,
      slides: slidesFrom(planned.plan),
    });
    expect(deck.slides_written).toBe(planned.plan.slides.slide_count);
    expect(deck.validation.errors, JSON.stringify(deck.validation.findings)).toBe(0);

    const report = await call('validate_module_package', { package_id: planned.package_id });
    expect(report.passed).toBe(true);
    for (const unit of report.unit_coverage) expect(unit.covered, unit.unit_code).toBe(true);

    const script = await call('get_module_video_script', { package_id: planned.package_id });
    expect(script.__body).toContain('SEGMENT 01 / 18');
    expect(script.__body).toContain('SEGMENT 18 / 18');
    expect(script.__body).toContain('TRANSITION');
    // Copy-ready: no citations anywhere in what the user pastes.
    expect(script.__body).not.toMatch(/Participant Handbook/i);
    expect(script.__body).not.toMatch(/\bpp?\.\s?\d+/i);

    const slides = await call('get_module_slides', { package_id: planned.package_id });
    expect(slides.__body).toContain(`SLIDE 01 / ${planned.plan.slides.slide_count}`);
    expect(slides.__body).toContain('SPEAKER NOTES');
  }, 120_000);

  it('rejects narration that will not fit ten seconds', async () => {
    const planned = await call('plan_module_content', { subject: 'biofuels', module_number: MODULE });
    const long = `${NARRATION} ${NARRATION} ${NARRATION}`;
    const story = await setStory(planned.package_id, planned.base_version);
    await call('submit_module_video', {
      package_id: planned.package_id,
      base_version: story.version,
      segments: segmentsFrom(planned.plan, { 5: { narration: long } }),
    });

    const report = await call('validate_module_package', { package_id: planned.package_id });
    const overrun = report.findings.find((f: any) => f.code === 'segment_overruns');
    expect(overrun).toBeTruthy();
    expect(overrun.path).toBe('segments[5].narration');
    expect(report.passed).toBe(false);
  }, 120_000);

  it('rejects a unit left out of the deck', async () => {
    const planned = await call('plan_module_content', { subject: 'biofuels', module_number: MODULE });
    // Every slide cites unit 7.1, so the module's other three units go uncovered.
    const firstUnitChunks = planned.plan.units[0].chunk_ids.slice(0, 2);
    await call('submit_module_slides', {
      package_id: planned.package_id,
      base_version: planned.base_version,
      slides: slidesFrom(planned.plan).map((s: any) => ({
        ...s,
        sources: firstUnitChunks.map((chunk_id: string) => ({ chunk_id })),
      })),
    });

    const report = await call('validate_module_package', { package_id: planned.package_id });
    const uncovered = report.findings.filter((f: any) => f.code === 'unit_not_covered_by_slides');
    expect(uncovered.length).toBe(planned.plan.units.length - 1);
  }, 120_000);

  it('rejects delivered text that refers to the handbook', async () => {
    const planned = await call('plan_module_content', { subject: 'biofuels', module_number: MODULE });
    const story = await setStory(planned.package_id, planned.base_version);
    await call('submit_module_video', {
      package_id: planned.package_id,
      base_version: story.version,
      segments: segmentsFrom(planned.plan, {
        3: { on_screen_text: 'See Figure 53 in the handbook, p.231' },
      }),
    });
    const report = await call('validate_module_package', { package_id: planned.package_id });
    const leak = report.findings.find((f: any) => f.code === 'source_reference_in_script');
    expect(leak).toBeTruthy();
    expect(leak.path).toBe('segments[3].on_screen_text');
  }, 120_000);

  it('writes a structurally valid .pptx with the speaker notes attached', async () => {
    const planned = await call('plan_module_content', { subject: 'biofuels', module_number: MODULE });
    const story = await setStory(planned.package_id, planned.base_version);
    const video = await call('submit_module_video', {
      package_id: planned.package_id,
      base_version: story.version,
      segments: segmentsFrom(planned.plan),
    });
    await call('submit_module_slides', {
      package_id: planned.package_id,
      base_version: video.version,
      slides: slidesFrom(planned.plan),
    });

    const rendered = await call('render_module_pptx', { package_id: planned.package_id });
    expect(rendered.__isError, JSON.stringify(rendered.detail?.findings ?? rendered.message)).toBe(false);
    expect(rendered.slides).toBe(planned.plan.slides.slide_count);

    const zip = await JSZip.loadAsync(readFileSync(rendered.pptx_path));
    const names = Object.keys(zip.files);

    // The parts PowerPoint requires, plus one slide and one notes slide per slide.
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/notesMasters/notesMaster1.xml',
      'ppt/theme/theme1.xml',
    ]) {
      expect(names, required).toContain(required);
    }
    const count = planned.plan.slides.slide_count;
    expect(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(count);
    expect(names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))).toHaveLength(count);

    // Every declared relationship target exists: a dangling one makes the file
    // unopenable, and nothing else in the test would notice.
    for (const name of names.filter((n) => n.endsWith('.rels'))) {
      const xml = await zip.file(name)!.async('string');
      const dir = name.replace(/_rels\/[^/]+$/, '');
      for (const match of xml.matchAll(/Target="([^"]+)"/g)) {
        const resolved = path.posix.normalize(path.posix.join(dir, match[1]!));
        expect(zip.file(resolved), `${match[1]} from ${name}`).toBeTruthy();
      }
    }

    const slide = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(slide).toContain('Moisture from a drawn sample');
    // The CVC design system, applied to every slide rather than to some of them.
    expect(slide).toContain('FAF6EC'); // cream page
    expect(slide).toContain('17352A'); // deep green ink
    expect(slide).toContain('3F7A55'); // the single accent

    // The right-hand visual is drawn as real shapes from the slide's labels.
    const body = await zip.file('ppt/slides/slide4.xml')!.async('string');
    expect(body).toContain('Draw a sample');
    expect(body).toContain('Read moisture');
    expect(body).toContain('downArrow');

    const notes = await zip.file('ppt/notesSlides/notesSlide2.xml')!.async('string');
    expect(notes).toContain('Two checks decide');
  }, 180_000);

  it('gives every segment a story beat, in three acts and a payoff', () => {
    const plan = buildModulePlan({ reading: readPhModule(COURSE, MODULE) });
    const acts = plan.video.segments.map((s) => s.story.act);

    expect(acts[0]).toBe('discovery');
    expect(acts[17]).toBe('payoff');
    // Acts run in order and never return: a film does not go back to Act 1.
    const order = ['discovery', 'exploration', 'action', 'payoff'];
    const positions = acts.map((a) => order.indexOf(a));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // Every beat is distinct, so no two segments are handed the same job.
    const beats = plan.video.segments.map((s) => s.story.beat);
    expect(new Set(beats).size).toBe(18);
    for (const segment of plan.video.segments) {
      expect(segment.purpose).toContain(segment.story.beat);
    }
  });

  it('refuses the segments until the film has a story bible', async () => {
    const planned = await call('plan_module_content', { subject: 'biofuels', module_number: MODULE });
    const res = await call('submit_module_video', {
      package_id: planned.package_id,
      base_version: planned.base_version,
      segments: segmentsFrom(planned.plan),
    });
    expect(res.__isError).toBe(true);
    expect(JSON.stringify(res.detail)).toMatch(/set_module_story/);
  }, 120_000);

  it('reports a cut that has nothing in common with the segment before it', async () => {
    const planned = await call('plan_module_content', { subject: 'biofuels', module_number: MODULE });
    const story = await setStory(planned.package_id, planned.base_version);
    await call('submit_module_video', {
      package_id: planned.package_id,
      base_version: story.version,
      segments: segmentsFrom(planned.plan, {
        9: {
          // A jump: nothing here continues the bale at the field edge.
          continues_from: 'A wide aerial view of a distant motorway junction at night.',
          scene_description: 'Traffic streaming below.',
        },
      }),
    });

    const report = await call('validate_module_package', { package_id: planned.package_id });
    const broken = report.findings.find((f: any) => f.code === 'continuity_break');
    expect(broken).toBeTruthy();
    expect(broken.path).toBe('segments[9].continues_from');
  }, 120_000);

  it('reports a segment that drops the protagonist or leaves the film\'s world', async () => {
    const planned = await call('plan_module_content', { subject: 'biofuels', module_number: MODULE });
    const story = await setStory(planned.package_id, planned.base_version);
    await call('submit_module_video', {
      package_id: planned.package_id,
      base_version: story.version,
      segments: segmentsFrom(planned.plan, {
        4: { character_continuity: 'A technician in a lab coat, unnamed.' },
        6: {
          visual_direction: 'Futuristic white studio with a rotating platform and floating icons.',
          location_continuity: 'a white studio',
        },
      }),
    });

    const report = await call('validate_module_package', { package_id: planned.package_id });
    expect(report.findings.some((f: any) => f.code === 'protagonist_not_carried')).toBe(true);
    expect(report.findings.some((f: any) => f.code === 'out_of_world_visual')).toBe(true);
    expect(report.findings.some((f: any) => f.code === 'unknown_location')).toBe(true);
  }, 120_000);

  it('caps supporting graphics at a fifth of the film', async () => {
    const planned = await call('plan_module_content', { subject: 'biofuels', module_number: MODULE });
    const story = await setStory(planned.package_id, planned.base_version);
    const graphics = Object.fromEntries(
      [2, 3, 4, 5, 6, 7].map((n) => [n, { visual_mode: 'supporting_graphic' }]),
    );
    await call('submit_module_video', {
      package_id: planned.package_id,
      base_version: story.version,
      segments: segmentsFrom(planned.plan, graphics),
    });

    const report = await call('validate_module_package', { package_id: planned.package_id });
    const finding = report.findings.find((f: any) => f.code === 'too_many_graphics');
    expect(finding).toBeTruthy();
    expect(finding.expected).toBe('<= 3');
  }, 120_000);

  it('builds a progressive subtitle track from the narration', async () => {
    const planned = await call('plan_module_content', { subject: 'biofuels', module_number: MODULE });
    const story = await setStory(planned.package_id, planned.base_version);
    await call('submit_module_video', {
      package_id: planned.package_id,
      base_version: story.version,
      segments: segmentsFrom(planned.plan),
    });

    const cues = await call('get_module_subtitles', {
      package_id: planned.package_id,
      format: 'cues',
    });
    // One cue per word of narration, each showing the line revealed so far.
    const words = planned.plan.video.segments
      .map((s: any) => (s.introduces_unit
        ? `Here we look at ${s.allocation.unit_title}, and what it takes to get it right.`
        : NARRATION))
      .reduce((a: number, n: string) => a + n.split(/\s+/).length, 0);
    expect(cues.cue_count).toBe(words);
    expect(cues.cues[0].text).toBe('Operators');
    expect(cues.cues[1].text).toBe('Operators check');
    expect(cues.cues[0].start_seconds).toBe(0);
    // Cues advance and stay inside the film.
    for (let i = 1; i < cues.cues.length; i++) {
      expect(cues.cues[i].start_seconds).toBeGreaterThanOrEqual(cues.cues[i - 1].start_seconds);
    }
    expect(cues.cues[cues.cues.length - 1].end_seconds).toBeLessThanOrEqual(180.01);

    const srt = await call('get_module_subtitles', { package_id: planned.package_id });
    expect(srt.__body).toMatch(/^1\n00:00:00,000 --> /);
  }, 120_000);

  it('carries the film\'s constants into the rendered script', async () => {
    const planned = await call('plan_module_content', { subject: 'biofuels', module_number: MODULE });
    const story = await setStory(planned.package_id, planned.base_version);
    await call('submit_module_video', {
      package_id: planned.package_id,
      base_version: story.version,
      segments: segmentsFrom(planned.plan),
    });

    const script = await call('get_module_video_script', { package_id: planned.package_id });
    // The generator is blind to the other clips, so the script states the constants.
    expect(script.__body).toContain('Meera');
    expect(script.__body).toContain('Indian English');
    expect(script.__body).toContain('CONTINUES FROM');
    expect(script.__body).toContain('ENDS WITH');
    expect(script.__body).toContain('NEXT STARTS WITH');
    expect(script.__body).toContain('CHARACTER');
    expect(script.__body).toContain('typewriter');
    // Still no sourcing furniture in what the user copies.
    expect(script.__body).not.toMatch(/Participant Handbook/i);
  }, 120_000);

  it('writes every deliverable as a file for the user to download', async () => {
    const { existsSync, statSync } = await import('node:fs');
    const planned = await call('plan_module_content', { subject: 'biofuels', module_number: MODULE });
    const story = await setStory(planned.package_id, planned.base_version);
    const video = await call('submit_module_video', {
      package_id: planned.package_id,
      base_version: story.version,
      segments: segmentsFrom(planned.plan),
    });
    const deck = await call('submit_module_slides', {
      package_id: planned.package_id,
      base_version: video.version,
      slides: slidesFrom(planned.plan),
    });

    const exported = await call('export_module_package', { package_id: planned.package_id });
    expect(exported.__isError, JSON.stringify(exported.message)).toBe(false);

    const kinds = exported.files.map((f: any) => f.kind).sort();
    expect(kinds).toEqual(['deck_pptx', 'deck_text', 'subtitles', 'video_script']);
    for (const file of exported.files) {
      expect(existsSync(file.path), file.filename).toBe(true);
      expect(statSync(file.path).size).toBe(file.bytes);
      expect(file.bytes).toBeGreaterThan(500);
      // The version is in the name, so two downloads are told apart in a folder.
      expect(file.filename).toMatch(new RegExp(`^module-${MODULE}-.*-v${deck.version}\.`));
    }

    // The inline tools write their file too, so any route to a script produces one.
    const script = await call('get_module_video_script', { package_id: planned.package_id });
    expect(script.file.kind).toBe('video_script');
    expect(existsSync(script.file.path)).toBe(true);
    const srt = await call('get_module_subtitles', { package_id: planned.package_id });
    expect(srt.file.filename).toMatch(/\.srt$/);
    expect(existsSync(srt.file.path)).toBe(true);
  }, 180_000);

  it('refuses a module the handbook gives no units', async () => {
    const res = await call('plan_module_content', { subject: 'biofuels', module_number: 6 });
    expect(res.__isError).toBe(true);
    expect(res.message).toMatch(/no units/i);
  });
});
