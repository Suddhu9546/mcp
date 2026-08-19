/**
 * Verifies the Timing Allocation Document parses and its arithmetic closes.
 *
 *   npm run parse-timing -- biofuels
 */

import path from 'node:path';
import { getCourseConfig, getCrosswalkEntry } from '../src/courses/course-config.js';
import { parseTimingDocument } from '../src/timing/timing-parser.js';
import { withValidatedArithmetic } from '../src/timing/timing-validator.js';
import { courseDir } from '../src/courses/course-config.js';

const courseId = process.argv[2] ?? 'biofuels';
const course = getCourseConfig(courseId);
const timingDoc = course.documents.find((d) => d.document_type === 'TIMING');
if (!timingDoc) throw new Error(`Course "${courseId}" has no TIMING document configured.`);

const file = path.join(courseDir(courseId), timingDoc.file);
const allocation = withValidatedArithmetic(await parseTimingDocument(courseId, file));

console.log(`\nCourse:      ${course.name} (${courseId})`);
console.log(`QP code:     ${allocation.qp_code}   NSQF level: ${allocation.nsqf_level}`);
console.log(
  `Stated total: ${allocation.stated_total_hours} hours / ${allocation.stated_total_minutes} mins`,
);
console.log(`Modules:      ${allocation.modules.length}\n`);

for (const m of allocation.modules) {
  const cw = getCrosswalkEntry(courseId, m.number);
  const unitSum = m.units.reduce((a, u) => a + u.minutes, 0);
  const flag = unitSum === m.minutes ? 'OK ' : 'BAD';
  const elective = m.elective ? ` [Elective ${m.elective}]` : '';
  const gap = cw.no_source_content ? '  <-- NO SOURCE CONTENT' : '';
  console.log(
    `[${flag}] M${m.number} ${m.minutes} min (units ${unitSum})  ` +
      `PH/FG ch.${cw.source_chapter}  ${cw.nos_code}${elective}  ${m.title}${gap}`,
  );
  for (const u of m.units) {
    console.log(
      `        ${u.code}  ${String(u.minutes).padStart(3)} min  ` +
        `p.${u.source.pdf_page}  ${u.sub_topics.length} sub-topics  ${u.title}`,
    );
  }
}

const totalUnits = allocation.modules.reduce((a, m) => a + m.units.length, 0);
const totalSubTopics = allocation.modules.reduce(
  (a, m) => a + m.units.reduce((b, u) => b + u.sub_topics.length, 0),
  0,
);

console.log(`\nParsed ${allocation.modules.length} modules, ${totalUnits} units, ${totalSubTopics} sub-topics.`);
console.log(`Computed course total: ${allocation.arithmetic.computed_total_minutes} min`);
console.log(`Course total matches:  ${allocation.arithmetic.course_total_ok}`);
console.log(`All modules match:     ${allocation.arithmetic.all_modules_ok}`);

if (allocation.arithmetic.discrepancies.length > 0) {
  console.log('\nDiscrepancies:');
  for (const d of allocation.arithmetic.discrepancies) console.log(`  - ${d.message}`);
  process.exitCode = 1;
} else {
  console.log('\nTiming arithmetic is exact. No discrepancies.');
}
