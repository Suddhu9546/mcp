/**
 * What the video-script flow offers, and what it calls things.
 *
 * The subject catalogue already knows which subjects exist and whether their
 * handbooks are indexed, so none of that is repeated here. What is here is the
 * two things that belong to this flow alone: the names the brief uses for the
 * subjects, which are the full role titles a course author recognises rather than
 * the short codes the other flows show, and the video types.
 *
 * Keeping the labels here rather than editing the shared catalogue is deliberate.
 * The reading and storyboard flows show "Biofuels" because that is the document
 * set; this flow shows "Bio-Energy Micro Entrepreneur" because that is the course
 * a video is being made for. Both are right for their own flow.
 */

import {
  COURSE_TRACKS,
  TRACK_LABELS,
  listSubjectStatuses,
  type CourseTrack,
  type SubjectStatus,
} from '../catalog/subject-catalog.js';
import { VIDEO_TYPE_INFO, type VideoType } from '../types/video-script.js';

/** Role titles as the brief names them. A subject absent here keeps its own name. */
const VIDEO_SUBJECT_LABELS: Record<string, string> = {
  'solar-pv': 'Solar Photovoltaic Entrepreneur',
  biofuels: 'Bio-Energy Micro Entrepreneur',
  'green-hydrogen': 'Green Hydrogen Plant Entrepreneur',
  'agri-residue-aggregator': 'Agri-Residue Aggregator',
};

/**
 * The order the brief lists them in, which is not alphabetical.
 *
 * Keyed on the two tracks this flow serves. CDR is a track of the storyboard flow
 * and has no Participant Handbook, so it is not a key here and never will be.
 */
const SUBJECT_ORDER: Partial<Record<CourseTrack, string[]>> = {
  entrepreneur: ['solar-pv', 'biofuels', 'green-hydrogen', 'agri-residue-aggregator'],
};

export function videoSubjectLabel(subjectId: string, fallback: string): string {
  return VIDEO_SUBJECT_LABELS[subjectId] ?? fallback;
}

export interface VideoSubjectOption extends SubjectStatus {
  /** The role title shown in this flow. */
  video_label: string;
}

/**
 * The subjects of one course, in the brief's order.
 *
 * A subject whose handbook is missing stays in the list and carries its blocker.
 * Dropping it would read as a bug to anyone who knows the course exists, and the
 * blocker is the thing someone has to act on.
 */
export function listVideoSubjects(track: CourseTrack): VideoSubjectOption[] {
  const statuses = listSubjectStatuses(track);
  const order = SUBJECT_ORDER[track] ?? [];
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? order.length : i;
  };
  return [...statuses]
    .sort((a, b) => rank(a.subject_id) - rank(b.subject_id) || a.code.localeCompare(b.code))
    .map((s) => ({ ...s, video_label: videoSubjectLabel(s.subject_id, s.name) }));
}

export interface VideoTrackOption {
  track: CourseTrack;
  label: string;
  subject_count: number;
  ready_count: number;
}

export function listVideoTracks(): VideoTrackOption[] {
  return COURSE_TRACKS.map((track) => {
    const subjects = listSubjectStatuses(track);
    return {
      track,
      label: TRACK_LABELS[track],
      subject_count: subjects.length,
      ready_count: subjects.filter((s) => s.selectable).length,
    };
  });
}

export function findVideoTrack(answer: string): CourseTrack | undefined {
  const key = answer.trim().toLowerCase().replace(/[.)]$/, '');
  const byIndex = Number(key);
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= COURSE_TRACKS.length) {
    return COURSE_TRACKS[byIndex - 1];
  }
  return COURSE_TRACKS.find(
    (t) => t === key || TRACK_LABELS[t].toLowerCase() === key || TRACK_LABELS[t].toLowerCase().startsWith(key),
  );
}

/** Resolves a subject answer within one course. Never guesses across two matches. */
export function findVideoSubject(track: CourseTrack, answer: string): VideoSubjectOption | undefined {
  const subjects = listVideoSubjects(track);
  const key = answer.trim().toLowerCase().replace(/[.)]$/, '');
  const index = Number(key);
  if (Number.isInteger(index) && index >= 1 && index <= subjects.length) return subjects[index - 1];

  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const wanted = flat(key);
  if (wanted.length === 0) return undefined;

  const exact = subjects.find(
    (s) =>
      flat(s.subject_id) === wanted ||
      flat(s.code) === wanted ||
      flat(s.name) === wanted ||
      flat(s.video_label) === wanted,
  );
  if (exact) return exact;

  const partial = subjects.filter(
    (s) => flat(s.video_label).includes(wanted) || flat(s.name).includes(wanted),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

// ---------------------------------------------------------------------------
// Video types
// ---------------------------------------------------------------------------

export interface VideoTypeOption {
  value: string;
  label: string;
  detail: string;
  available: boolean;
  blocker?: string;
}

/**
 * Two types are offered and one is built.
 *
 * The 15-minute unit video is shown as unavailable rather than hidden, because a
 * user who was told the flow has two types and sees one would reasonably think
 * something is broken. It is a separate build with a different structure, not a
 * longer version of this one.
 */
export const VIDEO_TYPE_OPTIONS: VideoTypeOption[] = [
  {
    value: VIDEO_TYPE_INFO,
    label: '2.5-3 minute AI Info Video',
    detail:
      'A 150-180 second introduction covering the whole module, in 15-18 scenes of 10 seconds',
    available: true,
  },
  {
    value: 'unit_15_min',
    label: '15 minute Unit Content Video',
    detail: 'Full unit teaching video',
    available: false,
    blocker: 'Not implemented yet. Only the 2.5-3 minute info video can be generated today.',
  },
];

export function findVideoType(answer: string): VideoTypeOption | undefined {
  const key = answer.trim().toLowerCase().replace(/[.)]$/, '');
  const index = Number(key);
  if (Number.isInteger(index) && index >= 1 && index <= VIDEO_TYPE_OPTIONS.length) {
    return VIDEO_TYPE_OPTIONS[index - 1];
  }
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const wanted = flat(key);
  if (wanted.length === 0) return undefined;
  return VIDEO_TYPE_OPTIONS.find(
    (o) => flat(o.value) === wanted || flat(o.label).includes(wanted),
  );
}

export function videoTypeLabel(type: VideoType): string {
  return VIDEO_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type;
}
