/**
 * Reads a "Topics and Subtopics" .docx into the structure a Timing Allocation
 * Document needs: modules, their units, and each unit's subtopics.
 *
 * That document is the reviewed statement of what a handbook contains, so it is
 * the right input for a timing document -- it has already reconciled the cover
 * pages against the body headings, which the raw PDF text has not. Nothing here
 * invents structure; every title is carried through as printed, minus the review
 * annotations the document adds in parentheses.
 *
 *   node scripts/timing/extract-structure.mjs <in.docx> <out.json>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: extract-structure.mjs <topics.docx> <out.json>');
  process.exit(1);
}

const zip = await JSZip.loadAsync(readFileSync(input));
const xml = await zip.file('word/document.xml').async('string');

const lines = xml
  .split(/<w:p[ >]/)
  .slice(1)
  .map((p) =>
    [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((m) => m[1])
      .join('')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/·/g, '-')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  .filter(Boolean);

/** Strips the reviewer's parenthetical annotations from a subtopic heading. */
function cleanTitle(raw) {
  return raw
    .replace(/\s*\((?:number|numbered|single continuous|unnumbered)[^)]*\)\s*$/i, '')
    .replace(/\s*—\s*$/, '')
    .replace(/\.$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MODULE_RE = /^Module\s+(\d+)\s+[—-]\s+(.+)$/;
const UNIT_RE = /^UNIT\s+(\d+\.\d+)\s*[:\-]?\s+(.+)$/i;
const REF_RE = /^(\d+\.\d+\.\d+|\d+\.\d+|[A-Z]\.|\d+\.|—|-)$/;

const modules = [];
let module = null;
let unit = null;
let inTable = false;
let pendingRef = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  const mm = MODULE_RE.exec(line);
  if (mm && !/^Module\s+\d+\s+[—-]\s+(Title|NOS)/.test(line)) {
    module = { module_number: Number(mm[1]), title: mm[2].trim(), nos: null, units: [] };
    modules.push(module);
    unit = null;
    inTable = false;
    // The cover-page NOS follows a few lines down, labelled.
    for (let k = i + 1; k < Math.min(i + 8, lines.length); k++) {
      if (lines[k] === 'NOS') {
        const code = lines[k + 1];
        module.nos = /Not stated/i.test(code) ? null : code.replace(/\s+/g, ' ').trim();
        break;
      }
    }
    continue;
  }

  const um = UNIT_RE.exec(line);
  if (um && module) {
    unit = { unit_code: um[1], title: cleanTitle(um[2]), sub_topics: [] };
    module.units.push(unit);
    inTable = false;
    pendingRef = null;
    continue;
  }

  if (line === 'Ref.') {
    inTable = true;
    pendingRef = null;
    continue;
  }
  if (/^Subtopic\s*[—-]\s*heading as printed$/i.test(line)) continue;

  if (inTable && unit) {
    if (pendingRef === null && REF_RE.test(line)) {
      pendingRef = line;
      continue;
    }
    if (pendingRef !== null) {
      const title = cleanTitle(line);
      // The reviewer's "no heading in source" rows describe an absence rather
      // than name a topic, so they are not carried into the timing document.
      if (title && !/^No\s+"?\d|^No\s+“\d/i.test(title)) {
        unit.sub_topics.push({ printed_ref: pendingRef, title });
      }
      pendingRef = null;
      continue;
    }
  }
}

writeFileSync(output, JSON.stringify({ modules }, null, 2));

let units = 0;
let subs = 0;
for (const m of modules) {
  units += m.units.length;
  console.error(`M${String(m.module_number).padStart(2)}  ${m.units.length} units  NOS ${m.nos ?? '(none printed)'}  ${m.title}`);
  for (const u of m.units) {
    subs += u.sub_topics.length;
    console.error(`      ${u.unit_code}  [${String(u.sub_topics.length).padStart(2)}]  ${u.title}`);
  }
}
console.error(`\n${modules.length} modules, ${units} units, ${subs} subtopics -> ${output}`);
