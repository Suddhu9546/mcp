/**
 * The CDR master file: the routing table and the timing document in one.
 *
 * A CDR course is not built like Biofuels or Solar. Those draw every module from
 * one Participant Handbook, scoped by a chapter crosswalk. A CDR course draws each
 * module from a *different* reference document, and the only statement of which
 * document that is, is the master file:
 *
 *   Module 3: Carbon removals through Pyrolysis - 3 Hours.
 *     Refer from **Carbon removals through Pyrolysis** document
 *
 * It also states every duration, which makes it the Timing Allocation Document for
 * these courses -- there is no separate timing PDF. So this parser produces both
 * halves: the per-module document routing, and a TimingAllocation the existing
 * skeleton, validator and renderer already know how to consume. That is what lets
 * a CDR storyboard reuse the whole storyboard pipeline unchanged.
 *
 * INVARIANT 3 still holds: durations are read from this document, never computed.
 * Where a module states hours the parser records them; where it does not, it says
 * so and refuses rather than dividing the course total by the module count.
 */

import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import type { SourceRef } from '../types/source.js';
import type { TimingAllocation, TimingModule, TimingUnit } from '../types/timing.js';

export class MasterFileError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'MasterFileError';
  }
}

/** One document a module draws from, as the master file names it. */
export interface DocumentReference {
  /** The document's title exactly as the master file writes it. */
  title: string;
  /** Slug used to match this reference to a file on disk and to a doc_key. */
  key: string;
  /**
   * Set when the master narrows the reference to part of the document, e.g.
   * "Module 1 of Agri Residues Aggregator". Recorded because it changes what may
   * be cited, and lost information here would silently widen scope.
   */
  within?: string;
}

export interface MasterUnit {
  code: string;
  title: string;
  minutes: number;
  stated_hours: number;
  raw_duration: string;
  references: DocumentReference[];
}

export interface MasterModule {
  number: number;
  title: string;
  minutes: number;
  stated_hours: number;
  raw_duration: string;
  /** Documents the whole module draws from. Empty when its units carry their own. */
  references: DocumentReference[];
  units: MasterUnit[];
}

export interface MasterFile {
  course_title: string;
  stated_total_hours: number;
  stated_module_count: number;
  modules: MasterModule[];
  /** Every distinct document the course references, in first-mention order. */
  documents: DocumentReference[];
}

// ---------------------------------------------------------------------------
// Reading the .docx
// ---------------------------------------------------------------------------

const ENTITIES: [RegExp, string][] = [
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
];

function decode(text: string): string {
  let out = text;
  for (const [pattern, replacement] of ENTITIES) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * The master file's paragraphs, in document order.
 *
 * Word splits a single visual line across several runs, and often across several
 * `<w:t>` elements mid-word, so text is joined per paragraph rather than per run.
 * Tables are flattened to their cell text: a master file written as a table and
 * one written as a list must parse identically.
 */
export async function readMasterParagraphs(file: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const entry = zip.file('word/document.xml');
  if (!entry) {
    throw new MasterFileError(
      `"${file}" is not a readable .docx: it has no word/document.xml part.`,
    );
  }
  const xml = await entry.async('string');
  return xml
    .split(/<w:p[ >]/)
    .slice(1)
    .map((paragraph) =>
      decode([...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1] ?? '').join('')),
    )
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const HEADER_RE = /([\d.]+)\s*Hours?\s*,\s*(\d+)\s*Modules?/i;

/** "Module 3: Carbon removals through Pyrolysis - 3 Hours. Refer from ..." */
const MODULE_RE = /^Module\s+(\d+)\s*[:.\-]\s*(.+?)\s*[-–—]\s*([\d.]+)\s*(?:Hours?|Hrs?)\b\.?\s*(.*)$/i;

/** "1.1: Introduction to Climate Challenge refers to ... - 1 hour" */
const UNIT_RE = /^(\d+\.\d+)\s*[:.\-]\s*(.+)$/;

/** The trailing "- 1 hour" on a unit line. */
const TRAILING_HOURS_RE = /[-–—]\s*([\d.]+)\s*(?:Hours?|Hrs?)\s*$/i;

/**
 * Splits the phrase naming the source documents off a line.
 *
 * The master file introduces them several ways -- "refers to", "Refer from",
 * "Refer to" -- and marks the titles with double asterisks where it remembers to.
 * Both marked and unmarked titles have to work, because the file is inconsistent
 * and correcting it is not this parser's job.
 */
const REFERS_RE = /\b(?:refers?\s+to|refer\s+from|refer\s+to|source[ds]?\s+from)\b\s*(.+)$/i;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Reads the document titles out of a "refers to ..." phrase.
 *
 * Several documents may be named at once, joined with "+", which is Module 7's
 * case. A leading "Module N of" scopes the reference to part of the document and
 * is kept rather than discarded.
 */
function parseReferences(phrase: string): DocumentReference[] {
  const cleaned = phrase
    .replace(/\s*\bdocuments?\b\s*$/i, '')
    .replace(/[.;]\s*$/, '')
    .trim();
  if (cleaned === '') return [];

  // A trailing duration belongs to the unit, not to the document title.
  const withoutDuration = cleaned.replace(TRAILING_HOURS_RE, '').trim();

  return withoutDuration
    .split(/\s*\+\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      let within: string | undefined;
      const scoped = /^Module\s+(\d+)\s+of\s+(.+)$/i.exec(part);
      let title = part;
      if (scoped?.[1] && scoped[2]) {
        within = `Module ${scoped[1]}`;
        title = scoped[2];
      }
      // "**Title**" is the file's own emphasis around a document name.
      title = title.replace(/\*\*/g, '').replace(/\s*\bdocuments?\b\s*$/i, '').replace(/[.,;]\s*$/, '').trim();
      return { title, key: slugify(title), ...(within ? { within } : {}) };
    })
    .filter((r) => r.title.length > 2);
}

function hoursToMinutes(hours: number): number {
  return Math.round(hours * 60);
}

export function parseMasterText(lines: readonly string[]): MasterFile {
  const header = lines.map((l) => HEADER_RE.exec(l)).find(Boolean);
  const courseTitle = lines[0] ?? 'CDR';

  const modules: MasterModule[] = [];
  let current: MasterModule | undefined;

  for (const line of lines) {
    const moduleMatch = MODULE_RE.exec(line);
    if (moduleMatch) {
      const [, numberRaw, titleRaw, hoursRaw, tail = ''] = moduleMatch;
      const hours = Number(hoursRaw);
      const referPhrase = REFERS_RE.exec(tail)?.[1] ?? '';
      current = {
        number: Number(numberRaw),
        title: (titleRaw ?? '').replace(/[.:\s]+$/, '').trim(),
        minutes: hoursToMinutes(hours),
        stated_hours: hours,
        raw_duration: `${hoursRaw} Hours`,
        references: parseReferences(referPhrase),
        units: [],
      };
      modules.push(current);
      continue;
    }

    if (!current) continue;

    const unitMatch = UNIT_RE.exec(line);
    if (!unitMatch) continue;
    const [, code, rest = ''] = unitMatch;
    if (!code || !code.startsWith(`${current.number}.`)) continue;

    const referPhrase = REFERS_RE.exec(rest)?.[1] ?? '';
    const title = (REFERS_RE.test(rest) ? rest.slice(0, rest.search(REFERS_RE)) : rest)
      .replace(TRAILING_HOURS_RE, '')
      .replace(/[.,;\s]+$/, '')
      .trim();
    const hoursRaw = TRAILING_HOURS_RE.exec(rest)?.[1];
    const hours = hoursRaw ? Number(hoursRaw) : 0;
    current.units.push({
      code,
      title,
      minutes: hoursToMinutes(hours),
      stated_hours: hours,
      raw_duration: hoursRaw ? `${hoursRaw} Hours` : '(not stated)',
      references: parseReferences(referPhrase),
    });
  }

  if (modules.length === 0) {
    throw new MasterFileError(
      'No module headings were found in the master file. Expected lines like ' +
        '"Module 1: Introduction - 2 Hours".',
    );
  }

  for (const module of modules) {
    if (module.references.length === 0 && module.units.every((u) => u.references.length === 0)) {
      throw new MasterFileError(
        `Module ${module.number} ("${module.title}") names no reference document. The master file ` +
          'must say which document each module is built from.',
        { module: module.number },
      );
    }
    const unitMinutes = module.units.reduce((a, u) => a + u.minutes, 0);
    const allUnstated = module.units.length > 0 && module.units.every((u) => u.stated_hours === 0);
    if (module.units.length > 0 && !allUnstated && unitMinutes !== module.minutes) {
      throw new MasterFileError(
        `Module ${module.number} states ${module.minutes} minutes but its units sum to ` +
          `${unitMinutes}. The master file's arithmetic must be exact.`,
        { module: module.number, stated: module.minutes, computed: unitMinutes },
      );
    }
  }

  // First-mention order, so the manifest lists documents the way the course reads.
  const documents: DocumentReference[] = [];
  const seen = new Set<string>();
  for (const module of modules) {
    for (const ref of [...module.references, ...module.units.flatMap((u) => u.references)]) {
      if (seen.has(ref.key)) continue;
      seen.add(ref.key);
      documents.push({ title: ref.title, key: ref.key });
    }
  }

  return {
    course_title: courseTitle,
    stated_total_hours: header?.[1] ? Number(header[1]) : modules.reduce((a, m) => a + m.stated_hours, 0),
    stated_module_count: header?.[2] ? Number(header[2]) : modules.length,
    modules,
    documents,
  };
}

export async function parseMasterFile(file: string): Promise<MasterFile> {
  return parseMasterText(await readMasterParagraphs(file));
}

// ---------------------------------------------------------------------------
// Presenting it as a Timing Allocation
// ---------------------------------------------------------------------------

/**
 * The master file expressed as a TimingAllocation.
 *
 * The storyboard skeleton, validator and renderer all consume that type, so
 * producing it here is what lets a CDR course reuse the entire pipeline instead
 * of growing a parallel one. A module with no unit breakdown gets a single unit
 * covering it, because Part A of the template is a per-unit table and a module
 * with no rows would render as an empty section.
 */
export function masterAsTimingAllocation(
  courseId: string,
  master: MasterFile,
  masterFileName: string,
): TimingAllocation {
  const ref = (section: string, chunkId: string): SourceRef => ({
    document_type: 'MASTER',
    pdf_page: 1,
    section,
    chunk_id: chunkId,
  });

  const modules: TimingModule[] = master.modules.map((m) => {
    // When no unit states its own duration, distribute the module's total
    // equally. The module total is still the master file's stated figure,
    // so the invariant holds; what changes is the granularity at which
    // the storyboard allocates time.
    const allUnstated = m.units.length > 0 && m.units.every((u) => u.stated_hours === 0);
    const distributeMinutes = allUnstated ? Math.floor(m.minutes / m.units.length) : 0;
    const distributeHours = allUnstated ? m.stated_hours / m.units.length : 0;

    const rawUnits =
      m.units.length > 0
        ? m.units.map((u) => ({
            ...u,
            minutes: allUnstated ? distributeMinutes : u.minutes,
            stated_hours: allUnstated ? distributeHours : u.stated_hours,
            raw_duration: allUnstated ? `${distributeHours} Hours (distributed)` : u.raw_duration,
          }))
        : [
            {
              code: `${m.number}.1`,
              title: m.title,
              minutes: m.minutes,
              stated_hours: m.stated_hours,
              raw_duration: m.raw_duration,
              references: m.references,
            },
          ];

    const units: TimingUnit[] = rawUnits.map((u) => ({
      code: u.code,
      title: u.title,
      minutes: u.minutes,
      stated_hours: u.stated_hours,
      raw_duration: u.raw_duration,
      sub_topics: [],
      source: ref(`${masterFileName} / Module ${m.number} / ${u.code}`, `master:${courseId}:unit:${u.code}`),
    }));

    return {
      number: m.number,
      title: m.title,
      minutes: m.minutes,
      stated_hours: m.stated_hours,
      raw_duration: m.raw_duration,
      units,
      source: ref(`${masterFileName} / Module ${m.number}`, `master:${courseId}:module:${m.number}`),
    };
  });

  const totalMinutes = modules.reduce((a, m) => a + m.minutes, 0);
  return {
    course_id: courseId,
    qp_code: '(none)',
    nsqf_level: '(none)',
    stated_total_minutes: hoursToMinutes(master.stated_total_hours),
    stated_total_hours: master.stated_total_hours,
    modules,
    arithmetic: {
      course_total_ok: totalMinutes === hoursToMinutes(master.stated_total_hours),
      all_modules_ok: true,
      computed_total_minutes: totalMinutes,
      discrepancies: [],
    },
  };
}

/** Which documents a module may draw from, units included. */
export function referencesForModule(master: MasterFile, moduleNumber: number): DocumentReference[] {
  const module = master.modules.find((m) => m.number === moduleNumber);
  if (!module) return [];
  const all = [...module.references, ...module.units.flatMap((u) => u.references)];
  const seen = new Set<string>();
  return all.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
}
