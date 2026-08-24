/**
 * Reusing a storyboard that has already been written.
 *
 * Authoring a storyboard is the expensive part of this server by a wide margin --
 * every module's description, activities, video script, slide deck, question bank
 * and glossary is written by a model reading the sources. The structure around it
 * is free. So generating the same subject's storyboard a second time spends nearly
 * all of that cost to arrive at nearly the same document.
 *
 * Everything needed to avoid that was already stored: state is versioned and
 * append-only, so no storyboard has ever been lost. What was missing is that
 * nothing offered it back -- the flow's only instruction was to build. This module
 * is the lookup that makes the offer possible, and the two answers it supports:
 *
 *   reuse     hand over the document already rendered from the saved content.
 *   generate  write a new one.
 *
 * A third answer -- re-render the saved content through the current template --
 * was offered for a while and has been removed. It sounded free, and it was, but
 * what it produced was a document built from whatever content happened to be in
 * the database, which is not the same thing as the document anyone had reviewed. A
 * storyboard worth handing over is one that was rendered deliberately; re-rendering
 * old state on request quietly turned stale content into a fresh-looking
 * deliverable. So there are two answers: the document that exists, or a new one.
 *
 * Which means a storyboard is only offered for reuse when its rendered file is
 * actually on disk. Delete the artifacts folder and the offer disappears by
 * itself, which is the behaviour you want from a cache.
 *
 * The FOLDER decides whether one exists, not the database. `data/` is gitignored
 * and local; `artifacts/` is committed and travels. A checkout on a second machine
 * therefore has the documents and none of the rows describing them, and a check
 * that consulted the database reported "nothing built yet" for a subject whose
 * finished storyboard was in the folder beside it -- then regenerated a document
 * that had already been delivered. So existence is a question about disk, and the
 * database answers the narrower question of what is known about what was found.
 *
 * A document with no local record is still handed over. What it cannot do is be
 * extended: submitting a module needs the state the database holds. That is a real
 * difference and it is reported rather than hidden.
 */

import { existsSync } from 'node:fs';
import {
  getArtifact,
  getState,
  listVersions,
  type ArtifactRecord,
} from '../storage/artifact-store.js';
import { listStoryboardDocuments, type StoryboardDocument } from './documents.js';
import {
  compareSourceFingerprint,
  computeSourceFingerprint,
  describeVerdict,
  type FingerprintVerdict,
  type SourceFingerprint,
} from '../storage/source-fingerprint.js';
import { nextModule } from './module-batch.js';

export interface ReusableStoryboard {
  course_id: string;
  /**
   * The rendered document being offered. Never absent: existence is decided by
   * finding this file, so there is no state in which this describes an offer that
   * cannot be honoured.
   */
  docx_path: string;
  filename: string;
  /** When it was rendered, from its filename where that carries a timestamp. */
  rendered_at: string;
  /**
   * True when this machine's database holds the storyboard behind the document.
   *
   * False for a document that arrived with a checkout: it can be handed over, but
   * not extended, because submitting a module needs state this machine does not
   * have. Everything below that depends on the database is absent in that case.
   */
  known_locally: boolean;
  /** From the filename, so present even when the database is not. */
  artifact_id?: string;
  version?: number;
  /** Database-only: when the storyboard's content was created and last committed. */
  created_at?: string;
  updated_at?: string;
  /** Database-only: how many modules it holds. */
  module_count?: number;
  /** Whether the sources have moved since it was written. Unknown without a record. */
  verdict: FingerprintVerdict;
  /** One line describing the verdict, for a client to show as-is. */
  verdict_summary: string;
}

function storedFingerprint(artifact: ArtifactRecord): SourceFingerprint | undefined {
  if (!artifact.source_fingerprint) return undefined;
  try {
    return JSON.parse(artifact.source_fingerprint) as SourceFingerprint;
  } catch {
    // A fingerprint that will not parse is no worse than one that is absent: both
    // mean nothing can be asserted, which is what 'unknown' reports.
    return undefined;
  }
}


/**
 * True when every field of every module has been written.
 *
 * Read from the state rather than from the artifact's `status` column, because
 * that column is written once at creation and never advanced -- completeness has
 * always been computed on demand by the build loop, and duplicating it into a
 * column that could disagree would be worse than computing it again here.
 */
function isComplete(artifactId: string): boolean {
  try {
    return nextModule(getState(artifactId)).complete;
  } catch {
    return false;
  }
}

/**
 * The storyboard that would be offered for reuse, if there is one.
 *
 * The most recent *complete* storyboard for the course *that has a rendered
 * document still on disk*. All three conditions matter, and the third is easy to
 * get wrong: an earlier version of this took the newest complete storyboard and
 * then looked for its document, so building a subject a second time and not
 * rendering it withdrew the offer of the first one -- a perfectly good delivered
 * document became unreachable because something newer existed on paper only. The
 * newest *offerable* one is the answer, not the newest one.
 *
 * Incomplete drafts are not offered either: half a storyboard is not a
 * deliverable, and resuming one is what the build loop already does when handed
 * its artifact_id.
 *
 * Recency is the artifact's own `updated_at`, which moves when content is
 * committed and not when a document is rendered -- so "most recent" means the
 * newest *content*, which is what someone asking for a subject's storyboard means.
 * Only one is offered rather than a list; `list_storyboards` has the full history
 * for anyone who wants an older one.
 */
/** The artifact behind a document, when this machine has a record of it. */
function recordFor(document: StoryboardDocument): ArtifactRecord | undefined {
  if (!document.artifact_id) return undefined;
  try {
    return getArtifact(document.artifact_id);
  } catch {
    // The name says which artifact it came from; this database has never seen it.
    return undefined;
  }
}

/**
 * Describes one document on disk, enriched from the database where possible.
 *
 * Returns undefined only for a document the database knows to be an incomplete
 * draft: half a storyboard is not a deliverable, and one can only be rendered by
 * explicitly allowing an invalid render. Everything else is offerable, including a
 * document this machine has no record of at all.
 */
function describeDocument(
  courseId: string,
  templateVersion: string,
  document: StoryboardDocument,
): ReusableStoryboard | undefined {
  const record = recordFor(document);

  if (!record) {
    // Present but unrecorded here -- typically a checkout on another machine.
    // Offered anyway: it is a finished document, and refusing it would put us back
    // to regenerating something already delivered.
    const verdict: FingerprintVerdict = {
      state: 'unknown',
      reason:
        'This machine has no record of how this storyboard was built, so whether its sources ' +
        'have changed since cannot be established. The document itself is complete and can be ' +
        'handed over; it cannot be edited module by module here, because that needs the ' +
        'storyboard state, which lives in the database rather than in the document.',
    };
    return {
      course_id: courseId,
      docx_path: document.docx_path,
      filename: document.filename,
      rendered_at: document.rendered_at,
      known_locally: false,
      ...(document.artifact_id ? { artifact_id: document.artifact_id } : {}),
      ...(document.version !== undefined ? { version: document.version } : {}),
      verdict,
      // Not describeVerdict: its 'unknown' wording blames an artifact predating the
      // fingerprint check, and the reason here is different and worth saying
      // accurately -- the document is fine, this machine simply has no record.
      verdict_summary: 'no local record of how it was built, so its sources cannot be verified',
    };
  }

  if (!isComplete(record.artifact_id)) return undefined;

  const verdict = compareSourceFingerprint(
    storedFingerprint(record),
    computeSourceFingerprint(courseId, templateVersion),
  );
  return {
    course_id: courseId,
    docx_path: document.docx_path,
    filename: document.filename,
    rendered_at: document.rendered_at,
    known_locally: true,
    artifact_id: record.artifact_id,
    version: record.current_version,
    created_at: record.created_at,
    updated_at: record.updated_at,
    module_count: getState(record.artifact_id).modules.length,
    verdict,
    verdict_summary: describeVerdict(verdict),
  };
}

/**
 * How many previous storyboards a subject offers back.
 *
 * A subject accumulates documents and every one of them is a real deliverable, so
 * they are all offered -- but not all at once past a point. A numbered list is a
 * question the user has to read, and thirty numbered lines is not a better question
 * than five plus "generate a new one". The older ones stay reachable through
 * `list_storyboards` and the folder itself.
 */
export const MAX_REUSE_OPTIONS = 5;

/**
 * Every storyboard this subject can be handed, newest first.
 *
 * Ordered by the document rather than the artifact: that is the only signal
 * available with no database, and it is also the better question, since the newest
 * rendered document is the one most recently produced as a deliverable whatever
 * order the content behind it was written in.
 */
export function listReusableStoryboards(
  courseId: string,
  templateVersion: string,
): ReusableStoryboard[] {
  const out: ReusableStoryboard[] = [];
  for (const document of listStoryboardDocuments(courseId)) {
    const described = describeDocument(courseId, templateVersion, document);
    if (described) out.push(described);
  }
  return out;
}

/** The newest one, for callers that only need to know whether any exists. */
export function findReusableStoryboard(
  courseId: string,
  templateVersion: string,
): ReusableStoryboard | undefined {
  return listReusableStoryboards(courseId, templateVersion)[0];
}

/**
 * The existing storyboard, in one phrase, for a prompt or a tool message.
 *
 * Every part of it is optional except the render date, because a document that
 * arrived with a checkout has a filename and nothing else. Built here rather than
 * at each call site so there is one answer to "what do we know about this?" instead
 * of three that drift.
 */
export function describeExisting(existing: ReusableStoryboard): string {
  const parts: string[] = [];
  if (existing.artifact_id) parts.push(existing.artifact_id);
  if (existing.module_count !== undefined) parts.push(`${existing.module_count} modules`);
  if (existing.created_at) {
    const built = existing.created_at.slice(0, 10);
    const rendered = existing.rendered_at.slice(0, 10);
    parts.push(built === rendered ? `built ${built}` : `built ${built}, rendered ${rendered}`);
  } else {
    parts.push(`rendered ${existing.rendered_at.slice(0, 10)}`);
  }
  parts.push(existing.verdict_summary);
  return parts.join(', ');
}

export interface ReuseOption {
  /**
   * "reuse:1" for the first storyboard listed, "generate" for a new one.
   *
   * Positional rather than an artifact id, because a document whose filename
   * carries no id still has to be selectable, and because the number the user is
   * shown should be the number they can type back.
   */
  value: `reuse:${number}` | 'generate';
  label: string;
  detail: string;
}

/**
 * The choices to put to the user, given what exists.
 *
 * `existing` is already an offerable storyboard or nothing at all -- the lookup
 * does not return content it has no document for -- so there is no case here where
 * "use the existing one" is offered and then cannot be honoured.
 *
 * The detail names its artifact id and both dates. A course can hold several
 * storyboards, this offers the newest, and someone who expected a different one
 * needs to be able to see which they are being given rather than infer it.
 */
/** "2026-08-24 14:32" -- the date and the time, which is what tells two apart. */
export function renderedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/**
 * What one listed storyboard says beneath its label.
 *
 * The label already carries the artifact id and the moment it was rendered, so this
 * adds only what those do not: how big it is, when its content was written if that
 * differs from when it was rendered, and whether its sources still match. Said
 * once each -- an option the reader has to parse twice is an option they will pick
 * by position instead of by content.
 */
function optionDetail(e: ReusableStoryboard): string {
  if (!e.known_locally) {
    return (
      'No local record of how this was built, so its sources cannot be verified and it cannot ' +
      'be edited module by module here. Hands over the document as it is. No generation.'
    );
  }

  const parts: string[] = [];
  if (e.module_count !== undefined) parts.push(`${e.module_count} modules`);
  if (e.created_at && e.created_at.slice(0, 10) !== e.rendered_at.slice(0, 10)) {
    parts.push(`content written ${e.created_at.slice(0, 10)}`);
  }
  parts.push(e.verdict_summary);
  return `${parts.join(', ')}. Hands over this document. No generation.`;
}

/**
 * The choices to put to the user: every storyboard this subject has, then
 * generating a new one.
 *
 * All of them rather than only the newest, because "the newest" is a guess about
 * which one the user means and the list is not. Each carries its own date and time,
 * since two storyboards of the same subject are told apart by when they were made
 * and by nothing else a user can see.
 *
 * The option values are positional -- reuse:1, reuse:2 -- so that the number the
 * user types is the number they were shown. Matching on artifact id alone would
 * break for a document whose filename carries none.
 */
export function reuseOptions(existing: readonly ReusableStoryboard[]): ReuseOption[] {
  if (existing.length === 0) {
    return [
      {
        value: 'generate',
        label: 'Generate the storyboard',
        detail: 'No storyboard has been built for this subject yet.',
      },
    ];
  }

  const shown = existing.slice(0, MAX_REUSE_OPTIONS);
  const options: ReuseOption[] = shown.map((e, i) => ({
    value: `reuse:${i + 1}`,
    label: `${renderedLabel(e.rendered_at)}${e.artifact_id ? ` - ${e.artifact_id}` : ''}`,
    // The detail says only what the label does not. Repeating the id and the date
    // under a label that already carries both made three options read as three
    // paragraphs, which is harder to choose between than three lines.
    detail: optionDetail(e),
  }));

  const anyStale = shown.some((e) => e.verdict.state === 'changed');
  const hidden = existing.length - shown.length;

  options.push({
    value: 'generate',
    label: 'Generate a new storyboard from scratch',
    detail:
      (anyStale
        ? 'The source documents have changed since these were written. '
        : '') +
      'Writes a new one. Everything above is kept either way.' +
      (hidden > 0
        ? ` (${hidden} older storyboard${hidden === 1 ? '' : 's'} not listed; list_storyboards has the full history.)`
        : ''),
  });

  return options;
}

/**
 * Resolves what the user said into one of the options.
 *
 * Accepts the position they were shown, the option value, or an artifact id --
 * which is on screen, so someone will type it. Returns undefined rather than
 * guessing: picking the wrong storyboard hands over the wrong document, and
 * re-asking costs nothing.
 */
export function matchReuseAnswer(
  choice: string,
  existing: readonly ReusableStoryboard[],
): { kind: 'reuse'; storyboard: ReusableStoryboard } | { kind: 'generate' } | undefined {
  const shown = existing.slice(0, MAX_REUSE_OPTIONS);
  const raw = choice.trim();
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (key.length === 0) return undefined;

  const generateWords = new Set([
    'generate',
    'generatenew',
    'fresh',
    'scratch',
    'fromscratch',
    'regenerate',
    'rebuild',
  ]);
  if (generateWords.has(key)) return { kind: 'generate' };

  // "reuse:2", or a bare position. Generation is the last line, so its number is
  // one past the documents.
  const positional = /^reuse:?(\d+)$/.exec(key) ?? /^(\d+)$/.exec(key);
  if (positional) {
    const n = Number(positional[1]);
    if (n >= 1 && n <= shown.length) return { kind: 'reuse', storyboard: shown[n - 1]! };
    if (n === shown.length + 1) return { kind: 'generate' };
    return undefined;
  }

  // An artifact id as printed, in any punctuation.
  const byId = shown.filter((e) => e.artifact_id && e.artifact_id.toLowerCase().replace(/[^a-z0-9]+/g, '') === key);
  if (byId.length === 1) return { kind: 'reuse', storyboard: byId[0]! };

  // Words meaning "the existing one" are only unambiguous when there is one.
  const reuseWords = new Set(['reuse', 'use', 'useit', 'useexisting', 'existing', 'existingone', 'saved', 'already', 'alreadygenerated', 'latest', 'newest']);
  if (reuseWords.has(key) && shown.length >= 1) return { kind: 'reuse', storyboard: shown[0]! };

  return undefined;
}
