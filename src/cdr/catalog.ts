/**
 * Which CDR courses exist, and whether each can actually be built.
 *
 * A qualification course is ready when one Participant Handbook is indexed. A CDR
 * course is ready when *every* document its master file names is indexed, because
 * each module draws from a different one: with three of nine documents missing,
 * six modules would build and three would have nothing to cite. Reporting that as
 * a single "not ready" would be useless, so this names the missing files -- those
 * filenames are the action the user has to take.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { courseDir, listCourses } from '../courses/course-config.js';
import { getCourseDocumentStatus } from '../documents/ingest.js';
import { CDR_COURSES } from '../courses/cdr-generated.js';

export interface CdrDocumentStatus {
  doc_key: string;
  title: string;
  file: string;
  present: boolean;
  indexed: boolean;
  chunk_count: number;
  /** Modules that draw on this document, so a gap names what it blocks. */
  used_by_modules: number[];
}

export interface CdrCourseStatus {
  course_id: string;
  name: string;
  module_count: number;
  total_hours: number;
  document_count: number;
  documents: CdrDocumentStatus[];
  /** Documents named by the master file that are not on disk or not indexed. */
  missing: CdrDocumentStatus[];
  /** Modules that cannot be built because a document they need is missing. */
  blocked_modules: number[];
  ready: boolean;
  blocker?: string;
}

export function listCdrCourseIds(): string[] {
  return CDR_COURSES.map((c) => c.course_id);
}

export function isCdrCourse(courseId: string): boolean {
  return CDR_COURSES.some((c) => c.course_id === courseId);
}

export function cdrCourseStatus(courseId: string): CdrCourseStatus {
  const definition = CDR_COURSES.find((c) => c.course_id === courseId);
  if (!definition) throw new Error(`"${courseId}" is not a CDR course.`);

  const onDisk = getCourseDocumentStatus(courseId);
  const dir = courseDir(courseId);

  const usedBy = new Map<string, number[]>();
  for (const [moduleNumber, keys] of Object.entries(definition.module_sources)) {
    for (const key of keys) {
      usedBy.set(key, [...(usedBy.get(key) ?? []), Number(moduleNumber)]);
    }
  }

  const documents: CdrDocumentStatus[] = definition.documents.map((d) => {
    const file = path.join(dir, d.file);
    const row = onDisk.find((s) => s.doc_key === d.doc_key);
    const chunkCount = row?.chunk_count ?? 0;
    return {
      doc_key: d.doc_key,
      title: d.title,
      file: d.file,
      present: existsSync(file),
      indexed: chunkCount > 0,
      chunk_count: chunkCount,
      used_by_modules: (usedBy.get(d.doc_key) ?? []).sort((a, b) => a - b),
    };
  });

  const missing = documents.filter((d) => !d.present || !d.indexed);
  const blocked = [...new Set(missing.flatMap((d) => d.used_by_modules))].sort((a, b) => a - b);
  const absent = missing.filter((d) => !d.present);
  const unindexed = missing.filter((d) => d.present && !d.indexed);

  return {
    course_id: courseId,
    name: definition.name,
    module_count: definition.module_count,
    total_hours: definition.total_hours,
    document_count: documents.length,
    documents,
    missing,
    blocked_modules: blocked,
    ready: missing.length === 0,
    ...(missing.length === 0
      ? {}
      : {
          blocker:
            (absent.length > 0
              ? `${absent.length} of ${documents.length} reference documents are not on disk. ` +
                `Place them in ${dir}, named exactly: ${absent.map((d) => d.file).join(', ')}. `
              : '') +
            (unindexed.length > 0
              ? `${unindexed.length} document(s) are present but not indexed; choosing this ` +
                'course indexes them. '
              : '') +
            `Without them, module(s) ${blocked.join(', ')} have no source to build from.`,
        }),
  };
}

export function listCdrCourseStatuses(): CdrCourseStatus[] {
  return listCdrCourseIds().map(cdrCourseStatus);
}

/** Every registered course that is not a CDR course. */
export function listQualificationCourses(): ReturnType<typeof listCourses> {
  return listCourses().filter((c) => c.kind !== 'cdr');
}
