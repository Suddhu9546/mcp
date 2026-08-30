/**
 * Rebuilds the whole index from the committed source documents.
 *
 * This exists for deployment. The database is derived data: every chunk in it
 * comes from a document in `courses/`, all of which are in the repository, so a
 * clean checkout can reconstruct it and nothing needs carrying between machines.
 * On a host with no persistent disk that is the whole storage strategy -- the
 * index is built once at build time and ships inside the image.
 *
 * A course whose documents are missing is reported and skipped rather than
 * failing the run, so one absent handbook cannot leave a deployment with no
 * index at all.
 *
 *   npm run ingest:all            rebuild what is not already indexed
 *   npm run ingest:all -- --force re-extract every document
 */

import { listCourseIds } from '../src/courses/course-config.js';
import { ingestCourse } from '../src/documents/ingest.js';
import { getDb, closeDb } from '../src/storage/db.js';

const force = process.argv.includes('--force');
const courseIds = listCourseIds();

console.log(`Ingesting ${courseIds.length} courses${force ? ' [forced]' : ''}\n`);

const started = Date.now();
const failed: { courseId: string; reason: string }[] = [];
const empty: string[] = [];
let chunkTotal = 0;

for (const courseId of courseIds) {
  const courseStarted = Date.now();
  try {
    await ingestCourse(courseId, { force });
    const { n } = getDb()
      .prepare('SELECT COUNT(*) AS n FROM chunks WHERE course_id = ?')
      .get(courseId) as { n: number };
    chunkTotal += n;
    // A course that ingests without error but indexes nothing has source
    // documents that were not found -- a filename in its config not matching
    // what is on disk, say. It is not a failure of the run, but reporting it as
    // "ok" would hide a course that is silently unavailable to every tool.
    const mark = n === 0 ? 'EMPTY' : 'ok   ';
    if (n === 0) empty.push(courseId);
    console.log(`  ${mark} ${courseId.padEnd(26)} ${String(n).padStart(5)} chunks  ${Date.now() - courseStarted}ms`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    failed.push({ courseId, reason });
    console.log(`  SKIP  ${courseId.padEnd(26)} ${reason}`);
  }
}

// Reclaim free pages before the file is shipped or measured.
//
// Schema migrations drop and rebuild tables, and SQLite keeps the vacated pages
// on a freelist rather than shrinking the file -- which is how a 22 MB index
// comes to occupy a gigabyte on disk. VACUUM rewrites it compactly. Cheap here
// (well under a second at this size) and it is the file that gets deployed.
const db = getDb();
const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
const before = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
db.exec('VACUUM');
const after = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
const mb = (pages: number) => ((pages * pageSize) / 1048576).toFixed(1);

console.log(`\nVacuumed: ${mb(before)} MB -> ${mb(after)} MB`);
console.log(
  `Indexed ${chunkTotal} chunks from ${courseIds.length - failed.length - empty.length} courses in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);

if (empty.length > 0) {
  console.log(`\n${empty.length} course(s) indexed nothing -- their source documents were not found:`);
  for (const c of empty) console.log(`  ${c}`);
}

if (failed.length > 0) {
  console.log(`\n${failed.length} course(s) skipped:`);
  for (const f of failed) console.log(`  ${f.courseId}: ${f.reason}`);
}

closeDb();

// A deployment with an empty index is broken and should not be treated as a
// successful build; some courses missing is not.
if (chunkTotal === 0) {
  console.error('\nNo chunks were indexed. Refusing to report success.');
  process.exit(1);
}
