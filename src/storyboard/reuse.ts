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
 */

import { existsSync } from 'node:fs';
import { getState, listArtifacts, listVersions, type ArtifactRecord } from '../storage/artifact-store.js';
import {
  compareSourceFingerprint,
  computeSourceFingerprint,
  describeVerdict,
  type FingerprintVerdict,
  type SourceFingerprint,
} from '../storage/source-fingerprint.js';
import { nextModule } from './module-batch.js';

export interface ReusableStoryboard {
  artifact_id: string;
  course_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  module_count: number;
  /**
   * The rendered document being offered. Never absent: a storyboard with no
   * document on disk is not offered at all, so there is no state in which this
   * describes an offer that cannot be honoured.
   */
  docx_path: string;
  /** When that document was rendered, which can be later than the content date. */
  rendered_at: string;
  /** Whether the sources have moved since this was written. */
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

/** The newest rendered file for an artifact that is still on disk. */
function latestDocx(artifactId: string): { path: string; rendered_at: string } | undefined {
  const withFiles = listVersions(artifactId)
    .filter((v) => v.docx_path !== undefined && existsSync(v.docx_path))
    .sort((a, b) => b.version - a.version);
  const found = withFiles[0];
  return found?.docx_path ? { path: found.docx_path, rendered_at: found.created_at } : undefined;
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
export function findReusableStoryboard(courseId: string, templateVersion: string): ReusableStoryboard | undefined {
  const ordered = listArtifacts(courseId).sort(
    (a, b) => b.updated_at.localeCompare(a.updated_at) || b.artifact_id.localeCompare(a.artifact_id),
  );

  for (const artifact of ordered) {
    if (!isComplete(artifact.artifact_id)) continue;
    const docx = latestDocx(artifact.artifact_id);
    if (!docx) continue;

    const current = computeSourceFingerprint(courseId, templateVersion);
    const verdict = compareSourceFingerprint(storedFingerprint(artifact), current);
    const state = getState(artifact.artifact_id);

    return {
      artifact_id: artifact.artifact_id,
      course_id: artifact.course_id,
      version: artifact.current_version,
      created_at: artifact.created_at,
      updated_at: artifact.updated_at,
      module_count: state.modules.length,
      docx_path: docx.path,
      rendered_at: docx.rendered_at,
      verdict,
      verdict_summary: describeVerdict(verdict),
    };
  }

  return undefined;
}

export interface ReuseOption {
  value: 'reuse' | 'generate';
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
export function reuseOptions(existing: ReusableStoryboard | undefined): ReuseOption[] {
  if (!existing) {
    return [
      {
        value: 'generate',
        label: 'Generate the storyboard',
        detail: 'No storyboard has been built for this subject yet.',
      },
    ];
  }

  const built = existing.created_at.slice(0, 10);
  const rendered = existing.rendered_at.slice(0, 10);
  const when = built === rendered ? `built ${built}` : `built ${built}, rendered ${rendered}`;

  return [
    {
      value: 'reuse',
      label: 'Use the existing storyboard',
      detail:
        `${existing.artifact_id}: ${existing.module_count} modules, ${when}, ` +
        `${existing.verdict_summary}. The most recent one for this subject. ` +
        'Hands over the document already rendered. No generation.',
    },
    {
      value: 'generate',
      label: 'Generate a new storyboard from scratch',
      detail:
        existing.verdict.state === 'changed'
          ? 'Recommended: the source documents have changed since the saved one was written.'
          : 'Writes a new one. The saved storyboard is kept either way.',
    },
  ];
}
