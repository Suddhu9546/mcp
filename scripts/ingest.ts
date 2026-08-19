/**
 * Ingests a course's approved documents and reports index coverage.
 *
 *   npm run ingest -- biofuels [--force]
 */

import { ingestCourse, getCourseDocumentStatus } from '../src/documents/ingest.js';
import { searchCourseContent } from '../src/documents/retriever.js';
import { getCourseConfig } from '../src/courses/course-config.js';
import { getDb } from '../src/storage/db.js';

const courseId = process.argv[2] ?? 'biofuels';
const force = process.argv.includes('--force');
const course = getCourseConfig(courseId);

console.log(`\nIngesting ${course.name} (${courseId})${force ? ' [forced]' : ''}\n`);

const result = await ingestCourse(courseId, { force });

for (const d of result.documents) {
  const state = d.skipped ? `SKIPPED  ${d.reason}` : `${d.page_count} pages -> ${d.chunk_count} chunks`;
  console.log(`  ${d.document_type.padEnd(7)} ${state}`);
}
console.log(`\nTotal chunks indexed: ${result.total_chunks}`);

// Chunk distribution by document and chapter, which is what scoped retrieval
// depends on. A document with everything under chapter NULL would mean the
// heading detection failed for it.
const rows = getDb()
  .prepare(
    `SELECT document_type, COALESCE(chapter, -1) AS chapter, COUNT(*) AS n
     FROM chunks WHERE course_id = ?
     GROUP BY document_type, COALESCE(chapter, -1)
     ORDER BY document_type, chapter`,
  )
  .all(courseId) as { document_type: string; chapter: number; n: number }[];

console.log('\nChunks by document and chapter:');
let currentDoc = '';
for (const r of rows) {
  if (r.document_type !== currentDoc) {
    currentDoc = r.document_type;
    console.log(`  ${currentDoc}`);
  }
  const label = r.chapter === -1 ? '(unassigned)' : `chapter ${r.chapter}`;
  console.log(`      ${label.padEnd(14)} ${String(r.n).padStart(5)}`);
}

// Prove the crosswalk: a pellet query scoped to module 5 must land in chapter 7.
console.log('\nCrosswalk spot-check -- searching "pellet die extrusion moisture" scoped to module 5 (chapter 7):');
const hits = searchCourseContent({
  courseId,
  query: 'pellet die extrusion moisture',
  documentTypes: ['PH'],
  chapter: 7,
  limit: 3,
});
for (const h of hits) {
  console.log(
    `  [${h.score.toFixed(3)}] ${h.document_type} p.${h.pdf_page}` +
      `${h.printed_page ? ` (printed ${h.printed_page})` : ''} ch.${h.chapter} ${h.unit_code ?? '-'}  ${h.section}`,
  );
}
if (hits.length === 0) console.log('  NO HITS -- chapter scoping or ingestion needs review.');

console.log('\nDocument status:');
for (const s of getCourseDocumentStatus(courseId)) {
  console.log(
    `  ${s.document_type.padEnd(7)} present=${s.present} indexed=${s.indexed} ` +
      `pages=${s.page_count} chunks=${s.chunk_count}`,
  );
}
