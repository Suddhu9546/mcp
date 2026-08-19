/**
 * Course registration.
 *
 * Kept separate from ingestion so that creating an artifact does not depend on
 * documents having been indexed first: the course is a configured entity, while
 * the chunk index is a derived cache that can be rebuilt at any time.
 */

import { getCourseConfig, listCourses, type CourseConfig } from './course-config.js';
import { getDb, nowIso } from '../storage/db.js';

/** Inserts or refreshes the course row. Idempotent. */
export function ensureCourseRegistered(courseId: string): CourseConfig {
  const course = getCourseConfig(courseId);
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO courses (course_id, name, qp_code, nsqf_level, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'registered', ?, ?)
       ON CONFLICT(course_id) DO UPDATE SET
         name = excluded.name,
         qp_code = excluded.qp_code,
         nsqf_level = excluded.nsqf_level,
         updated_at = excluded.updated_at`,
    )
    .run(course.course_id, course.name, course.qp_code, course.nsqf_level, ts, ts);
  return course;
}

/** Registers every configured course. */
export function ensureAllCoursesRegistered(): void {
  for (const course of listCourses()) ensureCourseRegistered(course.course_id);
}
