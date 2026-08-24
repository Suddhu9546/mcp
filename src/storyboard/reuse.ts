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
  /** The most recent rendered document, when one still exists on disk. */
  docx_path?: string;
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
function latestDocx(artifactId: string): string | undefined {
  const withFiles = listVersions(artifactId)
    .filter((v) => v.docx_path !== undefined && existsSync(v.docx_path))
    .sort((a, b) => b.version - a.version);
  return withFiles[0]?.docx_path;
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
 * The most recently updated *complete* storyboard for the course. Incomplete
 * drafts are not offered: half a storyboard is not a deliverable, and resuming one
 * is what the build loop already does when handed its artifact_id.
 *
 * Only one is offered rather than a list. A course accumulates artifacts over time
 * and asking a user to choose between six dated drafts is a worse question than the
 * one being asked; `list_storyboards` remains available for anyone who wants the
 * full history.
 */
export function findReusableStoryboard(courseId: string, templateVersion: string): ReusableStoryboard | undefined {
  const candidates = listArtifacts(courseId)
    .filter((a) => isComplete(a.artifact_id))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.artifact_id.localeCompare(a.artifact_id));

  const artifact = candidates[0];
  if (!artifact) return undefined;

  const current = computeSourceFingerprint(courseId, templateVersion);
  const verdict = compareSourceFingerprint(storedFingerprint(artifact), current);
  const state = getState(artifact.artifact_id);
  const docx = latestDocx(artifact.artifact_id);

  return {
    artifact_id: artifact.artifact_id,
    course_id: artifact.course_id,
    version: artifact.current_version,
    created_at: artifact.created_at,
    updated_at: artifact.updated_at,
    module_count: state.modules.length,
    ...(docx ? { docx_path: docx } : {}),
    verdict,
    verdict_summary: describeVerdict(verdict),
  };
}

export interface ReuseOption {
  value: 'reuse' | 'generate';
  label: string;
  detail: string;
}

/**
 * The choices to put to the user, given what exists.
 *
 * "reuse" appears only when a rendered document is actually on disk, so the option
 * is never offered and then found to have nothing behind it. Saved state with no
 * rendered document is not an offer -- it is content nobody has produced a
 * deliverable from, and handing it over would mean rendering it now, which is the
 * thing this no longer does.
 */
export function reuseOptions(existing: ReusableStoryboard | undefined): ReuseOption[] {
  const generateOnly: ReuseOption[] = [
    {
      value: 'generate',
      label: 'Generate the storyboard',
      detail: 'No storyboard has been built for this subject yet.',
    },
  ];

  if (!existing || !existing.docx_path) return generateOnly;

  const built = existing.created_at.slice(0, 10);
  return [
    {
      value: 'reuse',
      label: 'Use the existing storyboard',
      detail:
        `${existing.module_count} modules, built ${built}, ${existing.verdict_summary}. ` +
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

/**
 * True when there is something worth asking the user about.
 *
 * A saved storyboard with no rendered document leaves only one answer, so the
 * question is not asked at all -- an option list of one is a worse experience than
 * no question.
 */
export function hasReusableOffer(existing: ReusableStoryboard | undefined): boolean {
  return existing !== undefined && existing.docx_path !== undefined;
}
