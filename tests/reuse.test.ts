/**
 * Reusing a storyboard instead of paying to write it again.
 *
 * The property under test is a cost one, which makes it easy to break without
 * noticing: every part of a regenerated storyboard is individually correct, so
 * nothing fails when the server rebuilds a subject it had already done. Only the
 * bill changes. Hence the assertions here are about *what was not called*.
 *
 * The second property is trust. A stored citation is a position in a document --
 * `<course>:<doc>:p<page>:<ordinal>` -- not a handle on a piece of text, so a
 * re-ingested handbook can leave a saved storyboard citing the wrong paragraph
 * while every id still resolves. Reuse is only safe if that is detectable, so the
 * fingerprint is tested against an actual re-ingestion rather than a mocked one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { runTool } from '../src/mcp/tools/index.js';
import { buildStoryboard } from './helpers/build-storyboard.js';
import {
  findReusableStoryboard,
  listReusableStoryboards,
  matchReuseAnswer,
  renderedLabel,
  reuseOptions,
} from '../src/storyboard/reuse.js';
import {
  compareSourceFingerprint,
  computeSourceFingerprint,
} from '../src/storage/source-fingerprint.js';
import { templateTrackFor } from '../src/courses/course-config.js';
import { getArtifact } from '../src/storage/artifact-store.js';

const COURSE = 'biogas';

function json(result: Awaited<ReturnType<typeof runTool>>): any {
  return { ...JSON.parse(result.content[0]!.text), __isError: result.isError === true };
}
const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> =>
  json(await runTool(name, args));

describe('source fingerprint', () => {
  beforeAll(async () => {
    expect((await call('ingest_course_documents', { course_id: COURSE })).__isError).toBe(false);
  }, 300_000);

  it('is stable across repeated computation over an unchanged index', () => {
    const a = computeSourceFingerprint(COURSE, 'entrepreneur');
    const b = computeSourceFingerprint(COURSE, 'entrepreneur');
    expect(b.digest).toBe(a.digest);
    expect(compareSourceFingerprint(a, b)).toEqual({ state: 'unchanged' });
  });

  it('notices a template change without blaming the documents', () => {
    const built = computeSourceFingerprint(COURSE, 'entrepreneur');
    const now = computeSourceFingerprint(COURSE, 'some-other-template');
    const verdict = compareSourceFingerprint(built, now);

    expect(verdict.state).toBe('changed');
    if (verdict.state !== 'changed') throw new Error('unreachable');
    expect(verdict.changes).toHaveLength(1);
    expect(verdict.changes[0]).toMatch(/template changed/i);
    // The content is fine; only the rendering moved on.
    expect(verdict.changes[0]).toMatch(/content is unaffected/i);
  });

  it('notices a document whose indexed size changed', () => {
    const built = computeSourceFingerprint(COURSE, 'entrepreneur');
    const tampered = {
      ...built,
      digest: 'different',
      documents: built.documents.map((d) =>
        d.document_type === 'PH' ? { ...d, chunk_count: d.chunk_count - 5 } : d,
      ),
    };
    const verdict = compareSourceFingerprint(tampered, built);

    expect(verdict.state).toBe('changed');
    if (verdict.state !== 'changed') throw new Error('unreachable');
    expect(verdict.changes.join(' ')).toMatch(/PH was re-indexed/);
    expect(verdict.changes.join(' ')).toMatch(/may now point at different text/);
  });

  it('reports a renumbering that leaves every total identical', () => {
    // The silent case: same documents, same counts, different chunk ids. Nothing
    // downstream can see it, so it must be reported here or not at all.
    const built = computeSourceFingerprint(COURSE, 'entrepreneur');
    const renumbered = { ...built, digest: `${built.digest}-shifted` };
    const verdict = compareSourceFingerprint(renumbered, built);

    expect(verdict.state).toBe('changed');
    if (verdict.state !== 'changed') throw new Error('unreachable');
    expect(verdict.changes.join(' ')).toMatch(/chunk identifiers have changed/i);
  });

  it('says so plainly when an artifact predates fingerprinting', () => {
    const verdict = compareSourceFingerprint(undefined, computeSourceFingerprint(COURSE, 'entrepreneur'));
    expect(verdict.state).toBe('unknown');
  });
});

describe('finding a storyboard to reuse', () => {
  beforeAll(async () => {
    expect((await call('ingest_course_documents', { course_id: COURSE })).__isError).toBe(false);
  }, 300_000);

  it('offers only generation when nothing has been built', () => {
    const options = reuseOptions([]);
    expect(options.map((o) => o.value)).toEqual(['generate']);
  });

  it('offers the completed storyboard, with its sources confirmed unchanged', async () => {
    const built = await buildStoryboard(call, COURSE);
    const rendered = await call('render_storyboard_docx', { artifact_id: built.artifactId });
    expect(rendered.__isError).toBe(false);

    const existing = findReusableStoryboard(COURSE, templateTrackFor(COURSE));
    expect(existing).toBeDefined();
    expect(existing!.artifact_id).toBe(built.artifactId);
    expect(existing!.module_count).toBe(3);

    // The fingerprint was recorded at creation, so a build followed immediately by
    // a lookup must come back clean. If this fails the fingerprint is being
    // computed over something that moves on its own.
    expect(existing!.verdict.state).toBe('unchanged');
    expect(existing!.verdict_summary).toMatch(/unchanged/);

    // And the document it points at is really there.
    expect(existing!.docx_path).toBeDefined();
    expect(exististsOrFail(existing!.docx_path!)).toBe(true);

    const options = reuseOptions([existing!]);
    expect(options.map((o) => o.value)).toEqual(['reuse:1', 'generate']);
  }, 300_000);

  it('records the fingerprint on the artifact itself', async () => {
    const built = await buildStoryboard(call, COURSE);
    const artifact = getArtifact(built.artifactId);
    expect(artifact.source_fingerprint).toBeTruthy();
    const parsed = JSON.parse(artifact.source_fingerprint!);
    expect(parsed.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.template_version).toBe(templateTrackFor(COURSE));
  }, 300_000);

  it('lists both when a subject has two, newest first', async () => {
    // A subject accumulates storyboards and each is a real deliverable, so each is
    // offered. Order is by when the document was rendered, which is the only signal
    // available with no database and is also the better question.
    const older = await buildStoryboard(call, COURSE);
    await call('render_storyboard_docx', { artifact_id: older.artifactId });

    const newer = await buildStoryboard(call, COURSE);
    await call('render_storyboard_docx', { artifact_id: newer.artifactId });

    const existing = findReusableStoryboard(COURSE, templateTrackFor(COURSE));
    expect(existing!.artifact_id).toBe(newer.artifactId);
    expect(existing!.artifact_id).not.toBe(older.artifactId);
    // Both are listed, newest first, and the label carries the id and the moment.
    const all = listReusableStoryboards(COURSE, templateTrackFor(COURSE));
    expect(all[0]!.artifact_id).toBe(newer.artifactId);
    expect(all.map((e) => e.artifact_id)).toContain(older.artifactId);

    const options = reuseOptions(all);
    expect(options[0]!.label).toContain(newer.artifactId);
    expect(options[0]!.label).toContain(renderedLabel(all[0]!.rendered_at));
    // Generation is always the last line.
    expect(options[options.length - 1]!.value).toBe('generate');

    // Answering by position gives the one at that position.
    const picked = matchReuseAnswer('1', all);
    expect(picked?.kind).toBe('reuse');
    if (picked?.kind !== 'reuse') throw new Error('unreachable');
    expect(picked.storyboard.artifact_id).toBe(newer.artifactId);
  }, 600_000);

  it('falls back to an older storyboard when the newest has no document', async () => {
    // The regression this guards: the lookup used to take the newest complete
    // storyboard and *then* look for its document, so building a subject again
    // without rendering it withdrew the offer of the one before -- a delivered
    // document became unreachable because something newer existed on paper only.
    const rendered = await buildStoryboard(call, COURSE);
    await call('render_storyboard_docx', { artifact_id: rendered.artifactId });

    // Complete, newer, never rendered.
    const unrendered = await buildStoryboard(call, COURSE);
    expect(unrendered.final.status).toBe('READY_TO_RENDER');

    const existing = findReusableStoryboard(COURSE, templateTrackFor(COURSE));
    expect(existing).toBeDefined();
    expect(existing!.artifact_id).toBe(rendered.artifactId);
    expect(existing!.artifact_id).not.toBe(unrendered.artifactId);
    expect(existsSync(existing!.docx_path)).toBe(true);
  }, 600_000);

  it('never returns a storyboard whose document is missing', async () => {
    // Whatever comes back is offerable: the type says docx_path is present, and
    // the value must actually be on disk. Anything else offers the user a file
    // that cannot be handed over.
    const existing = findReusableStoryboard(COURSE, templateTrackFor(COURSE));
    if (existing) {
      expect(typeof existing.docx_path).toBe('string');
      expect(existsSync(existing.docx_path)).toBe(true);
      expect(existing.rendered_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
  }, 300_000);

  it('does not offer an unfinished draft', async () => {
    // A draft with no content is not a deliverable, and offering it as "already
    // generated" would be the worst of both outcomes.
    expect((await call('ingest_course_documents', { course_id: 'esg' })).__isError).toBe(false);
    const draft = await call('create_storyboard_draft', { course_id: 'esg' });
    expect(draft.__isError).toBe(false);

    const existing = findReusableStoryboard('esg', templateTrackFor('esg'));
    expect(existing?.artifact_id).not.toBe(draft.artifact_id);
  }, 300_000);
});

function exististsOrFail(p: string): boolean {
  return existsSync(p);
}

describe('the guard in create_storyboard_draft', () => {
  /**
   * The flow can be skipped, so the flow cannot be where this is enforced.
   *
   * A client reads the tool list, sees a tool named for creating a storyboard, and
   * calls it. Nothing about that is wrong -- it is the obvious thing to do -- and
   * every client that does it used to rebuild a subject that already had a
   * finished document, because the reuse question lived only in the conversational
   * flow. Tool-level enforcement is what makes the behaviour the same whichever
   * client is driving, which is the same property tests/model-independence covers
   * for the build loop.
   */
  beforeAll(async () => {
    expect((await call('ingest_course_documents', { course_id: COURSE })).__isError).toBe(false);
    const built = await buildStoryboard(call, COURSE);
    await call('render_storyboard_docx', { artifact_id: built.artifactId });
  }, 600_000);

  it('returns the existing storyboard instead of drafting a second one', async () => {
    const before = findReusableStoryboard(COURSE, templateTrackFor(COURSE))!;

    const res = await call('create_storyboard_draft', { course_id: COURSE });
    expect(res.__isError).toBe(false);
    expect(res.status).toBe('ALREADY_EXISTS');
    expect(res.artifact_id).toBe(before.artifact_id);
    expect(existsSync(res.docx_path)).toBe(true);
    expect(res.message).toMatch(/No draft was created/);
    expect(res.message).toMatch(/regenerate: true/);

    // And no draft was actually created: the newest storyboard is the same one.
    const after = findReusableStoryboard(COURSE, templateTrackFor(COURSE))!;
    expect(after.artifact_id).toBe(before.artifact_id);
  }, 300_000);

  it('builds a new one when regenerate is explicitly set', async () => {
    const before = findReusableStoryboard(COURSE, templateTrackFor(COURSE))!;

    const res = await call('create_storyboard_draft', { course_id: COURSE, regenerate: true });
    expect(res.__isError).toBe(false);
    expect(res.status).toBeUndefined();
    expect(res.artifact_id).toBeTruthy();
    expect(res.artifact_id).not.toBe(before.artifact_id);
  }, 300_000);

  it('refuses to draft over a supplied storyboard, whatever the flag says', async () => {
    // CDR's document was written outside this server and reviewed as a
    // deliverable. Generating one to sit beside it helps nobody, and regenerate
    // must not be a way round that -- there is no build path for this track at all.
    for (const args of [{ course_id: 'cdr-biochar' }, { course_id: 'cdr-biochar', regenerate: true }]) {
      const res = await call('create_storyboard_draft', args);
      expect(res.__isError, JSON.stringify(args)).toBe(false);
      expect(res.status, JSON.stringify(args)).toBe('SUPPLIED_STORYBOARD');
      expect(res.artifact_id, JSON.stringify(args)).toBeUndefined();
      expect(existsSync(res.docx_path)).toBe(true);
    }
  }, 300_000);

  it('drafts normally for a subject that has no storyboard yet', async () => {
    expect((await call('ingest_course_documents', { course_id: 'green-logistics' })).__isError).toBe(false);
    const res = await call('create_storyboard_draft', { course_id: 'green-logistics' });
    expect(res.__isError).toBe(false);
    expect(res.status).toBeUndefined();
    expect(res.artifact_id).toBeTruthy();
    expect(res.module_count).toBe(3);
  }, 300_000);
});

describe('the reuse question in the flow', () => {
  beforeAll(async () => {
    expect((await call('ingest_course_documents', { course_id: COURSE })).__isError).toBe(false);
    // Something to reuse must exist for any of this to be asked.
    const built = await buildStoryboard(call, COURSE);
    await call('render_storyboard_docx', { artifact_id: built.artifactId });
  }, 600_000);

  async function toSubject(): Promise<{ session: string; step: any }> {
    const menu = await call('start_flow');
    const session = menu.session_id;
    await call('flow_choose', { session_id: session, choice: 'storyboard' });
    await call('flow_choose', { session_id: session, choice: 'orientation' });
    const step = await call('flow_choose', { session_id: session, choice: COURSE });
    return { session, step };
  }

  it('asks before rebuilding a subject that already has one', async () => {
    const { step } = await toSubject();
    expect(step.step).toBe('choose_storyboard_source');
    expect(step.done).toBe(false);
    // One line per storyboard the subject has, then generation.
    const values = step.options.map((o: any) => o.value);
    expect(values[values.length - 1]).toBe('generate');
    expect(values.slice(0, -1).every((v: string) => /^reuse:\d+$/.test(v))).toBe(true);

    expect(step.data.existing.length).toBe(values.length - 1);
    expect(step.data.existing[0].module_count).toBe(3);
    expect(step.data.existing[0].sources_state).toBe('unchanged');
    expect(step.data.existing[0].option).toBe(1);
  }, 300_000);

  it('hands over the existing document without any generation', async () => {
    const { session } = await toSubject();
    const done = await call('flow_choose', { session_id: session, choice: '1' });

    expect(done.step).toBe('storyboard_ready');
    expect(done.done).toBe(true);
    expect(done.data.source).toBe('saved');
    expect(done.data.docx_path).toBeDefined();
    expect(existsSync(done.data.docx_path)).toBe(true);

    // The instruction must forbid the build loop, or a client will helpfully
    // rebuild the thing this choice exists to avoid.
    expect(done.next_action).toMatch(/Do NOT create a draft/);
    expect(done.next_action).toMatch(/do NOT run the build loop/);
  }, 300_000);

  it('offers no way to re-render saved content', async () => {
    // Re-rendering was offered for a while and was removed: it turned whatever
    // content happened to be in the database into a fresh-looking deliverable,
    // which is not the same as the document anyone reviewed. Two answers only.
    const { step } = await toSubject();
    expect(step.options.map((o: any) => o.value)).not.toContain('rerender');

    const { session } = await toSubject();
    const refused = await call('flow_choose', { session_id: session, choice: 'rerender' });
    expect(refused.step).toBe('choose_storyboard_source');
    expect(refused.done).toBe(false);
  }, 300_000);

  it('falls through to the build loop when the user wants a new one', async () => {
    const { session } = await toSubject();
    const done = await call('flow_choose', { session_id: session, choice: 'generate' });

    expect(done.step).toBe('storyboard_ready');
    expect(done.done).toBe(true);
    expect(done.data.course_id).toBe(COURSE);
    expect(done.next_action).toMatch(/create_storyboard_draft/);
    // The tool refuses by default now, so the flow must say so explicitly after
    // the user has declined the saved one -- otherwise its own guard would stop
    // the build it just agreed to.
    expect(done.next_action).toMatch(/regenerate: true/);
  }, 300_000);

  it('accepts the answer by number and by the words people use', async () => {
    // A position, and the words for "the one that exists" -- which mean the first
    // line, since that is what a list puts first.
    for (const answer of ['1', 'use it', 'existing', 'saved', 'reuse', 'latest'] as const) {
      const { session } = await toSubject();
      const done = await call('flow_choose', { session_id: session, choice: answer });
      expect(done.data?.source, answer).toBe('saved');
      expect(done.step, answer).toBe('storyboard_ready');
    }
    // Generation, by name. Not "new": that is a global command meaning restart,
    // handled before a step sees it. Its position depends on how many storyboards
    // are listed, so the name is what this asserts.
    for (const answer of ['generate', 'from scratch'] as const) {
      const { session } = await toSubject();
      const done = await call('flow_choose', { session_id: session, choice: answer });
      expect(done.data?.source, answer).toBeUndefined();
      expect(done.next_action, answer).toMatch(/create_storyboard_draft/);
    }
  }, 300_000);

  it('re-asks rather than guessing at an answer it does not recognise', async () => {
    const { session } = await toSubject();
    const again = await call('flow_choose', { session_id: session, choice: 'maybe the second one?' });
    expect(again.step).toBe('choose_storyboard_source');
    expect(again.done).toBe(false);
    expect(again.error ?? again.prompt).toMatch(/not one of the options|Use it, or generate/);
  }, 300_000);

  it('goes back from the reuse question to the subject list', async () => {
    const { session } = await toSubject();
    const back = await call('flow_choose', { session_id: session, choice: 'back' });
    expect(back.step).toBe('choose_subject');
  }, 300_000);
});
