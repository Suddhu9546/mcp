/**
 * Retrieves the scoped source material for one module and writes it to a file,
 * so the reasoning client can read it before authoring content.
 *
 *   node scripts/dump-module-sources.mjs 1 out.md
 */

import { writeFileSync } from 'node:fs';
import { McpClient } from './mcp-client.mjs';

const moduleNumber = Number(process.argv[2] ?? 1);
const outFile = process.argv[3] ?? 'module-sources.md';

const client = await McpClient.start('C:/cvc-mcp');

const timing = await client.call('get_timing_allocation', { course_id: 'biofuels', module_number: moduleNumber });
const crosswalk = await client.call('get_module_crosswalk', { course_id: 'biofuels', module_number: moduleNumber });

const lines = [];
lines.push(`# Module ${moduleNumber} source material\n`);
lines.push(`Crosswalk: ${JSON.stringify(crosswalk.crosswalk[0])}\n`);
lines.push(`## Timing (authoritative)\n`);
lines.push(`Module total: ${timing.module.minutes} min (${timing.module.stated_hours} h)\n`);
for (const unit of timing.module.units) {
  lines.push(`- Unit ${unit.code} "${unit.title}" = ${unit.minutes} min`);
  for (const st of unit.sub_topics) lines.push(`    - ${st.code} ${st.title}`);
}
lines.push('');

// Retrieve per unit, using each unit's own title and sub-topics as the query so
// results are relevant to that unit rather than to the module as a whole.
for (const unit of timing.module.units) {
  const query = `${unit.title} ${unit.sub_topics.map((s) => s.title).join(' ')}`;
  lines.push(`\n## Unit ${unit.code} retrieval — query: ${query.slice(0, 160)}\n`);

  for (const docType of ['PH', 'FG', 'QP']) {
    const res = await client.call('search_course_content', {
      course_id: 'biofuels',
      query,
      module_number: moduleNumber,
      document_types: [docType],
      limit: docType === 'PH' ? 4 : 2,
    });
    lines.push(`### ${docType} (${res.results?.length ?? 0} hits, scope ch.${res.scope?.resolved_chapter} nos=${res.scope?.resolved_nos_code})\n`);
    for (const hit of res.results ?? []) {
      lines.push(
        `**chunk_id:** \`${hit.chunk_id}\` | pdf_page ${hit.pdf_page}` +
          `${hit.printed_page ? ` (printed ${hit.printed_page})` : ''} | ch.${hit.chapter ?? '-'} | ` +
          `unit ${hit.unit_code ?? '-'} | section: ${hit.section}`,
      );
      lines.push('```');
      lines.push(hit.content.slice(0, 1600));
      lines.push('```\n');
    }
  }
}

writeFileSync(outFile, lines.join('\n'), 'utf8');
console.log(`Wrote ${outFile} (${lines.join('\n').length} chars)`);
console.log(`stdout protocol violations: ${client.stdoutViolations.length}`);
await client.stop();
