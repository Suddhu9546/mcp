/**
 * Course-type and subject catalog for the handbook flows.
 *
 * The storyboard flow is entered with a `course_id` the operator already knows.
 * The reading flow is entered by a *person* who thinks in the SCGJ programme's own
 * vocabulary -- "Orientation", "ESG", "Solar PV" -- so this file is the one place
 * that maps that vocabulary onto the `course_id` values the rest of the server
 * uses. Nothing else hard-codes a subject name.
 *
 * What is *not* here, deliberately: modules and units. Those are derived from each
 * subject's Participant Handbook at query time (see documents/ph-outline.ts), so a
 * handbook revision that adds a unit is picked up by re-ingesting, with no code
 * change. This file carries only what no document states: which subject belongs to
 * which course type, and which course_id holds its documents.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { TRACK_LABELS, courseDir, getCourseConfig, listCourseIds } from '../courses/course-config.js';
import type { CourseTrack } from '../courses/course-config.js';
import { getCourseDocumentStatus } from '../documents/ingest.js';

export { TRACK_LABELS };
export type { CourseTrack };

/**
 * The tracks that hold handbook subjects.
 *
 * CDR is a track but has no Participant Handbook, so it appears in no subject
 * list: its courses reach the storyboard flow through the CDR catalogue instead.
 */
export const COURSE_TRACKS = ['entrepreneur', 'orientation'] as const;

export interface SubjectEntry {
  /** Stable slug used in tool arguments, e.g. "esg". */
  subject_id: string;
  /** Short code as spoken by users, e.g. "ESG", "Solar PV". */
  code: string;
  /** Expanded name, e.g. "Environmental, Social and Governance". */
  name: string;
  track: CourseTrack;
  /** Course whose approved documents hold this subject's content. */
  course_id: string;
}

/**
 * The eight subjects across the two course types.
 *
 * Only Biofuels has approved documents supplied so far. The other seven are listed
 * anyway, with their course_id registered in course-config, so that dropping
 * `courses/<course_id>/ph.pdf` into place and running ingest_course_documents is
 * the entire onboarding procedure for a new subject. `subjectStatus` reports which
 * are actually usable, so the flow never offers a subject it cannot serve.
 */
const SUBJECTS: readonly SubjectEntry[] = [
  {
    subject_id: 'esg',
    code: 'ESG',
    name: 'Environmental, Social and Governance',
    track: 'orientation',
    course_id: 'esg',
  },
  {
    subject_id: 'ghg',
    code: 'GHG',
    name: 'Greenhouse Gas',
    track: 'orientation',
    course_id: 'ghg',
  },
  {
    subject_id: 'gl',
    code: 'GL',
    name: 'Green Logistics',
    track: 'orientation',
    course_id: 'green-logistics',
  },
  {
    subject_id: 'bg',
    code: 'BG',
    name: 'Biogas',
    track: 'orientation',
    course_id: 'biogas',
  },
  {
    subject_id: 'solar-pv',
    code: 'Solar PV',
    name: 'Solar Photovoltaic',
    track: 'entrepreneur',
    course_id: 'solar-pv',
  },
  {
    subject_id: 'biofuels',
    code: 'Biofuels',
    name: 'Biofuels',
    track: 'entrepreneur',
    course_id: 'biofuels',
  },
  {
    subject_id: 'agri-residue-aggregator',
    code: 'Agri-Residue Aggregator',
    name: 'Agri-Residue Aggregator',
    track: 'entrepreneur',
    course_id: 'agri-residue-aggregator',
  },
  {
    subject_id: 'green-hydrogen',
    code: 'Green Hydrogen',
    name: 'Green Hydrogen',
    track: 'entrepreneur',
    course_id: 'green-hydrogen',
  },
];

export function listSubjects(track?: CourseTrack): SubjectEntry[] {
  return SUBJECTS.filter((s) => track === undefined || s.track === track);
}

/** Normalises "Solar PV", "solar_pv" and "SOLARPV" to the same key. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Resolves whatever the user or client said into a subject.
 *
 * Accepts the subject_id, the code, the course_id or the full name, in any case
 * and punctuation. Returns undefined rather than guessing between two partial
 * matches -- an ambiguous subject would mean generating a transcript from the
 * wrong handbook, which is the one failure this feature must not have.
 */
export function findSubject(text: string): SubjectEntry | undefined {
  const key = normalise(text);
  if (key.length === 0) return undefined;

  const exact = SUBJECTS.find(
    (s) =>
      normalise(s.subject_id) === key ||
      normalise(s.code) === key ||
      normalise(s.course_id) === key ||
      normalise(s.name) === key,
  );
  if (exact) return exact;

  const partial = SUBJECTS.filter(
    (s) => normalise(s.name).includes(key) || key.includes(normalise(s.code)),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

/** Throws with the full option list, which is what the client should show the user. */
export function getSubject(text: string): SubjectEntry {
  const found = findSubject(text);
  if (!found) {
    throw new Error(
      `Unknown subject "${text}". Valid subjects -- ` +
        COURSE_TRACKS.map(
          (t) => `${TRACK_LABELS[t]}: ${listSubjects(t).map((s) => s.code).join(', ')}`,
        ).join('; ') +
        '.',
    );
  }
  return found;
}

export function findSubjectByCourseId(courseId: string): SubjectEntry | undefined {
  return SUBJECTS.find((s) => s.course_id === courseId);
}

export interface SubjectStatus {
  subject_id: string;
  code: string;
  name: string;
  track: CourseTrack;
  course_id: string;
  /** The course_id exists in the course registry. */
  registered: boolean;
  /** courses/<course_id>/ph.pdf is on disk. */
  ph_present: boolean;
  /** The handbook has been ingested and has retrievable chunks. */
  ph_indexed: boolean;
  ph_chunk_count: number;
  /** True when content can be produced right now, with no indexing first. */
  ready: boolean;
  /**
   * True when the subject can be offered to the user: its handbook is on disk.
   *
   * A subject whose handbook is present but not yet indexed is selectable, not
   * blocked -- indexing is a one-time step the server performs itself when the
   * subject is first chosen. Only a missing handbook is a real blocker, because
   * only that needs a person to do something.
   */
  selectable: boolean;
  /** Selectable but not ready: choosing it triggers a one-time ingestion. */
  needs_index: boolean;
  /** Present when selectable is false: what must happen next, in one sentence. */
  blocker?: string;
}

/**
 * Reports whether a subject can serve the content flows.
 *
 * The content flows need exactly one document -- the Participant Handbook -- so
 * this check is deliberately narrower than the storyboard flow's four-document
 * requirement. A subject with a handbook but no timing document can produce module
 * content while remaining unable to produce a storyboard, and saying so precisely
 * is more useful than a single "not ready".
 *
 * Three states, not two. Supplying the PDFs is a person's job; indexing them is
 * the server's, so a handbook sitting un-ingested reports as selectable rather
 * than unavailable and is indexed the moment it is chosen. Onboarding a subject is
 * therefore: drop the folder in, pick it from the menu.
 */
export function subjectStatus(subject: SubjectEntry): SubjectStatus {
  const base = {
    subject_id: subject.subject_id,
    code: subject.code,
    name: subject.name,
    track: subject.track,
    course_id: subject.course_id,
  };

  const registered = listCourseIds().includes(subject.course_id);
  if (!registered) {
    return {
      ...base,
      registered: false,
      ph_present: false,
      ph_indexed: false,
      ph_chunk_count: 0,
      ready: false,
      selectable: false,
      needs_index: false,
      blocker:
        `Course "${subject.course_id}" is not in the course registry. Add it to ` +
        'src/courses/course-config.ts before supplying its documents.',
    };
  }

  const phFile = path.join(
    courseDir(subject.course_id),
    getCourseConfig(subject.course_id).documents.find((d) => d.document_type === 'PH')?.file ?? 'ph.pdf',
  );
  const ph = getCourseDocumentStatus(subject.course_id).find((d) => d.document_type === 'PH');
  const present = ph?.present ?? existsSync(phFile);
  const indexed = ph?.indexed ?? false;

  return {
    ...base,
    registered: true,
    ph_present: present,
    ph_indexed: indexed,
    ph_chunk_count: ph?.chunk_count ?? 0,
    ready: present && indexed,
    selectable: present,
    needs_index: present && !indexed,
    ...(present
      ? {}
      : {
          blocker:
            `No Participant Handbook supplied. Place the course's PDFs in ${courseDir(subject.course_id)} ` +
            `(ph.pdf, and qp.pdf, fg.pdf, timing.pdf for storyboards). If they are already on disk ` +
            `under a differently named folder, add that name to this course's directory_aliases in ` +
            'src/courses/course-config.ts.',
        }),
  };
}

export function listSubjectStatuses(track?: CourseTrack): SubjectStatus[] {
  return listSubjects(track).map(subjectStatus);
}
