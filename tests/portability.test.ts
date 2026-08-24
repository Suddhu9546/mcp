/**
 * A storyboard already built is found on any machine, not just the one that built it.
 *
 * `data/` is gitignored and `artifacts/` is committed, so a checkout elsewhere has
 * the documents and none of the database rows that describe them. A reuse check
 * that consulted the database reported "nothing built yet" for a subject whose
 * finished storyboard was in the folder beside it, and regenerated a document that
 * had already been delivered -- a hundred-plus model calls to reproduce a file
 * that was right there.
 *
 * These tests run against an empty database on purpose. That is the second
 * machine, and the property is that it behaves like the first one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runTool } from '../src/mcp/tools/index.js';
import { config } from '../src/util/config.js';
import {
  MAX_REUSE_OPTIONS,
  findReusableStoryboard,
  listReusableStoryboards,
  matchReuseAnswer,
  reuseOptions,
} from '../src/storyboard/reuse.js';
import { listStoryboardDocuments } from '../src/storyboard/documents.js';
import { templateTrackFor } from '../src/courses/course-config.js';

function json(result: Awaited<ReturnType<typeof runTool>>): any {
  return { ...JSON.parse(result.content[0]!.text), __isError: result.isError === true };
}
const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> =>
  json(await runTool(name, args));

// A course nothing else in the suite builds, so its folder holds only what this
// file puts there and the database never learns about it.
const COURSE = 'ghg';
const DIR = path.join(config.paths.artifacts, COURSE);

/** A document as it arrives from a checkout: a real file, no database row. */
function placeDocument(filename: string): string {
  mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, filename);
  // Contents are irrelevant: nothing reads them, and a checkout could hold any
  // valid .docx. What is under test is whether the file is found at all.
  writeFileSync(file, Buffer.from('PK not-a-real-docx'));
  return file;
}

describe('a storyboard document that arrived with a checkout', () => {
  // Cleared before every case, not once: these tests place files, and a case that
  // inherited the previous one's documents would pass or fail on how many happened
  // to be left behind rather than on what it put there.
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('is not offered when the folder is empty', () => {
    expect(listStoryboardDocuments(COURSE)).toEqual([]);
    expect(findReusableStoryboard(COURSE, templateTrackFor(COURSE))).toBeUndefined();
    // Which is the whole point of the empty case: generation starts, unprompted.
    expect(reuseOptions([]).map((o) => o.value)).toEqual(['generate']);
  });

  it('is found from the filename alone, with no database row', () => {
    placeDocument(`${COURSE}-storyboard-SB-2026-09999-v7-20260401-131415.docx`);

    const existing = findReusableStoryboard(COURSE, templateTrackFor(COURSE));
    expect(existing).toBeDefined();
    expect(existing!.artifact_id).toBe('SB-2026-09999');
    expect(existing!.version).toBe(7);
    expect(existing!.rendered_at.slice(0, 10)).toBe('2026-04-01');

    // The database has never seen it, and that is reported rather than hidden:
    // it can be handed over, but not extended module by module.
    expect(existing!.known_locally).toBe(false);
    expect(existing!.module_count).toBeUndefined();
    expect(existing!.verdict.state).toBe('unknown');
    expect(existing!.verdict_summary).toMatch(/no local record/);

    const options = reuseOptions([existing!]);
    expect(options.map((o) => o.value)).toEqual(['reuse:1', 'generate']);
    // The limitation is stated once, in the words the reader sees.
    expect(options[0]!.detail).toMatch(/No local record/);
    expect(options[0]!.detail).toMatch(/cannot be edited module by module/);
  });

  it('is offered by the flow, so the second machine asks the same question', async () => {
    placeDocument(`${COURSE}-storyboard-SB-2026-09999-v7-20260401-131415.docx`);

    const menu = await call('start_flow');
    const session = menu.session_id;
    await call('flow_choose', { session_id: session, choice: 'storyboard' });
    await call('flow_choose', { session_id: session, choice: 'orientation' });
    const step = await call('flow_choose', { session_id: session, choice: COURSE });

    expect(step.step).toBe('choose_storyboard_source');
    expect(step.options.map((o: any) => o.value)).toEqual(['reuse:1', 'generate']);
    expect(step.data.existing).toHaveLength(1);
    expect(step.data.existing[0].known_locally).toBe(false);
    expect(existsSync(step.data.existing[0].docx_path)).toBe(true);
  }, 300_000);

  it('stops a client that skips the flow entirely', async () => {
    placeDocument(`${COURSE}-storyboard-SB-2026-09999-v7-20260401-131415.docx`);

    const res = await call('create_storyboard_draft', { course_id: COURSE });
    expect(res.__isError).toBe(false);
    expect(res.status).toBe('ALREADY_EXISTS');
    expect(res.artifact_id).toBe('SB-2026-09999');
    expect(res.known_locally).toBe(false);
    expect(existsSync(res.docx_path)).toBe(true);
    expect(res.message).toMatch(/No\s+draft was created/);
  }, 300_000);

  it('puts the newest document first', () => {
    placeDocument(`${COURSE}-storyboard-SB-2026-09990-v3-20260101-090000.docx`);
    placeDocument(`${COURSE}-storyboard-SB-2026-09995-v5-20260615-170000.docx`);
    placeDocument(`${COURSE}-storyboard-SB-2026-09991-v4-20260301-120000.docx`);

    const documents = listStoryboardDocuments(COURSE);
    expect(documents[0]!.artifact_id).toBe('SB-2026-09995');
    expect(findReusableStoryboard(COURSE, templateTrackFor(COURSE))!.artifact_id).toBe('SB-2026-09995');
  });

  it('lists every storyboard as its own numbered option, newest first', () => {
    // A subject accumulates storyboards and each one is a real deliverable, so
    // each gets a line. Offering only the newest is a guess about which one the
    // user means; a numbered list is not.
    placeDocument(`${COURSE}-storyboard-SB-2026-09990-v3-20260101-090000.docx`);
    placeDocument(`${COURSE}-storyboard-SB-2026-09995-v5-20260615-170000.docx`);
    placeDocument(`${COURSE}-storyboard-SB-2026-09991-v4-20260301-120000.docx`);

    const listed = listReusableStoryboards(COURSE, templateTrackFor(COURSE));
    expect(listed.map((e) => e.artifact_id)).toEqual([
      'SB-2026-09995',
      'SB-2026-09991',
      'SB-2026-09990',
    ]);

    const options = reuseOptions(listed);
    expect(options.map((o) => o.value)).toEqual(['reuse:1', 'reuse:2', 'reuse:3', 'generate']);

    // Each label carries the date AND the time, which is the only thing telling
    // two storyboards of one subject apart.
    expect(options[0]!.label).toBe('2026-06-15 17:00 - SB-2026-09995');
    expect(options[1]!.label).toBe('2026-03-01 12:00 - SB-2026-09991');
    expect(options[2]!.label).toBe('2026-01-01 09:00 - SB-2026-09990');
  });

  it('resolves the answer by position, so the number shown is the number typed', () => {
    placeDocument(`${COURSE}-storyboard-SB-2026-09990-v3-20260101-090000.docx`);
    placeDocument(`${COURSE}-storyboard-SB-2026-09995-v5-20260615-170000.docx`);
    placeDocument(`${COURSE}-storyboard-SB-2026-09991-v4-20260301-120000.docx`);

    const listed = listReusableStoryboards(COURSE, templateTrackFor(COURSE));

    const pick = (answer: string): string => {
      const m = matchReuseAnswer(answer, listed);
      if (!m) return '(unrecognised)';
      return m.kind === 'generate' ? 'generate' : m.storyboard.artifact_id!;
    };

    expect(pick('1')).toBe('SB-2026-09995');
    expect(pick('2')).toBe('SB-2026-09991');
    expect(pick('3')).toBe('SB-2026-09990');
    // Generation is the line after the documents.
    expect(pick('4')).toBe('generate');
    expect(pick('generate')).toBe('generate');
    // An artifact id is on screen, so somebody will type it.
    expect(pick('SB-2026-09991')).toBe('SB-2026-09991');
    expect(pick('sb 2026 09990')).toBe('SB-2026-09990');
    // Out of range and nonsense are re-asked rather than guessed at.
    expect(pick('5')).toBe('(unrecognised)');
    expect(pick('0')).toBe('(unrecognised)');
    expect(pick('the middle one')).toBe('(unrecognised)');
  });

  it('hands over the storyboard the user picked, not the newest', async () => {
    placeDocument(`${COURSE}-storyboard-SB-2026-09990-v3-20260101-090000.docx`);
    placeDocument(`${COURSE}-storyboard-SB-2026-09995-v5-20260615-170000.docx`);
    placeDocument(`${COURSE}-storyboard-SB-2026-09991-v4-20260301-120000.docx`);

    const menu = await call('start_flow');
    const session = menu.session_id;
    await call('flow_choose', { session_id: session, choice: 'storyboard' });
    await call('flow_choose', { session_id: session, choice: 'orientation' });
    const step = await call('flow_choose', { session_id: session, choice: COURSE });
    expect(step.data.existing).toHaveLength(3);

    // The second line, which is deliberately not the newest.
    const done = await call('flow_choose', { session_id: session, choice: '2' });
    expect(done.step).toBe('storyboard_ready');
    expect(done.done).toBe(true);
    expect(done.data.source).toBe('saved');
    expect(done.data.artifact_id).toBe('SB-2026-09991');
    expect(done.data.docx_path).toContain('SB-2026-09991');
    expect(existsSync(done.data.docx_path)).toBe(true);
  }, 300_000);

  it('caps the list and says how many it did not show', () => {
    for (let i = 1; i <= MAX_REUSE_OPTIONS + 2; i++) {
      const day = String(i).padStart(2, '0');
      placeDocument(`${COURSE}-storyboard-SB-2026-0900${i}-v1-202601${day}-100000.docx`);
    }

    const listed = listReusableStoryboards(COURSE, templateTrackFor(COURSE));
    expect(listed.length).toBe(MAX_REUSE_OPTIONS + 2);

    const options = reuseOptions(listed);
    // One line per shown storyboard, plus generation.
    expect(options).toHaveLength(MAX_REUSE_OPTIONS + 1);
    // Silently dropping the rest would read as "these are all of them".
    expect(options[options.length - 1]!.detail).toMatch(/2 older storyboards not listed/);
  });

  it('still offers a document whose name carries no artifact id', () => {
    // The old naming, or a file somebody renamed. It is no less delivered, so it
    // is dated by its mtime and offered -- with the weaker evidence declared.
    placeDocument(`${COURSE}-storyboard.docx`);

    const documents = listStoryboardDocuments(COURSE);
    const legacy = documents.find((d) => d.filename === `${COURSE}-storyboard.docx`)!;
    expect(legacy.artifact_id).toBeUndefined();
    expect(legacy.timestamp_from_name).toBe(false);

    // An mtime is "now", so it sorts newest and is what gets offered.
    const existing = findReusableStoryboard(COURSE, templateTrackFor(COURSE));
    expect(existing).toBeDefined();
    expect(existing!.known_locally).toBe(false);
  });

  it('ignores Word lock files and non-documents', () => {
    placeDocument(`${COURSE}-storyboard-SB-2026-09999-v7-20260401-131415.docx`);
    writeFileSync(path.join(DIR, `~$${COURSE}-storyboard.docx`), 'lock');
    writeFileSync(path.join(DIR, 'notes.txt'), 'not a storyboard');

    const names = listStoryboardDocuments(COURSE).map((d) => d.filename);
    expect(names).not.toContain(`~$${COURSE}-storyboard.docx`);
    expect(names).not.toContain('notes.txt');
    expect(names).toContain(`${COURSE}-storyboard-SB-2026-09999-v7-20260401-131415.docx`);
  });
});
