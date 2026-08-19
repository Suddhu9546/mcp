/**
 * The presenter, locked per subject.
 *
 * A learner working through a subject meets several modules. If each module's video
 * invents a new presenter, the course reads as a pile of unrelated films rather than
 * one programme -- so the first module to choose a character fixes it, and later
 * modules of the same subject reuse them.
 *
 * Locked per subject rather than globally, because subjects are genuinely different
 * worlds: the person who fits a biogas plant is not the person who fits a green
 * logistics warehouse, and forcing one presenter across all eight would be worse
 * than the problem it solves.
 */

import type { StoryNarrator, StoryProtagonist } from '../types/module-content.js';
import { getDb, nowIso } from '../storage/db.js';

export interface CharacterLock {
  course_id: string;
  protagonist: StoryProtagonist;
  narrator: StoryNarrator;
  /** The package that first established this character. */
  established_by: string;
  created_at: string;
}

export function getCharacterLock(courseId: string): CharacterLock | undefined {
  const row = getDb()
    .prepare(
      'SELECT course_id, protagonist_json, narrator_json, established_by, created_at FROM subject_characters WHERE course_id = ?',
    )
    .get(courseId) as
    | {
        course_id: string;
        protagonist_json: string;
        narrator_json: string;
        established_by: string;
        created_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    course_id: row.course_id,
    protagonist: JSON.parse(row.protagonist_json) as StoryProtagonist,
    narrator: JSON.parse(row.narrator_json) as StoryNarrator,
    established_by: row.established_by,
    created_at: row.created_at,
  };
}

/** Records the character for a subject. Idempotent; later writes need `replace`. */
export function setCharacterLock(
  courseId: string,
  protagonist: StoryProtagonist,
  narrator: StoryNarrator,
  establishedBy: string,
  replace = false,
): CharacterLock {
  const existing = getCharacterLock(courseId);
  if (existing && !replace) return existing;

  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO subject_characters (course_id, protagonist_json, narrator_json, established_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(course_id) DO UPDATE SET
         protagonist_json = excluded.protagonist_json,
         narrator_json = excluded.narrator_json,
         established_by = excluded.established_by,
         updated_at = excluded.updated_at`,
    )
    .run(
      courseId,
      JSON.stringify(protagonist),
      JSON.stringify(narrator),
      establishedBy,
      existing?.created_at ?? ts,
      ts,
    );
  return getCharacterLock(courseId)!;
}
