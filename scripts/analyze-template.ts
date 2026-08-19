/**
 * Inspects the storyboard template and writes the derived Template Map.
 *
 *   npm run analyze-template
 */

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { analyzeTemplate } from '../src/docx/template-analyzer.js';
import { config } from '../src/util/config.js';

const file = process.argv[2] ?? path.join(config.paths.templates, 'storyboard-template-v1.docx');
const { map, prototypes } = await analyzeTemplate(file);

console.log(`\nTemplate:   ${path.basename(map.source_file)}  (version ${map.template_version})`);
console.log(`Blocks:     ${map.total_blocks}   Tables: ${map.total_tables}`);
console.log(`Parts:      ${map.package_parts.length}`);
console.log(`\nParagraph styles in use:`);
for (const [style, count] of Object.entries(map.paragraph_styles).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(count).padStart(5)}  ${style}`);
}

console.log(`\nFront matter:`);
console.log(`   blueprint heading: "${map.front_matter.blueprint_heading_text}"`);
console.log(
  `   metadata table:    ${map.front_matter.metadata_table?.row_count ?? 0} rows x ` +
    `${map.front_matter.metadata_table?.columns ?? 0} cols`,
);
console.log(`   guideline groups:  ${map.front_matter.guideline_groups.join(' | ')}`);
console.log(`   guideline bullets: ${map.front_matter.guideline_bullet_count}`);

console.log(`\nModules discovered: ${map.modules.length}`);
for (const m of map.modules) {
  const shape = (t: { columns: number; row_count: number } | null | undefined) =>
    t ? `${t.row_count}r x ${t.columns}c` : 'MISSING';
  console.log(
    `   M${String(m.module_number).padStart(2)}  blocks ${m.start_block}-${m.end_block}  ` +
      `A:${shape(m.part_a?.table)}  LMS:${shape(m.lms_mapping?.table)}  ` +
      `B:${shape(m.part_b?.table)}  C:${m.part_c ? `${m.part_c.slide_count} slides` : 'MISSING'}  ` +
      `${m.duration_text}`,
  );
}

const a = map.modules[0];
if (a?.part_a) console.log(`\nPart A header cells:   ${JSON.stringify(a.part_a.table.header_cells)}`);
if (a?.lms_mapping) console.log(`LMS header cells:      ${JSON.stringify(a.lms_mapping.table.header_cells)}`);
if (a?.part_b) console.log(`Part B header cells:   ${JSON.stringify(a.part_b.table.header_cells)}`);

if (map.assessment) {
  console.log(`\nAssessment section:`);
  console.log(`   heading:          "${map.assessment.heading_text}"`);
  console.log(`   strategy points:  ${map.assessment.strategy_point_count}`);
  console.log(`   bank groups:      ${map.assessment.question_bank_groups.length}`);
  console.log(`   questions:        ${map.assessment.question_count}`);
}

console.log(`\nClone prototypes extracted: ${Object.keys(prototypes).length}`);
for (const [name, xml] of Object.entries(prototypes)) {
  console.log(`   ${name.padEnd(26)} ${String(xml.length).padStart(7)} bytes`);
}

const outDir = path.join(config.paths.root, 'data');
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, 'template-map-v1.json');
await writeFile(outFile, JSON.stringify(map, null, 2), 'utf8');
console.log(`\nTemplate map written to ${path.relative(config.paths.root, outFile)}`);
