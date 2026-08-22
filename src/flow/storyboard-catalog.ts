/**
 * Which courses can be storyboarded, per track.
 *
 * The storyboard flow asks two questions -- which track, then which course -- and
 * both lists have to say not just what exists but what can actually be built and,
 * where it cannot, what a person has to do about it. That judgement differs by
 * track, and this module is the one place it is made:
 *
 *   Entrepreneur and Orientation need four approved documents (QP, PH, FG and a
 *   Timing Allocation Document) and a reviewed crosswalk mapping timing modules
 *   onto handbook chapters. The crosswalk is reviewed data, not something to
 *   derive: a guessed one produces a storyboard about the wrong chapter under
 *   citations that look valid.
 *
 *   CDR needs every reference document its master file names, and no crosswalk at
 *   all, because its modules are routed to documents rather than to chapters.
 *   That check already exists in cdr/catalog.ts and is delegated to.
 *
 * Missing documents are the user's job and missing indexes are the server's, so
 * only the former blocks: a course whose PDFs are all present but not yet indexed
 * is offered normally and indexed when it is chosen.
 */

import { cdrCourseStatus, isCdrCourse, listCdrCourseIds } from '../cdr/catalog.js';
import {
  TRACK_LABELS,
  courseDir,
  hasReviewedCrosswalk,
  listCoursesInTrack,
  type CourseTrack,
} from '../courses/course-config.js';
import { getCourseDocumentStatus } from '../documents/ingest.js';

/** The tracks the storyboard flow offers, in menu order. */
export const STORYBOARD_TRACKS: readonly CourseTrack[] = ['entrepreneur', 'orientation', 'cdr'];

export interface StoryboardCourseStatus {
  course_id: string;
  name: string;
  track: CourseTrack;
  module_count: number;
  /** Every approved document the course declares is on disk. */
  documents_present: boolean;
  /** Every one of them has been indexed. */
  documents_indexed: boolean;
  /** Reviewed crosswalk (or, for CDR, document routing) is in place. */
  crosswalk_ready: boolean;
  /** The course can be offered: choosing it will succeed. */
  selectable: boolean;
  /** Selectable, but choosing it triggers a one-time ingestion first. */
  needs_index: boolean;
  /** Present when selectable is false: what has to happen, in one sentence. */
  blocker?: string;
}

function qualificationStatus(courseId: string): StoryboardCourseStatus {
  const documents = getCourseDocumentStatus(courseId);
  const course = listCoursesInTrack('entrepreneur')
    .concat(listCoursesInTrack('orientation'))
    .find((c) => c.course_id === courseId)!;

  const absent = documents.filter((d) => !d.present);
  const unindexed = documents.filter((d) => d.present && !d.indexed);
  const crosswalk = hasReviewedCrosswalk(courseId);

  const reasons: string[] = [];
  if (absent.length > 0) {
    reasons.push(
      `${absent.length} of ${documents.length} approved documents are not on disk. Place them ` +
        `in ${courseDir(courseId)}, named exactly: ${absent.map((d) => d.file_path.split(/[\\/]/).pop()).join(', ')}.`,
    );
  }
  if (!crosswalk) {
    reasons.push(
      'The module crosswalk has not been reviewed for this course. It maps each Timing ' +
        'Allocation module onto its Participant Handbook chapter and NOS code, and must be read ' +
        'off the real documents rather than inferred. Fill in this course\'s crosswalk and ' +
        'chapter_titles in src/courses/course-config.ts.',
    );
  }

  const selectable = absent.length === 0 && crosswalk;
  return {
    course_id: courseId,
    name: course.name,
    track: course.track,
    module_count: course.crosswalk.length,
    documents_present: absent.length === 0,
    documents_indexed: unindexed.length === 0 && absent.length === 0,
    crosswalk_ready: crosswalk,
    selectable,
    needs_index: selectable && unindexed.length > 0,
    ...(selectable ? {} : { blocker: reasons.join(' ') }),
  };
}

function cdrStatus(courseId: string): StoryboardCourseStatus {
  const status = cdrCourseStatus(courseId);
  const absent = status.missing.filter((d) => !d.present);
  const selectable = absent.length === 0;
  return {
    course_id: status.course_id,
    name: status.name,
    track: 'cdr',
    module_count: status.module_count,
    documents_present: absent.length === 0,
    documents_indexed: status.ready,
    crosswalk_ready: true,
    selectable,
    needs_index: selectable && !status.ready,
    ...(selectable ? {} : { blocker: status.blocker! }),
  };
}

export function storyboardCourseStatus(courseId: string): StoryboardCourseStatus {
  return isCdrCourse(courseId) ? cdrStatus(courseId) : qualificationStatus(courseId);
}

/** Every course of a track, buildable ones first. */
export function listStoryboardCourses(track: CourseTrack): StoryboardCourseStatus[] {
  const ids = track === 'cdr' ? listCdrCourseIds() : listCoursesInTrack(track).map((c) => c.course_id);
  return ids
    .map(storyboardCourseStatus)
    .sort((a, b) => Number(b.selectable) - Number(a.selectable));
}

export interface StoryboardTrackStatus {
  track: CourseTrack;
  label: string;
  course_count: number;
  selectable_count: number;
}

export function listStoryboardTracks(): StoryboardTrackStatus[] {
  return STORYBOARD_TRACKS.map((track) => {
    const courses = listStoryboardCourses(track);
    return {
      track,
      label: TRACK_LABELS[track],
      course_count: courses.length,
      selectable_count: courses.filter((c) => c.selectable).length,
    };
  });
}

/** Resolves whatever the user typed into a track, or undefined. */
export function findTrack(text: string): CourseTrack | undefined {
  const key = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const byIndex: Record<string, CourseTrack> = { '1': 'entrepreneur', '2': 'orientation', '3': 'cdr' };
  if (byIndex[key]) return byIndex[key];
  return STORYBOARD_TRACKS.find(
    (t) => t === key || TRACK_LABELS[t].toLowerCase().replace(/[^a-z0-9]+/g, '') === key,
  );
}

/**
 * Resolves whatever the user typed into a course of this track.
 *
 * Matches the course_id, the folder name the documents arrive in, the course's
 * full name, or the position in the list the user was shown. Nothing is matched
 * across tracks: a name that belongs to another track is not a near miss to be
 * accepted, it is the wrong answer to the question that was asked.
 */
export function findStoryboardCourse(
  track: CourseTrack,
  text: string,
): StoryboardCourseStatus | undefined {
  const courses = listStoryboardCourses(track);
  const key = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (key.length === 0) return undefined;

  const index = Number(key);
  if (Number.isInteger(index) && index >= 1 && index <= courses.length) return courses[index - 1];

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const exact = courses.find(
    (c) => norm(c.course_id) === key || norm(c.name) === key || norm(courseDir(c.course_id).split(/[\\/]/).pop() ?? '') === key,
  );
  if (exact) return exact;

  // A partial match is accepted only when exactly one course matches, so "solar"
  // resolves and an ambiguous fragment re-asks rather than picking one.
  const partial = courses.filter((c) => norm(c.name).includes(key) || norm(c.course_id).includes(key));
  return partial.length === 1 ? partial[0] : undefined;
}
