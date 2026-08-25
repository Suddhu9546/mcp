/**
 * Handbook navigation.
 *
 * These tools answer "which subjects exist", "what is in this handbook" and
 * "which unit did the user mean". They generate nothing and belong to no single
 * flow, which is why they live apart from flow.ts and reading.ts.
 */

import { z } from 'zod';
import {
  COURSE_TRACKS,
  TRACK_LABELS,
  getSubject,
  listSubjectStatuses,
  type CourseTrack,
} from '../../catalog/subject-catalog.js';
import { findPhUnits, getPhOutline } from '../../documents/ph-outline.js';
import type { ToolDefinition } from './result.js';
import { fail, ok } from './result.js';

export const trackSchema = z.enum(COURSE_TRACKS as unknown as [CourseTrack, ...CourseTrack[]]);

/**
 * Resolves the subject argument to a course, refusing anything not ready.
 *
 * Every handbook-backed tool goes through this, so "which handbook am I reading"
 * is decided in exactly one place and a subject whose handbook is missing produces
 * the same actionable message everywhere rather than a retrieval that quietly
 * returns nothing.
 */
export function resolveCourse(subject: string): { course_id: string; subject_code: string } {
  const entry = getSubject(subject);
  const status = listSubjectStatuses(entry.track).find((s) => s.subject_id === entry.subject_id)!;
  if (!status.ready) {
    throw new Error(`${entry.code} is not available yet. ${status.blocker}`);
  }
  return { course_id: entry.course_id, subject_code: entry.code };
}
// ---------------------------------------------------------------------------

const listSubjectsTool: ToolDefinition = {
  name: 'list_video_subjects',
  title: 'List course types and subjects',
  description:
    'Lists the two course types and their subjects, with whether each one\'s Participant ' +
    'Handbook is present and indexed. A subject that is not ready carries the one action that ' +
    'would make it ready. Call this before offering the user a choice, so an unavailable ' +
    'subject is never offered as though it worked.',
  inputSchema: { track: trackSchema.optional().describe('Restrict to one course type.') },
  handler: (args) => {
    const track = args.track as CourseTrack | undefined;
    const statuses = listSubjectStatuses(track);
    return ok({
      tracks: (track ? [track] : COURSE_TRACKS).map((t) => ({
        track: t,
        label: TRACK_LABELS[t],
        subjects: statuses.filter((s) => s.track === t),
      })),
      ready_count: statuses.filter((s) => s.ready).length,
      subject_count: statuses.length,
    });
  },
};

const phOutlineTool: ToolDefinition = {
  name: 'get_ph_outline',
  title: 'Get Participant Handbook outline',
  description:
    'Returns a subject\'s modules and units exactly as its Participant Handbook has them, ' +
    'derived from the indexed document rather than declared anywhere, so re-ingesting a revised ' +
    'handbook updates it. Module numbers here are the handbook\'s chapter numbers; where a ' +
    'reviewed crosswalk exists the Timing Allocation module number is reported alongside as ' +
    'timing_module, and the two are never interchangeable.',
  inputSchema: {
    subject: z.string().describe('Subject id, code or course_id, e.g. "biofuels" or "Solar PV".'),
    module_number: z.number().int().optional().describe('Narrow to one module, listing its units.'),
  },
  handler: (args) => {
    const { course_id } = resolveCourse(String(args.subject));
    const outline = getPhOutline(course_id);
    if (args.module_number !== undefined) {
      const module = outline.modules.find((m) => m.module_number === Number(args.module_number));
      if (!module) {
        return fail(
          `This handbook has no module ${String(args.module_number)}. It has modules ` +
            `${outline.modules.map((m) => m.module_number).join(', ')}.`,
        );
      }
      return ok({ ...outline, modules: [module], module_count: 1, unit_count: module.unit_count });
    }
    if (outline.unit_count === 0) {
      return fail(
        `No units were found in the "${course_id}" Participant Handbook. It may not be indexed ` +
          'yet -- run ingest_course_documents for this course.',
      );
    }
    return ok(outline);
  },
};

const findUnitTool: ToolDefinition = {
  name: 'find_ph_unit',
  title: 'Find a unit by heading',
  description:
    'Resolves a unit heading the user typed to the unit, the module and the subject that holds ' +
    'it, searching every indexed Participant Handbook. This is the entry point for the ' +
    'shortcut "what does <heading> actually say". Ranking is deterministic term matching. When `confident` is false the top candidates are ' +
    'close -- ask the user which they meant rather than picking one.',
  inputSchema: {
    heading: z.string().describe('The unit heading or topic the user named, in their words.'),
    subject: z.string().optional().describe('Restrict to one subject, when the user named one.'),
    track: trackSchema.optional().describe('Restrict to one course type.'),
    limit: z.number().int().min(1).max(20).optional(),
  },
  handler: (args) => {
    const options: Parameters<typeof findPhUnits>[1] = {
      ...(args.subject ? { courseId: resolveCourse(String(args.subject)).course_id } : {}),
      ...(args.track ? { track: args.track as CourseTrack } : {}),
      ...(args.limit ? { limit: Number(args.limit) } : {}),
    };
    const result = findPhUnits(String(args.heading), options);
    return ok({
      ...result,
      next_step: result.confident
        ? 'Confident match. If the user asked what the unit says, call read_ph_unit.'
        : 'Ambiguous. Show the candidates and ask the user which unit they mean.',
    });
  },
};

export const CATALOG_TOOLS: ToolDefinition[] = [listSubjectsTool, phOutlineTool, findUnitTool];
