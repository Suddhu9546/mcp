/**
 * Renders a Biofuels storyboard skeleton to .docx and verifies the output
 * package. No AI is involved: structure and timing come from the approved
 * documents, and content cells carry placeholder markers.
 *
 *   npx tsx scripts/render-skeleton.ts [courseId]
 */

import path from 'node:path';
import JSZip from 'jszip';
import { analyzeTemplate } from '../src/docx/template-analyzer.js';
import { renderStoryboardDocx } from '../src/docx/docx-writer.js';
import { buildSkeleton } from '../src/storyboard/skeleton.js';
import { validateStoryboard } from '../src/storyboard/validator.js';
import { parseTimingDocument } from '../src/timing/timing-parser.js';
import { withValidatedArithmetic } from '../src/timing/timing-validator.js';
import { courseDir, getCourseConfig } from '../src/courses/course-config.js';
import { attachDocx, createArtifact } from '../src/storage/artifact-store.js';
import { isInsufficientSource } from '../src/types/source.js';
import { config, templateFile } from '../src/util/config.js';

const courseId = process.argv[2] ?? 'biofuels';
const course = getCourseConfig(courseId);

const timingDoc = course.documents.find((d) => d.document_type === 'TIMING')!;
const allocation = withValidatedArithmetic(
  await parseTimingDocument(courseId, path.join(courseDir(courseId), timingDoc.file)),
);

const template = await analyzeTemplate(templateFile('v1'));
const state = buildSkeleton({ courseId, allocation, templateVersion: 'v1' });

// Fill placeholders so the render path exercises real text substitution.
let filled = 0;
for (const m of state.modules) {
  if (isInsufficientSource(m.part_a)) continue;
  if (typeof m.description !== 'string' || m.description === '') {
    m.description = `[PLACEHOLDER] Module ${m.number} description pending client generation.`;
  }
  for (const row of m.part_a.rows) {
    row.activity_name = `[Activity for ${row.unit_code}]`;
    row.interactive_description = `[PLACEHOLDER] Interactive learning description for ${row.unit_title}.`;
    filled += 1;
  }
  if (!isInsufficientSource(m.part_b)) {
    for (const row of m.part_b.rows) {
      row.visual = `[PLACEHOLDER] Visual for ${row.time_range}.`;
      row.audio = `[PLACEHOLDER] Narration for ${row.time_range}.`;
      filled += 1;
    }
  }
  if (!isInsufficientSource(m.part_c)) {
    for (const slide of m.part_c.slides) {
      slide.title = `[Slide ${slide.number} title]`;
      slide.visual_cues = '[PLACEHOLDER] Visual cues.';
      slide.instructor_script = '[PLACEHOLDER] Instructor script.';
      filled += 1;
    }
  }
}

const report = validateStoryboard({ state, allocation, skipContent: true });
console.log(`\nStructure + timing validation: ${report.passed ? 'PASS' : 'FAIL'}`);
console.log(`  errors=${report.summary.errors} warnings=${report.summary.warnings}`);
for (const f of [...report.levels.timing.findings, ...report.levels.structure.findings].slice(0, 10)) {
  console.log(`  [${f.severity}] ${f.code} ${f.path}: ${f.message}`);
}
console.log(`  modules with no source content: ${report.insufficient_source_modules.join(', ') || 'none'}`);

const artifact = createArtifact({
  course_id: courseId,
  template_version: 'v1',
  timing_strategy: state.timing_strategy,
  state,
  note: 'Skeleton render smoke test',
});
console.log(`\nArtifact: ${artifact.artifact_id} v${artifact.current_version}`);

const bytes = await renderStoryboardDocx({ template, state: { ...state, artifact_id: artifact.artifact_id, version: 1 } });
const file = attachDocx(artifact.artifact_id, 1, bytes);
console.log(`Rendered ${(bytes.length / 1024).toFixed(1)} KB -> ${path.relative(config.paths.root, file)}`);
console.log(`Placeholder cells filled: ${filled}`);

// --- Verify the output package ------------------------------------------
const out = await JSZip.loadAsync(bytes);
// JSZip materialises directory entries; only files correspond to package parts.
const outNames = Object.values(out.files).filter((f) => !f.dir).map((f) => f.name).sort();
const inNames = template.map.package_parts;
const missing = inNames.filter((n) => !outNames.includes(n));
console.log(`\nPackage parts: in=${inNames.length} out=${outNames.length} missing=${missing.length ? missing.join(', ') : 'none'}`);

const docXml = await out.file('word/document.xml')!.async('string');

// Duplicate bookmark names would make Word declare the file corrupt.
const bookmarkNames = [...docXml.matchAll(/<w:bookmarkStart[^>]*w:name="([^"]+)"/g)].map((m) => m[1]!);
const dupes = bookmarkNames.filter((n, i) => bookmarkNames.indexOf(n) !== i && n !== '_GoBack');
console.log(`Bookmarks: ${bookmarkNames.length}  duplicates: ${dupes.length ? [...new Set(dupes)].join(', ') : 'none'}`);

const styleXml = await out.file('word/styles.xml')!.async('uint8array');
const originalStyles = template.parts['word/styles.xml']!;
const stylesIdentical =
  styleXml.length === originalStyles.length && styleXml.every((b, i) => b === originalStyles[i]);
console.log(`styles.xml byte-identical to template: ${stylesIdentical}`);

console.log(`updateFields set: ${(await out.file('word/settings.xml')!.async('string')).includes('w:updateFields w:val="true"')}`);

// Content sanity: no Solar text should survive, and every module must appear.
const solarLeaks = ['Solar Photovoltaic', 'photovoltaic cell', 'IREDA'].filter((s) => docXml.includes(s));
console.log(`Solar reference text remaining: ${solarLeaks.length ? solarLeaks.join(', ') : 'none'}`);

// Compare against the document's visible text with entities decoded, since module
// titles contain "&" and are stored escaped.
const visibleText = [...docXml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
  .map((m) => m[1]!)
  .join('')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'");

const missingModules = state.modules.filter((m) => !visibleText.includes(`Module ${m.number}: ${m.title}`));
console.log(
  `Module headings present: ${state.modules.length - missingModules.length}/${state.modules.length}` +
    (missingModules.length ? `  missing: ${missingModules.map((m) => m.number).join(', ')}` : ''),
);

// Imported nodes carry their own namespace declaration, so match the tag opening
// rather than an exact "<w:tbl>".
const tableCount = (docXml.match(/<w:tbl[\s>]/g) ?? []).length;
console.log(`Tables in output: ${tableCount}`);

const expectedTables =
  1 + // front-matter metadata table
  state.modules.filter((m) => !isInsufficientSource(m.part_a)).length + // Part A
  state.modules.filter((m) => !isInsufficientSource(m.part_b)).length; // Part B
console.log(`Tables expected: ${expectedTables} (LMS tables omitted while their rows are empty)`);

for (const m of state.modules) {
  if (isInsufficientSource(m.part_a)) {
    console.log(`  M${m.number}: INSUFFICIENT_SOURCE_CONTENT rendered`);
    continue;
  }
  const unitsPresent = m.part_a.rows.filter((r) => visibleText.includes(r.unit_label)).length;
  console.log(
    `  M${m.number}: ${unitsPresent}/${m.part_a.rows.length} Part A unit rows, ` +
      `header "${m.part_a.header_label.replace('Part A: eLMS with Online Faculty Instruction ', '')}"`,
  );
}
