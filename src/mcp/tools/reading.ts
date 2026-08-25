/**
 * Feature 2: exact Participant Handbook reading.
 *
 * One tool, deliberately. It returns text and takes no generation parameters, so
 * there is no way to ask it to summarise, shorten or restyle what it returns --
 * the separation from the storyboard feature is structural, not advisory.
 */

import { z } from 'zod';
import { findPhUnits, readPhUnit, UnitNotFoundError } from '../../documents/ph-outline.js';
import { renderUnitReading } from '../../reading/render.js';
import { resolveCourse } from './catalog.js';
import type { ToolDefinition } from './result.js';
import { fail, textResult as text } from './result.js';

const readUnitTool: ToolDefinition = {
  name: 'read_ph_unit',
  title: 'Read a handbook unit exactly',
  description:
    'Returns the Participant Handbook\'s own text for one unit, verbatim and complete, in ' +
    'document order. This is a reading operation, not a generation one: pass the text on to the ' +
    'user unchanged. Do not summarise, shorten, expand, paraphrase, re-order, re-format, correct ' +
    'or comment on it, and do not merge it with anything else. It carries a fidelity_note ' +
    'stating the only two mechanical differences from the printed page (removed running headers ' +
    'and folio numbers, removed indexing overlap); repeat that note if the user asks how exact ' +
    'this is.',
  inputSchema: {
    subject: z.string().optional().describe('Subject id, code or course_id. Omit when giving a heading to search.'),
    unit_code: z.string().optional().describe('Unit code such as "7.1". Requires subject.'),
    heading: z
      .string()
      .optional()
      .describe('Unit heading, when the user named the unit rather than its code.'),
  },
  handler: (args) => {
    const unitCode = args.unit_code ? String(args.unit_code) : undefined;
    const heading = args.heading ? String(args.heading) : undefined;
    let courseId: string;
    let resolvedUnit: string;

    if (unitCode && args.subject) {
      courseId = resolveCourse(String(args.subject)).course_id;
      resolvedUnit = unitCode;
    } else if (heading) {
      const found = findPhUnits(heading, {
        ...(args.subject ? { courseId: resolveCourse(String(args.subject)).course_id } : {}),
      });
      if (found.candidates.length === 0) {
        return fail(found.message ?? `No unit matches "${heading}".`, found);
      }
      if (!found.confident) {
        return fail(
          `"${heading}" matches more than one unit closely enough that picking one would be a ` +
            'guess. Ask the user which of these they mean, then call read_ph_unit with its ' +
            'subject and unit_code.',
          found,
        );
      }
      courseId = found.candidates[0]!.course_id;
      resolvedUnit = found.candidates[0]!.unit.unit_code;
    } else {
      return fail(
        'Give either subject + unit_code, or a heading to resolve. Use find_ph_unit or ' +
          'get_ph_outline if you have neither.',
      );
    }

    try {
      const reading = readPhUnit(courseId, resolvedUnit);
      return text(renderUnitReading(reading), {
        course_id: reading.course_id,
        subject_code: reading.subject_code,
        unit: reading.unit,
        word_count: reading.word_count,
        char_count: reading.char_count,
        chunk_ids: reading.chunk_ids,
        mode: 'EXACT_PH_TEXT',
        handling:
          'Return the text above to the user unchanged. No summarising, rewriting, re-ordering ' +
          'or additions.',
      });
    } catch (err) {
      if (err instanceof UnitNotFoundError) return fail(err.message, { available_units: err.available });
      throw err;
    }
  },
};

export const READING_TOOLS: ToolDefinition[] = [readUnitTool];
