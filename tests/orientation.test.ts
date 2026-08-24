/**
 * The Orientation programme's own rules.
 *
 * Orientation differs from Entrepreneur in three ways that nothing else in the
 * server can check for itself, so they are checked here:
 *
 *   Timing is a programme constant, not a document. There is no timing.pdf for any
 *   Orientation subject, and there must never be a need for one: three modules of
 *   one hour, Part A 30 minutes, Parts B and C fifteen each, for every subject.
 *
 *   Three modules regardless of the handbook. The four subjects have three, four,
 *   five and six chapters, so the clubbing rule is exercised by all four of its
 *   cases at once.
 *
 *   The same template as Entrepreneur. The programmes differ in what goes into a
 *   storyboard and not in how it looks, so both render from one file.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeAll } from 'vitest';
import { runTool } from '../src/mcp/tools/index.js';
import { buildStoryboard } from './helpers/build-storyboard.js';
import { groupChaptersIntoModules, getCourseConfig } from '../src/courses/course-config.js';
import { buildOrientationAllocation } from '../src/timing/orientation-allocation.js';
import { withValidatedArithmetic } from '../src/timing/timing-validator.js';

const SUBJECTS = ['esg', 'ghg', 'green-logistics', 'biogas'] as const;

function json(result: Awaited<ReturnType<typeof runTool>>): any {
  return { ...JSON.parse(result.content[0]!.text), __isError: result.isError === true };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return json(await runTool(name, args));
}

describe('Orientation chapter clubbing', () => {
  // The four cases the programme actually has, stated as the user stated them.
  it('clubs chapters into exactly three modules', () => {
    expect(groupChaptersIntoModules(3)).toEqual([[1], [2], [3]]);
    expect(groupChaptersIntoModules(4)).toEqual([[1, 2], [3], [4]]);
    expect(groupChaptersIntoModules(5)).toEqual([[1, 2], [3, 4], [5]]);
    expect(groupChaptersIntoModules(6)).toEqual([[1, 2], [3, 4], [5, 6]]);
  });

  it('keeps the rule total and contiguous beyond the cases that exist today', () => {
    for (let n = 3; n <= 12; n++) {
      const groups = groupChaptersIntoModules(n);
      expect(groups).toHaveLength(3);
      // Every chapter appears exactly once, in order, with no gaps.
      expect(groups.flat()).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      // Sizes never differ by more than one, and never grow later in the course.
      const sizes = groups.map((g) => g.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    }
  });

  it('refuses a handbook with too few chapters rather than inventing a module', () => {
    expect(() => groupChaptersIntoModules(2)).toThrow(/at least 3 handbook chapters/);
  });
});

describe('Orientation course registration', () => {
  it.each(SUBJECTS)('declares no Timing Allocation Document for %s', (id) => {
    const types = getCourseConfig(id).documents.map((d) => d.document_type);
    expect(types).toEqual(['QP', 'PH', 'FG']);
    expect(types).not.toContain('TIMING');
  });

  it.each(SUBJECTS)('gives %s exactly three modules with a clubbed chapter set', (id) => {
    const course = getCourseConfig(id);
    expect(course.track).toBe('orientation');
    expect(course.crosswalk).toHaveLength(3);

    const chapterCount = Object.keys(course.chapter_titles).length;
    const expected = groupChaptersIntoModules(chapterCount);
    expect(course.crosswalk.map((c) => c.source_chapters ?? [c.source_chapter])).toEqual(expected);

    // The first chapter of the group stays readable as the single-chapter answer.
    for (const entry of course.crosswalk) {
      expect(entry.source_chapter).toBe((entry.source_chapters ?? [entry.source_chapter])[0]);
    }
  });
});

describe('Orientation timing', () => {
  beforeAll(async () => {
    for (const id of SUBJECTS) {
      const ingested = await call('ingest_course_documents', { course_id: id });
      expect(ingested.__isError).toBe(false);
    }
  }, 600_000);

  it.each(SUBJECTS)('gives %s three one-hour modules, 3 hours in total', (id) => {
    const alloc = withValidatedArithmetic(buildOrientationAllocation(id));

    expect(alloc.modules).toHaveLength(3);
    expect(alloc.stated_total_minutes).toBe(180);
    expect(alloc.stated_total_hours).toBe(3);
    expect(alloc.arithmetic.course_total_ok).toBe(true);
    expect(alloc.arithmetic.all_modules_ok).toBe(true);

    for (const m of alloc.modules) {
      expect(m.minutes).toBe(60);
      // Part A rows sum to the module, which is what the arithmetic check needs.
      expect(m.units.reduce((a, u) => a + u.minutes, 0)).toBe(60);
      expect(m.units.length).toBeGreaterThan(0);
      expect(m.units.length).toBeLessThanOrEqual(3);
      // Every Part A row names the handbook units it covers, and none of those
      // labels is a stray page number left by PDF extraction.
      for (const u of m.units) {
        expect(u.sub_topics.length).toBeGreaterThan(0);
        expect(u.title).toMatch(/[a-z]/i);
        expect(u.title).not.toMatch(/^\d+$/);
      }
    }
  });

  it('is identical across subjects, which is the point of a programme constant', () => {
    const shapes = SUBJECTS.map((id) => {
      const alloc = buildOrientationAllocation(id);
      return JSON.stringify({
        total: alloc.stated_total_minutes,
        modules: alloc.modules.map((m) => m.minutes),
      });
    });
    expect(new Set(shapes).size).toBe(1);
  });

  it('refuses to apply the programme constant to an Entrepreneur course', () => {
    expect(() => buildOrientationAllocation('biofuels')).toThrow(/Only Orientation courses/);
  });
});

describe('Orientation storyboard', () => {
  beforeAll(async () => {
    const ingested = await call('ingest_course_documents', { course_id: 'biogas' });
    expect(ingested.__isError).toBe(false);
  }, 300_000);

  it('reaches Orientation as the second programme of the storyboard flow', async () => {
    const menu = await call('start_flow');
    let step = await call('flow_choose', { session_id: menu.session_id, choice: 'storyboard' });
    step = await call('flow_choose', { session_id: menu.session_id, choice: 'orientation' });
    expect(step.options.map((o: any) => o.value)).toEqual(
      expect.arrayContaining([...SUBJECTS]),
    );

    step = await call('flow_choose', { session_id: menu.session_id, choice: 'biogas' });
    if (step.step === 'choose_storyboard_source') {
      step = await call('flow_choose', { session_id: menu.session_id, choice: 'generate' });
    }
    expect(step.step).toBe('storyboard_ready');
    expect(step.done).toBe(true);
    expect(step.data.course_id).toBe('biogas');
  });

  it('builds and renders a complete storyboard with the Entrepreneur template', async () => {
    const built = await buildStoryboard(call, 'biogas');

    expect(built.modules).toBe(3);
    expect(built.calls).toBe(built.modules + 1);
    expect(built.final.status).toBe('READY_TO_RENDER');
    expect(built.final.progress.fields_remaining).toBe(0);

    const draft = await call('get_storyboard', { artifact_id: built.artifactId });
    expect(draft.__isError).toBe(false);
    // Both programmes render from templates/entrepreneur/, so that the colours,
    // fonts and sizes cannot drift apart.
    expect(draft.template_version ?? draft.state?.template_version).toBe('entrepreneur');

    const state = draft.state ?? draft;
    for (const m of state.modules) {
      expect(m.duration.minutes).toBe(60);
      expect(m.part_a.rows.reduce((a: number, r: any) => a + r.duration.minutes, 0)).toBe(30);
      expect(m.part_b.duration_minutes).toBe(15);
      expect(m.part_c.duration_minutes).toBe(15);
      expect(m.part_a.header_label).toContain('0.5 hours');
    }

    const rendered = await call('render_storyboard_docx', { artifact_id: built.artifactId });
    expect(rendered.__isError).toBe(false);
  }, 300_000);
});
