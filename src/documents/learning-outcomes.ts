/**
 * Learning outcome extraction.
 *
 * The handbook states its own outcomes twice: once per module, on the opener page
 * under "Key Learning Outcomes", and once per unit, under "At the end of this unit,
 * you will be able to:". Both are lists the document wrote deliberately, which
 * makes them the most reliable statement of what a module is *for* -- better than
 * anything inferred from the prose around them.
 *
 * They matter because the video's first minute is module orientation: what this is
 * about, why it matters, what the learner will be able to do. Written from prose
 * alone that minute drifts into teaching unit 1 early. Written from the outcomes it
 * says what the handbook says the module is for.
 *
 * Nothing here rewrites or summarises. An outcome is returned as the handbook
 * printed it, with its bullet or number stripped and a wrapped line rejoined.
 */

import { getDb } from '../storage/db.js';

export interface LearningOutcome {
  /** The outcome exactly as printed, minus its bullet or number. */
  text: string;
  /** Chunk it came from, so it can be cited and checked. */
  chunk_id: string;
  pdf_page: number;
}

export interface ModuleLearningOutcomes {
  course_id: string;
  module_number: number;
  /** From the module opener's "Key Learning Outcomes". */
  module_outcomes: LearningOutcome[];
  /** Per unit, from "At the end of this unit, you will be able to:". */
  unit_outcomes: { unit_code: string; unit_title: string; outcomes: LearningOutcome[] }[];
  /**
   * Set when the handbook states no module-level outcomes. Part 1 then has to be
   * built from the units' own outcomes, which is worth knowing rather than
   * discovering halfway through writing.
   */
  note?: string;
}

const TRIGGER_RE = /at the end of (?:this|the) (?:module|unit|chapter)[^:]*:/i;
const HEADING_RE = /^(key learning outcomes|unit objectives|learning outcomes)$/i;
const ITEM_RE = /^(?:[•▪◦*\-–]|\d{1,2}[.)])\s*(.+)$/;

/**
 * Reads the outcome list that follows a trigger line.
 *
 * Stops at the first line that is neither a list item nor the continuation of one,
 * because that is where the list ends and the chapter's prose begins. Wrapped items
 * are rejoined: the handbook breaks long outcomes mid-sentence, and half an outcome
 * is worse than none.
 */
function readList(lines: readonly string[], from: number): string[] {
  const items: string[] = [];
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    if (HEADING_RE.test(line)) continue;

    const item = ITEM_RE.exec(line);
    if (item) {
      items.push(item[1]!.trim());
      continue;
    }
    // A continuation of the previous item: lower-case start, no terminal colon.
    if (items.length > 0 && /^[a-z(]/.test(line) && !line.endsWith(':')) {
      items[items.length - 1] = `${items[items.length - 1]} ${line}`.replace(/\s+/g, ' ');
      continue;
    }
    break;
  }
  return items.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t.length > 8);
}

function outcomesIn(content: string, chunkId: string, pdfPage: number): LearningOutcome[] {
  const lines = content.split('\n');
  const trigger = lines.findIndex((l) => TRIGGER_RE.test(l));
  if (trigger === -1) return [];
  return readList(lines, trigger + 1).map((text) => ({ text, chunk_id: chunkId, pdf_page: pdfPage }));
}

interface Row {
  chunk_id: string;
  pdf_page: number;
  unit_code: string | null;
  content: string;
}

/**
 * Collects a module's stated outcomes: its own, and each of its units'.
 *
 * Scoped by course and chapter like every other retrieval here, so there is no path
 * by which one module's outcomes can be read into another's video.
 */
export function getModuleLearningOutcomes(
  courseId: string,
  moduleNumber: number,
  units: readonly { unit_code: string; unit_title: string }[],
): ModuleLearningOutcomes {
  const rows = getDb()
    .prepare(
      `SELECT chunk_id, pdf_page, unit_code, content FROM chunks
       WHERE course_id = ? AND document_type = 'PH' AND chapter = ?
       ORDER BY ordinal ASC`,
    )
    .all(courseId, moduleNumber) as unknown as Row[];

  const moduleOutcomes: LearningOutcome[] = [];
  const byUnit = new Map<string, LearningOutcome[]>();

  for (const row of rows) {
    const found = outcomesIn(row.content, row.chunk_id, row.pdf_page);
    if (found.length === 0) continue;
    if (row.unit_code === null) {
      // Module opener: only the first such list is the module's own.
      if (moduleOutcomes.length === 0) moduleOutcomes.push(...found);
      continue;
    }
    if (!byUnit.has(row.unit_code)) byUnit.set(row.unit_code, found);
  }

  const unitOutcomes = units.map((u) => ({
    unit_code: u.unit_code,
    unit_title: u.unit_title,
    outcomes: byUnit.get(u.unit_code) ?? [],
  }));

  const total = moduleOutcomes.length + unitOutcomes.reduce((a, u) => a + u.outcomes.length, 0);
  return {
    course_id: courseId,
    module_number: moduleNumber,
    module_outcomes: moduleOutcomes,
    unit_outcomes: unitOutcomes,
    ...(moduleOutcomes.length === 0
      ? {
          note:
            total === 0
              ? 'The handbook states no learning outcomes for this module or its units. Build the ' +
                'orientation from what the units actually teach, and say so if asked.'
              : 'The handbook states no module-level outcomes. Build the module orientation from ' +
                'the units\' own stated outcomes below, in order.',
        }
      : {}),
  };
}
