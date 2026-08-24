/**
 * CDR storyboards are supplied, not generated.
 *
 * The CDR Biochar storyboard is a finished, hand-authored document: five modules,
 * a fifty-question bank and a glossary, written outside this server and reviewed as
 * a deliverable in its own right. It is the real thing the user wants, so the
 * flow's job for CDR is to hand it over -- not to build a second, lesser version of
 * a document that already exists.
 *
 * That was true in practice before it was true in code. `templates/cdr/` does not
 * exist, so `templateFile('cdr')` throws and a CDR render could never have
 * completed: the generation path for this track has always been unreachable. What
 * follows makes the working path the offered one.
 *
 * The file lives under `templates/` because that is where it was put. That is the
 * wrong shelf for it -- it is a deliverable, not a template, and nothing analyses
 * it the way `analyzeTemplate` analyses the other two -- but it is where it is, and
 * moving a reviewed document is not this module's decision.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../util/config.js';
import { getCourseConfig } from '../courses/course-config.js';
import { listCdrCourseIds } from './catalog.js';

export interface PreparedStoryboard {
  course_id: string;
  /** Course name, for the line shown to the user. */
  name: string;
  /** Absolute path to the finished document. */
  docx_path: string;
  bytes: number;
  /** Last modified, so the user can see which revision they are getting. */
  updated_at: string;
}

/**
 * The supplied storyboard for a CDR course, if one is on disk.
 *
 * Looked up by directory rather than by a filename in configuration, because the
 * document arrives named however whoever produced it chose --
 * "CDR_Biochar_Storyboard.docx" -- and a config entry naming it would go stale on
 * the next revision. One .docx in the directory is the contract; two is ambiguous
 * and is reported as nothing rather than guessed at.
 */
export function preparedStoryboard(courseId: string): PreparedStoryboard | undefined {
  const dir = path.join(config.paths.templates, courseId);
  if (!existsSync(dir)) return undefined;

  const candidates = readdirSync(dir).filter(
    (f) => f.toLowerCase().endsWith('.docx') && !f.startsWith('~$'),
  );
  if (candidates.length !== 1) return undefined;

  const file = path.join(dir, candidates[0]!);
  const stat = statSync(file);
  return {
    course_id: courseId,
    name: getCourseConfig(courseId).name,
    docx_path: file,
    bytes: stat.size,
    updated_at: stat.mtime.toISOString(),
  };
}

/** Every CDR course that has a supplied storyboard ready to hand over. */
export function listPreparedCdrStoryboards(): PreparedStoryboard[] {
  return listCdrCourseIds()
    .map(preparedStoryboard)
    .filter((s): s is PreparedStoryboard => s !== undefined);
}

/**
 * True when this course is served by handing a document over rather than by
 * building one.
 */
export function isPreparedCourse(courseId: string): boolean {
  return preparedStoryboard(courseId) !== undefined;
}
