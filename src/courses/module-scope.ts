/**
 * What a module is allowed to draw from.
 *
 * There are two kinds of course here and they answer that question differently.
 *
 *   A qualification course -- Biofuels, Solar -- carries one Participant Handbook
 *   and one Facilitator Guide. Every module is a chapter of them, and the crosswalk
 *   maps the Timing Allocation Document's module number onto that chapter number.
 *   "Which sources may module 5 cite?" means "chapter 7 of the PH and FG".
 *
 *   A CDR course carries nine unrelated reference documents and no handbook. Its
 *   master file states, per module, which document to build from. "Which sources
 *   may module 5 cite?" means "the DPR on Biomass Supply Chain Management", and
 *   chapter numbers mean nothing at all.
 *
 * Both are a scope: a predicate over chunks, plus enough information to retrieve
 * within it. Naming that one idea is what lets the skeleton, the task queue, the
 * validator and the renderer stay identical across the two, instead of the CDR
 * flow becoming a parallel copy of the storyboard flow that drifts from it.
 */

import { getCourseConfig, getCrosswalkEntry } from './course-config.js';
import type { DocumentType } from '../types/source.js';

export type ModuleScope =
  /**
   * Sources are one or more chapters of this course's PH and FG.
   *
   * Usually one: a qualification course's module is a chapter. An Orientation
   * module is a group of consecutive chapters, because the programme fixes three
   * modules per subject whatever the handbook's own chapter count is.
   */
  | { kind: 'chapter'; chapters: number[]; nos_code: string }
  /** Sources are these specific documents, whole. */
  | { kind: 'documents'; doc_keys: string[]; nos_code: string };

/** The minimum a chunk must expose for a scope to judge it. */
export interface ScopedChunk {
  document_type: DocumentType;
  chapter?: number | undefined;
  doc_key?: string | undefined;
}

/**
 * True when a chunk is inside the scope, i.e. when the module may cite it.
 *
 * A chapter scope only constrains PH and FG chunks: the Qualification Pack is not
 * chaptered, and a QP citation is scoped by NOS instead. A document scope
 * constrains everything, because for a CDR course the document is the only thing
 * that distinguishes one module's sources from another's.
 */
export function scopeAllows(scope: ModuleScope, chunk: ScopedChunk): boolean {
  if (scope.kind === 'chapter') {
    if (chunk.document_type !== 'PH' && chunk.document_type !== 'FG') return true;
    return chunk.chapter === undefined || scope.chapters.includes(chunk.chapter);
  }
  return chunk.doc_key !== undefined && scope.doc_keys.includes(chunk.doc_key);
}

/** How to describe the scope in a validation message, in the user's terms. */
export function describeScope(scope: ModuleScope): string {
  if (scope.kind !== 'chapter') return `the reference document(s) ${scope.doc_keys.join(', ')}`;
  const plural = scope.chapters.length === 1 ? 'chapter' : 'chapters';
  return `${plural} ${scope.chapters.join(', ')} of the Participant Handbook and Facilitator Guide`;
}

/**
 * The scope of one module of one course.
 *
 * A course declares `module_sources` when its modules are routed per document;
 * otherwise the crosswalk answers, exactly as before.
 */
export function moduleScope(courseId: string, moduleNumber: number): ModuleScope {
  const course = getCourseConfig(courseId);
  const routed = course.module_sources?.[moduleNumber];
  if (routed) {
    if (routed.doc_keys.length === 0) {
      throw new Error(
        `Course "${courseId}" module ${moduleNumber} routes to no reference document. The master ` +
          'file must name at least one document per module.',
      );
    }
    return { kind: 'documents', doc_keys: routed.doc_keys, nos_code: routed.nos_code ?? '(none)' };
  }
  const crosswalk = getCrosswalkEntry(courseId, moduleNumber);
  return {
    kind: 'chapter',
    chapters: crosswalk.source_chapters ?? [crosswalk.source_chapter],
    nos_code: crosswalk.nos_code,
  };
}

/** True when this course routes its modules to documents rather than chapters. */
export function isDocumentRouted(courseId: string): boolean {
  return getCourseConfig(courseId).module_sources !== undefined;
}
