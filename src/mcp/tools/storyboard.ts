/**
 * Feature 2: the course storyboard and assessment blueprint.
 *
 * These tools stand alone. They use the Timing Allocation Document's module
 * numbering and the SCGJ .docx template, neither of which the other features
 * touch, and they share nothing with them but ./result.ts.
 *
 * Division of responsibility:
 *
 *   Client (Antigravity / Gemini)        This server
 *   ------------------------------       ------------------------------
 *   decides which tools to call          executes the requested operation
 *   decides the order                    returns structured results
 *   writes the storyboard content        supplies scoped source material
 *   interprets validation findings       reports findings mechanically
 *   decides how to fix problems          never edits content on its own
 *
 * Every handler is a pure function of its arguments plus the indexed corpus. None
 * of them calls a model, and none of them writes content the client did not
 * supply. Where an operation cannot be completed from the approved documents, the
 * tool says so rather than substituting a guess.
 */

import { z } from 'zod';
import path from 'node:path';
import { DOCUMENT_TYPES, isInsufficientSource, type DocumentType } from '../../types/source.js';
import type { StoryboardState } from '../../types/storyboard.js';
import { courseDir, getCourseConfig, listCourses } from '../../courses/course-config.js';
import { getCourseDocumentStatus, ingestCourse } from '../../documents/ingest.js';
import {
  chapterForModule,
  getChunk,
  getPageChunks,
  nosForModule,
  searchCourseContent,
} from '../../documents/retriever.js';
import { analyzeTemplate, type AnalyzedTemplate } from '../../docx/template-analyzer.js';
import { renderStoryboardDocx } from '../../docx/docx-writer.js';
import { buildSkeleton } from '../../storyboard/skeleton.js';
import { validateStoryboard } from '../../storyboard/validator.js';
import { parseTimingDocument } from '../../timing/timing-parser.js';
import { masterAsTimingAllocation, parseMasterFile } from '../../cdr/master-file.js';
import { withValidatedArithmetic } from '../../timing/timing-validator.js';
import type { TimingAllocation } from '../../types/timing.js';
import type { ChangeInput } from '../../storage/artifact-store.js';
import {
  attachDocx,
  commitVersion,
  createArtifact,
  getArtifact,
  getState,
  listArtifacts,
  listChanges,
  listVersions,
  rollback,
} from '../../storage/artifact-store.js';
import { config, templateFile } from '../../util/config.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const documentTypeSchema = z.enum(DOCUMENT_TYPES as unknown as [DocumentType, ...DocumentType[]]);

/** Caches parsed timing per course; the PDF does not change between calls. */
const timingCache = new Map<string, TimingAllocation>();

async function loadTiming(courseId: string): Promise<TimingAllocation> {
  const cached = timingCache.get(courseId);
  if (cached) return cached;
  const course = getCourseConfig(courseId);

  // A CDR course has no Timing Allocation Document: its master file states every
  // duration alongside the routing, so the master is the timing authority. Both
  // paths produce the same TimingAllocation, which is what lets the skeleton, the
  // validator and the renderer stay identical across the two kinds of course.
  const source =
    course.kind === 'cdr'
      ? await loadMasterAllocation(courseId, course)
      : await (async () => {
          const doc = course.documents.find((d) => d.document_type === 'TIMING');
          if (!doc) {
            throw new Error(`Course "${courseId}" has no Timing Allocation Document configured.`);
          }
          return parseTimingDocument(courseId, path.join(courseDir(courseId), doc.file));
        })();

  const allocation = withValidatedArithmetic(source);
  timingCache.set(courseId, allocation);
  return allocation;
}

async function loadMasterAllocation(
  courseId: string,
  course: ReturnType<typeof getCourseConfig>,
): Promise<TimingAllocation> {
  const doc = course.documents.find((d) => d.document_type === 'MASTER');
  if (!doc) throw new Error(`CDR course "${courseId}" has no master file configured.`);
  const file = path.join(courseDir(courseId), doc.file);
  const master = await parseMasterFile(file);
  return masterAsTimingAllocation(courseId, master, doc.file);
}

/** Caches the analyzed template; analysis parses a 700KB XML part. */
const templateCache = new Map<string, AnalyzedTemplate>();

async function loadTemplate(version: string): Promise<AnalyzedTemplate> {
  const cached = templateCache.get(version);
  if (cached) return cached;
  const analyzed = await analyzeTemplate(templateFile(version), version);
  templateCache.set(version, analyzed);
  return analyzed;
}

import type { ToolDefinition } from './result.js';
import { fail, ok } from './result.js';

/**
 * What is still unwritten, per module.
 *
 * Every write tool reports this, because a storyboard is filled over dozens of
 * calls and the client has no other way to know whether it is finished. Telling
 * it to validate and render after a single successful write -- which is what
 * these tools used to do -- reads as "you are done" and produces a one-module
 * document, so the instruction to move on is only given when nothing is left.
 *
 * The validator is the source of truth rather than a second implementation of
 * "empty": it already reports empty_field per path, and a field it does not
 * complain about is a field that does not need writing.
 */
function outstandingWork(state: StoryboardState, allocation: TimingAllocation) {
  const report = validateStoryboard({ state, allocation });
  const findings = [
    ...report.levels.content.findings,
    ...report.levels.structure.findings,
  ].filter((f) => f.severity === 'error' && /^(empty_field|empty_option|no_questions|lms_mapping_empty)$/.test(f.code));

  const byModule = new Map<number, number>();
  for (const f of findings) {
    const m = /modules\[(\d+)\]/.exec(f.path);
    const number = m?.[1] ? Number(m[1]) : 0;
    byModule.set(number, (byModule.get(number) ?? 0) + 1);
  }

  const modules = state.modules
    .map((m) => ({
      module: m.number,
      title: m.title,
      empty_fields: byModule.get(m.number) ?? 0,
      insufficient_source: isInsufficientSource(m.part_a),
    }))
    .filter((m) => m.empty_fields > 0 && !m.insufficient_source);

  return {
    complete: modules.length === 0,
    modules_remaining: modules.length,
    empty_fields_remaining: modules.reduce((a, m) => a + m.empty_fields, 0),
    next_module: modules[0]?.module,
    remaining: modules,
  };
}

/** The instruction that goes with `outstandingWork`, phrased as work to do. */
function continueInstruction(work: ReturnType<typeof outstandingWork>): string {
  if (work.complete) {
    return (
      'Every module is filled. Call validate_storyboard, act on any findings, then ' +
      'render_storyboard_docx and attach the .docx it returns.'
    );
  }
  return (
    `NOT FINISHED. ${work.empty_fields_remaining} fields across ${work.modules_remaining} ` +
    `module(s) are still empty. Continue now with module ${work.next_module}: call ` +
    'search_course_content for it, then set_storyboard_content. Do not validate, do not render, ' +
    'and do not stop to summarise progress or ask whether to continue -- keep going module by ' +
    'module until this reports complete. The deliverable is the rendered .docx, not the draft.'
  );
}

// ---------------------------------------------------------------------------
// Course and document tools
// ---------------------------------------------------------------------------

const listCoursesTool: ToolDefinition = {
  name: 'list_courses',
  title: 'List courses',
  description:
    'Lists every registered course with its QP code, NSQF level, module count and the ' +
    'presence/index status of its four approved source documents (QP, PH, FG, TIMING). ' +
    'Call this first to discover valid course_id values.',
  inputSchema: {},
  handler: () =>
    ok({
      courses: listCourses().map((c) => ({
        course_id: c.course_id,
        name: c.name,
        qp_code: c.qp_code,
        nsqf_level: c.nsqf_level,
        module_count: c.crosswalk.length,
        documents: getCourseDocumentStatus(c.course_id),
      })),
    }),
};

const getCourseManifestTool: ToolDefinition = {
  name: 'get_course_manifest',
  title: 'Get course manifest',
  description:
    'Full manifest for one course: metadata, approved document status, and the module ' +
    'crosswalk. The crosswalk is essential -- it maps each Timing-Allocation module number ' +
    'to the Participant Handbook / Faculty Guide chapter and the NOS code that hold its ' +
    'content. These numbers disagree (timing module 5 is handbook chapter 7), so always ' +
    'scope retrieval using the crosswalk rather than the module number.',
  inputSchema: { course_id: z.string().describe('Course identifier, e.g. "biofuels".') },
  handler: (args) => {
    const courseId = String(args.course_id);
    const course = getCourseConfig(courseId);
    return ok({
      course_id: course.course_id,
      name: course.name,
      qp_code: course.qp_code,
      nsqf_level: course.nsqf_level,
      sector: course.sector,
      sub_sector: course.sub_sector,
      occupation: course.occupation,
      reference_id: course.reference_id,
      documents: getCourseDocumentStatus(courseId),
      chapter_titles: course.chapter_titles,
      crosswalk: course.crosswalk,
    });
  },
};

const ingestTool: ToolDefinition = {
  name: 'ingest_course_documents',
  title: 'Ingest course documents',
  description:
    'Extracts, chunks and indexes a course\'s approved PDFs for retrieval. Idempotent: ' +
    'documents whose checksum is unchanged are skipped unless force is true. Must be run ' +
    'once per course before search_course_content returns anything.',
  inputSchema: {
    course_id: z.string(),
    force: z.boolean().optional().describe('Re-index even if the document checksum is unchanged.'),
    document_types: z.array(documentTypeSchema).optional().describe('Restrict to these document types.'),
  },
  handler: async (args) => {
    const result = await ingestCourse(String(args.course_id), {
      ...(args.force !== undefined ? { force: Boolean(args.force) } : {}),
      ...(Array.isArray(args.document_types) ? { documentTypes: args.document_types as DocumentType[] } : {}),
    });
    return ok(result);
  },
};

const searchTool: ToolDefinition = {
  name: 'search_course_content',
  title: 'Search course content',
  description:
    'Deterministic BM25 search over one course\'s approved documents. Results are always ' +
    'scoped to the given course; there is no way to retrieve another course\'s content. ' +
    'Narrow further with document_types, and with either chapter (for PH/FG) or nos_code ' +
    '(for the QP) -- use get_module_crosswalk or module_number to get the right values. ' +
    'Each result carries a chunk_id, which is what you must cite in generated content.',
  inputSchema: {
    course_id: z.string(),
    query: z.string().describe('Search terms. Punctuation is handled; terms are OR-ed and ranked.'),
    document_types: z
      .array(documentTypeSchema)
      .optional()
      .describe('Defaults to ["QP","PH","FG"]. Pass ["TIMING"] only to inspect timing text.'),
    module_number: z
      .number()
      .int()
      .optional()
      .describe(
        'Timing-Allocation module number. Convenience: resolves via the crosswalk to the ' +
          'correct PH/FG chapter and QP NOS code automatically. Prefer this over chapter.',
      ),
    chapter: z.number().int().optional().describe('PH/FG chapter number. Ignored if module_number is given.'),
    nos_code: z.string().optional().describe('QP NOS code, e.g. "SGJ/N4105".'),
    unit_code: z.string().optional().describe('Unit code, e.g. "7.1".'),
    limit: z.number().int().min(1).max(config.search.maxLimit).optional(),
  },
  handler: (args) => {
    const courseId = String(args.course_id);
    const moduleNumber = args.module_number as number | undefined;

    // module_number is a convenience that applies the crosswalk, which is the
    // whole point of having one: the caller should not have to remember that
    // module 5 lives in chapter 7.
    // REF is in the default set so a CDR course's reference documents are
    // searchable without the caller having to know the course is a CDR one.
    const requestedTypes =
      (args.document_types as DocumentType[] | undefined) ?? ['QP', 'PH', 'FG', 'REF'];
    const results: ReturnType<typeof searchCourseContent> = [];

    if (moduleNumber !== undefined) {
      const chapter = chapterForModule(courseId, moduleNumber);
      const nos = nosForModule(courseId, moduleNumber);

      const phFg = requestedTypes.filter((t) => t === 'PH' || t === 'FG');
      if (phFg.length > 0) {
        results.push(
          ...searchCourseContent({
            courseId,
            query: String(args.query),
            documentTypes: phFg,
            chapter,
            ...(args.unit_code ? { unitCode: String(args.unit_code) } : {}),
            ...(args.limit ? { limit: Number(args.limit) } : {}),
          }),
        );
      }
      if (requestedTypes.includes('QP')) {
        results.push(
          ...searchCourseContent({
            courseId,
            query: String(args.query),
            documentTypes: ['QP'],
            nosCode: nos,
            ...(args.limit ? { limit: Number(args.limit) } : {}),
          }),
        );
      }
      if (requestedTypes.includes('TIMING')) {
        results.push(
          ...searchCourseContent({
            courseId,
            query: String(args.query),
            documentTypes: ['TIMING'],
            ...(args.limit ? { limit: Number(args.limit) } : {}),
          }),
        );
      }
      results.sort((a, b) => b.score - a.score);
      return ok({
        scope: { course_id: courseId, module_number: moduleNumber, resolved_chapter: chapter, resolved_nos_code: nos },
        result_count: results.length,
        results,
      });
    }

    const hits = searchCourseContent({
      courseId,
      query: String(args.query),
      documentTypes: requestedTypes,
      ...(args.chapter !== undefined ? { chapter: Number(args.chapter) } : {}),
      ...(args.nos_code ? { nosCode: String(args.nos_code) } : {}),
      ...(args.unit_code ? { unitCode: String(args.unit_code) } : {}),
      ...(args.limit ? { limit: Number(args.limit) } : {}),
    });
    return ok({ scope: { course_id: courseId }, result_count: hits.length, results: hits });
  },
};

const getChunkTool: ToolDefinition = {
  name: 'get_source_chunk',
  title: 'Get source chunk',
  description:
    'Fetches one indexed chunk verbatim by chunk_id, scoped to a course. Use it to re-read ' +
    'the exact text behind a citation, or to verify a citation resolves before committing content.',
  inputSchema: { course_id: z.string(), chunk_id: z.string() },
  handler: (args) => {
    const chunk = getChunk(String(args.course_id), String(args.chunk_id));
    if (!chunk) {
      return fail(
        `No chunk "${String(args.chunk_id)}" in course "${String(args.course_id)}". ` +
          'Re-run search_course_content and cite a chunk_id it returned.',
      );
    }
    return ok(chunk);
  },
};

const getPageTool: ToolDefinition = {
  name: 'get_document_page',
  title: 'Get document page',
  description:
    'Returns every chunk on one PDF page of one approved document, in reading order. Use it ' +
    'to widen context around a search hit, or to read a page a citation points at.',
  inputSchema: {
    course_id: z.string(),
    document_type: documentTypeSchema,
    pdf_page: z.number().int().min(1).describe('1-based index within the PDF file, not the printed page number.'),
  },
  handler: (args) => {
    const chunks = getPageChunks(
      String(args.course_id),
      args.document_type as DocumentType,
      Number(args.pdf_page),
    );
    return ok({ page: Number(args.pdf_page), chunk_count: chunks.length, chunks });
  },
};

// ---------------------------------------------------------------------------
// Crosswalk and timing tools
// ---------------------------------------------------------------------------

const crosswalkTool: ToolDefinition = {
  name: 'get_module_crosswalk',
  title: 'Get module crosswalk',
  description:
    'Resolves Timing-Allocation module numbers to the PH/FG chapter and NOS code that hold ' +
    'their source content, and flags modules the approved documents cannot support. Omit ' +
    'module_number for the whole table.',
  inputSchema: { course_id: z.string(), module_number: z.number().int().optional() },
  handler: (args) => {
    const course = getCourseConfig(String(args.course_id));
    const entries =
      args.module_number !== undefined
        ? course.crosswalk.filter((c) => c.timing_module === Number(args.module_number))
        : course.crosswalk;
    if (entries.length === 0) {
      return fail(`Course "${course.course_id}" has no module ${String(args.module_number)}.`);
    }
    return ok({ course_id: course.course_id, crosswalk: entries });
  },
};

const timingTool: ToolDefinition = {
  name: 'get_timing_allocation',
  title: 'Get timing allocation',
  description:
    'Parses the Timing Allocation Document and returns the authoritative durations: module ' +
    'totals, per-unit minutes, sub-topics, and a page citation for every value. This is the ' +
    'only source of timing -- never compute or assume a duration. Optionally narrow to one module.',
  inputSchema: { course_id: z.string(), module_number: z.number().int().optional() },
  handler: async (args) => {
    const allocation = await loadTiming(String(args.course_id));
    if (args.module_number !== undefined) {
      const module = allocation.modules.find((m) => m.number === Number(args.module_number));
      if (!module) return fail(`Module ${String(args.module_number)} is not in the Timing Allocation Document.`);
      return ok({ course_id: allocation.course_id, module });
    }
    return ok(allocation);
  },
};

const validateTimingTool: ToolDefinition = {
  name: 'validate_timing_allocation',
  title: 'Validate timing allocation',
  description:
    'Checks the Timing Allocation Document\'s internal arithmetic: unit minutes sum to their ' +
    'module total, module totals sum to the stated course total, and each unit\'s stated hours ' +
    'match its stated minutes. Reports discrepancies without repairing them.',
  inputSchema: { course_id: z.string() },
  handler: async (args) => {
    const allocation = await loadTiming(String(args.course_id));
    return ok({
      course_id: allocation.course_id,
      stated_total_minutes: allocation.stated_total_minutes,
      module_count: allocation.modules.length,
      unit_count: allocation.modules.reduce((a, m) => a + m.units.length, 0),
      ...allocation.arithmetic,
    });
  },
};

// ---------------------------------------------------------------------------
// Template tools
// ---------------------------------------------------------------------------

const analyzeTemplateTool: ToolDefinition = {
  name: 'analyze_storyboard_template',
  title: 'Analyze storyboard template',
  description:
    'Inspects the storyboard DOCX template and returns its derived structure: per-module ' +
    'table shapes, exact column headers, slide counts, paragraph styles and the assessment ' +
    'section. Read this before generating content so the content you produce matches the ' +
    'shapes the template requires. Formatting is preserved automatically by the renderer; ' +
    'you never need to specify fonts, colours or layout.',
  inputSchema: { template_version: z.string().optional().describe('Defaults to "v1".') },
  handler: async (args) => {
    const version = args.template_version ? String(args.template_version) : 'v1';
    const { map } = await loadTemplate(version);
    return ok({
      ...map,
      // The prototype XML is an internal rendering detail and would be noise here.
      note:
        'Content cells are populated from storyboard state via set_storyboard_content. ' +
        'Part B is always 5 three-minute segments and Part C always 7 slides; both are fixed ' +
        'by the template.',
    });
  },
};

// ---------------------------------------------------------------------------
// Storyboard tools
// ---------------------------------------------------------------------------

const createDraftTool: ToolDefinition = {
  name: 'create_storyboard_draft',
  title: 'Create storyboard draft',
  description:
    'Creates a new storyboard artifact as version 1, pre-populated with everything derivable ' +
    'from the approved documents: modules, unit codes and titles, authoritative durations with ' +
    'provenance, correlation NOS codes, and empty rows/slides of the correct shape. Content ' +
    'fields are left blank for you to fill via set_storyboard_content. Modules the sources ' +
    'cannot support are marked INSUFFICIENT_SOURCE_CONTENT rather than invented.',
  inputSchema: {
    course_id: z.string(),
    template_version: z.string().optional().describe('Defaults to "v1".'),
    timing_strategy: z
      .enum(['part_a_verbatim', 'part_a_minus_30', 'part_a_carve_last_unit'])
      .optional()
      .describe(
        'How Part A durations derive from the timing document. Defaults to part_a_verbatim, ' +
          'which copies stated unit minutes unchanged.',
      ),
    modules: z.array(z.number().int()).optional().describe('Restrict to these module numbers. Defaults to all.'),
    note: z.string().optional(),
  },
  handler: async (args) => {
    const courseId = String(args.course_id);
    const templateVersion = args.template_version ? String(args.template_version) : 'v1';
    const allocation = await loadTiming(courseId);

    // Refuse rather than produce a storyboard on untrustworthy timing.
    if (!allocation.arithmetic.course_total_ok || !allocation.arithmetic.all_modules_ok) {
      return fail(
        'The Timing Allocation Document failed arithmetic validation, so durations cannot be ' +
          'established. Fix the source document or call validate_timing_allocation for detail.',
        allocation.arithmetic.discrepancies,
      );
    }

    const missing = getCourseDocumentStatus(courseId).filter((d) => !d.present);
    if (missing.length > 0) {
      // Named by file, not by type: a CDR course holds nine documents of type
      // REF, so listing types would report "REF, REF, REF" and tell the user
      // nothing about which files to supply.
      return fail(
        'Cannot create a storyboard: approved source documents are missing. Supply ' +
          `${missing.map((m) => `${m.file_path}${m.title ? ` ("${m.title}")` : ''}`).join(', ')}.`,
        missing,
      );
    }

    const state = buildSkeleton({
      courseId,
      allocation,
      templateVersion,
      ...(args.timing_strategy ? { timingStrategy: args.timing_strategy as never } : {}),
      ...(Array.isArray(args.modules) ? { modules: args.modules as number[] } : {}),
    });

    const artifact = createArtifact({
      course_id: courseId,
      template_version: templateVersion,
      timing_strategy: state.timing_strategy,
      state,
      ...(args.note ? { note: String(args.note) } : {}),
    });

    return ok({
      artifact_id: artifact.artifact_id,
      version: artifact.current_version,
      course_id: courseId,
      timing_strategy: artifact.timing_strategy,
      module_count: state.modules.length,
      modules: state.modules.map((m) => ({
        number: m.number,
        title: m.title,
        duration_minutes: m.duration.minutes,
        source_chapter: m.source_chapter,
        nos_code: m.nos_code,
        part_a_rows: isInsufficientSource(m.part_a) ? 0 : m.part_a.rows.length,
        insufficient_source: isInsufficientSource(m.part_a),
      })),
      work: outstandingWork(state, allocation),
      next_call: { tool: 'storyboard_next_task', args: { artifact_id: artifact.artifact_id } },
      next_step:
        'This draft is an empty skeleton, not a deliverable -- do not report it to the user as ' +
        'though the storyboard were built, and do not ask whether to proceed. Call ' +
        'storyboard_next_task with this artifact_id now. It hands you one small task at a time ' +
        'with the handbook text already attached; write its fields, call storyboard_submit_task, ' +
        'and repeat until it returns status READY_TO_RENDER. Then validate_storyboard and ' +
        'render_storyboard_docx, and give the user the file.',
    });
  },
};

const getStoryboardTool: ToolDefinition = {
  name: 'get_storyboard',
  title: 'Get storyboard',
  description:
    'Returns a storyboard\'s state. Defaults to the current version. Narrow to one module to ' +
    'keep the payload small while filling content.',
  inputSchema: {
    artifact_id: z.string(),
    version: z.number().int().optional(),
    module_number: z.number().int().optional(),
  },
  handler: (args) => {
    const state = getState(
      String(args.artifact_id),
      args.version !== undefined ? Number(args.version) : undefined,
    );
    if (args.module_number !== undefined) {
      const module = state.modules.find((m) => m.number === Number(args.module_number));
      if (!module) return fail(`Storyboard has no module ${String(args.module_number)}.`);
      return ok({
        artifact_id: state.artifact_id,
        course_id: state.course_id,
        version: state.version,
        template_version: state.template_version,
        timing_strategy: state.timing_strategy,
        module,
      });
    }
    return ok(state);
  },
};

const listStoryboardsTool: ToolDefinition = {
  name: 'list_storyboards',
  title: 'List storyboards',
  description: 'Lists storyboard artifacts, optionally filtered by course.',
  inputSchema: { course_id: z.string().optional() },
  handler: (args) =>
    ok({ artifacts: listArtifacts(args.course_id ? String(args.course_id) : undefined) }),
};

/**
 * Content submission.
 *
 * Accepts a partial patch keyed by the state's own identifiers (row_id, slide_id)
 * so the client never has to reason about array positions, and applies it to a
 * fresh copy of the current version. Anything not mentioned is left untouched --
 * this is what keeps edits incremental (INVARIANT 8).
 */
const sourceRefSchema = z.object({
  document_type: documentTypeSchema,
  pdf_page: z.number().int(),
  printed_page: z.number().int().optional(),
  section: z.string(),
  subsection: z.string().optional(),
  chunk_id: z.string(),
  quote: z.string().optional(),
});

const setContentTool: ToolDefinition = {
  name: 'set_storyboard_content',
  title: 'Set storyboard content',
  description:
    'Writes generated content into a storyboard and commits it as a new version. Address ' +
    'rows and slides by their row_id / slide_id from get_storyboard; anything you do not ' +
    'mention is left unchanged, so this is safe for incremental edits. Every content field ' +
    'should carry sources citing chunk_ids returned by search_course_content -- ' +
    'validate_storyboard checks that they resolve and are in the right chapter. Durations, ' +
    'unit codes and unit titles are not writable here: they come from the Timing Allocation ' +
    'Document. Use modify_storyboard_timing if a duration genuinely needs to change.',
  inputSchema: {
    artifact_id: z.string(),
    base_version: z.number().int().describe('The version you read. Rejected if it is no longer current.'),
    module_number: z.number().int(),
    module_description: z.string().optional(),
    module_description_sources: z
      .array(sourceRefSchema)
      .optional()
      .describe('Citations for module_description. Required whenever the description is set.'),
    part_c_subtitle: z.string().optional(),
    part_a_rows: z
      .array(
        z.object({
          row_id: z.string(),
          activity_name: z.string().optional(),
          interactive_description: z.string().optional(),
          correlation: z.string().optional().describe('e.g. "SGJ/N4105 / PC1, PC3".'),
          performance_criteria: z.array(z.string()).optional(),
          sources: z.array(sourceRefSchema).optional(),
        }),
      )
      .optional(),
    lms_rows: z
      .array(
        z.object({
          row_id: z.string().optional().describe('Omit to append a new row.'),
          unit_range: z.string().describe('e.g. "7.1-7.2" or "7.3".'),
          activity_type: z.string().describe('Must match a Part A activity_name in this module.'),
          recommended_standard: z.enum(['xAPI', 'SCORM 2004', 'SCORM 1.2']),
          tracking: z.string(),
          completion_criteria: z.string(),
          sources: z.array(sourceRefSchema).optional(),
        }),
      )
      .optional()
      .describe('Replaces the module\'s LMS Technical Mapping rows entirely.'),
    part_b_rows: z
      .array(
        z.object({
          row_id: z.string(),
          visual: z.string().optional(),
          gfx: z.string().optional(),
          audio: z.string().optional(),
          sources: z.array(sourceRefSchema).optional(),
        }),
      )
      .optional(),
    slides: z
      .array(
        z.object({
          slide_id: z.string(),
          title: z.string().optional(),
          visual_cues: z.string().optional(),
          instructor_script: z.string().optional(),
          sources: z.array(sourceRefSchema).optional(),
        }),
      )
      .optional(),
    note: z.string().optional().describe('Recorded in the change log for this version.'),
  },
  handler: async (args) => {
    const artifactId = String(args.artifact_id);
    const baseVersion = Number(args.base_version);
    const moduleNumber = Number(args.module_number);

    const state = structuredClone(getState(artifactId)) as StoryboardState;
    const module = state.modules.find((m) => m.number === moduleNumber);
    if (!module) return fail(`Storyboard has no module ${moduleNumber}.`);

    const changes: ChangeInput[] = [];
    const errors: string[] = [];

    if (typeof args.module_description === 'string') {
      changes.push({
        target: { kind: 'module_description', module: moduleNumber },
        field: 'description',
        change_type: 'updated',
        old_value: typeof module.description === 'string' ? module.description : '(insufficient source)',
        new_value: args.module_description,
        ...(args.note ? { reason: String(args.note) } : {}),
      });
      module.description = args.module_description;
      if (Array.isArray(args.module_description_sources)) {
        module.description_sources = args.module_description_sources as never;
      }
    }

    // --- Part A ---------------------------------------------------------
    if (Array.isArray(args.part_a_rows)) {
      if (isInsufficientSource(module.part_a)) {
        errors.push(`Module ${moduleNumber} has no Part A: ${module.part_a.message}`);
      } else {
        for (const patch of args.part_a_rows as Record<string, unknown>[]) {
          const row = module.part_a.rows.find((r) => r.row_id === patch.row_id);
          if (!row) {
            errors.push(
              `No Part A row "${String(patch.row_id)}" in module ${moduleNumber}. ` +
                `Valid row_ids: ${module.part_a.rows.map((r) => r.row_id).join(', ')}.`,
            );
            continue;
          }
          for (const field of ['activity_name', 'interactive_description', 'correlation'] as const) {
            if (typeof patch[field] === 'string') {
              changes.push({
                target: { kind: 'part_a_cell', module: moduleNumber, row_id: row.row_id, field },
                field,
                change_type: 'updated',
                old_value: row[field],
                new_value: patch[field] as string,
                ...(Array.isArray(patch.sources) ? { sources: patch.sources as never } : {}),
              });
              row[field] = patch[field] as string;
            }
          }
          if (Array.isArray(patch.performance_criteria)) row.performance_criteria = patch.performance_criteria as string[];
          if (Array.isArray(patch.sources)) row.sources = patch.sources as never;
        }
      }
    }

    // --- LMS mapping ----------------------------------------------------
    if (Array.isArray(args.lms_rows)) {
      if (isInsufficientSource(module.lms_mapping)) {
        errors.push(`Module ${moduleNumber} has no LMS mapping section.`);
      } else {
        const rows = (args.lms_rows as Record<string, unknown>[]).map((r, i) => ({
          row_id: typeof r.row_id === 'string' ? r.row_id : `m${String(moduleNumber).padStart(2, '0')}-lms-${i + 1}`,
          unit_range: String(r.unit_range),
          activity_type: String(r.activity_type),
          recommended_standard: r.recommended_standard as 'xAPI' | 'SCORM 2004' | 'SCORM 1.2',
          tracking: String(r.tracking),
          completion_criteria: String(r.completion_criteria),
          sources: (Array.isArray(r.sources) ? r.sources : []) as never,
        }));
        changes.push({
          target: { kind: 'module', module: moduleNumber },
          field: 'lms_mapping.rows',
          change_type: 'replaced',
          old_value: String(module.lms_mapping.rows.length),
          new_value: String(rows.length),
          ...(args.note ? { reason: String(args.note) } : {}),
        });
        module.lms_mapping = { rows };
      }
    }

    // --- Part B ---------------------------------------------------------
    if (Array.isArray(args.part_b_rows)) {
      if (isInsufficientSource(module.part_b)) {
        errors.push(`Module ${moduleNumber} has no Part B section.`);
      } else {
        for (const patch of args.part_b_rows as Record<string, unknown>[]) {
          const row = module.part_b.rows.find((r) => r.row_id === patch.row_id);
          if (!row) {
            errors.push(
              `No Part B row "${String(patch.row_id)}" in module ${moduleNumber}. ` +
                `Valid row_ids: ${module.part_b.rows.map((r) => r.row_id).join(', ')}.`,
            );
            continue;
          }
          for (const field of ['visual', 'gfx', 'audio'] as const) {
            if (typeof patch[field] === 'string') {
              changes.push({
                target: { kind: 'part_b_cell', module: moduleNumber, row_id: row.row_id, field },
                field,
                change_type: 'updated',
                old_value: row[field] ?? '',
                new_value: patch[field] as string,
                ...(Array.isArray(patch.sources) ? { sources: patch.sources as never } : {}),
              });
              row[field] = patch[field] as string;
            }
          }
          if (Array.isArray(patch.sources)) row.sources = patch.sources as never;
        }
      }
    }

    // --- Part C ---------------------------------------------------------
    if (typeof args.part_c_subtitle === 'string' && !isInsufficientSource(module.part_c)) {
      module.part_c.subtitle = args.part_c_subtitle;
    }
    if (Array.isArray(args.slides)) {
      if (isInsufficientSource(module.part_c)) {
        errors.push(`Module ${moduleNumber} has no Part C section.`);
      } else {
        for (const patch of args.slides as Record<string, unknown>[]) {
          const slide = module.part_c.slides.find((s) => s.slide_id === patch.slide_id);
          if (!slide) {
            errors.push(
              `No slide "${String(patch.slide_id)}" in module ${moduleNumber}. ` +
                `Valid slide_ids: ${module.part_c.slides.map((s) => s.slide_id).join(', ')}.`,
            );
            continue;
          }
          for (const field of ['title', 'visual_cues', 'instructor_script'] as const) {
            if (typeof patch[field] === 'string') {
              changes.push({
                target: { kind: 'slide', module: moduleNumber, slide_id: slide.slide_id, field },
                field,
                change_type: 'updated',
                old_value: slide[field],
                new_value: patch[field] as string,
                ...(Array.isArray(patch.sources) ? { sources: patch.sources as never } : {}),
              });
              slide[field] = patch[field] as string;
            }
          }
          if (Array.isArray(patch.sources)) slide.sources = patch.sources as never;
        }
      }
    }

    if (errors.length > 0) {
      // Nothing is committed on a partial failure, so the client can correct the
      // ids and resubmit against the same base_version.
      return fail('No changes were committed because part of the request could not be applied.', errors);
    }
    if (changes.length === 0) {
      return fail('The request contained no changes to apply.');
    }

    const result = commitVersion({
      artifact_id: artifactId,
      base_version: baseVersion,
      state,
      changes,
      ...(args.note ? { note: String(args.note) } : {}),
    });

    // `state` is the committed content: commitVersion persisted this object.
    const work = outstandingWork(state, await loadTiming(state.course_id));
    return ok({
      artifact_id: artifactId,
      version: result.version,
      changes_applied: changes.length,
      work,
      next_step: continueInstruction(work),
    });
  },
};

const weightageRowSchema = z.object({
  nos_code: z.string().describe('e.g. "SGJ/N4102", or "Total" for the summary row.'),
  nos_title: z.string(),
  theory_marks: z.number(),
  practical_marks: z.number(),
  project_marks: z.number().optional(),
  viva_marks: z.number().optional(),
  total_marks: z.number(),
  weightage: z.number(),
  is_total: z.boolean().optional(),
  sources: z.array(sourceRefSchema).optional(),
});

const questionSchema = z.object({
  module_number: z.number().int().describe('Timing-Allocation module number this question belongs to.'),
  number: z
    .number()
    .int()
    .optional()
    .describe('Position in the bank. Omitted numbers are assigned automatically in module order.'),
  stem: z.string().describe('The question. Must be answerable from the cited chunks.'),
  options: z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string() }),
  correct_option: z.enum(['a', 'b', 'c', 'd']),
  explanation: z.string().describe('What in the source supports the correct answer.'),
  sources: z
    .array(sourceRefSchema)
    .describe('Chunks supporting the stem, correct answer and explanation. Required.'),
  verbatim_from_source: sourceRefSchema
    .optional()
    .describe('Set when the question is reproduced verbatim from a source exercise.'),
});

export const DEFAULT_STRATEGY_POINTS = [
  'Criteria for assessment for each Qualification will be created by the Sector Skill Council. Each Element/ Performance Criteria (PC) will be assigned marks proportional to its importance in NOS. SSC will also lay down proportion of marks for Theory and Skills Practical for each Element/ PC.',
  'The assessment for the theory part will be based on knowledge bank of questions created by the SSC.',
  'Assessment will be conducted for all compulsory NOS, and where applicable, on the selected elective/option NOS/set of NOS.',
  'Individual assessment agencies will create unique question papers for theory part for each candidate at each examination/training center (as per assessment criteria below).',
  'Individual assessment agencies will create unique evaluations for skill practical for every student at each examination/ training center based on these criteria.',
  'To pass the Qualification assessment, every trainee should score the Recommended Pass % aggregate for the QP.',
  'In case of unsuccessful completion, the trainee may seek reassessment on the Qualification.',
];

/**
 * The disclosure the reference document carries, reproduced because the same
 * exception applies: a source document has no answer key, so the wrong options
 * must be authored. Saying so in the artifact is what keeps the exception honest.
 */
export function buildDisclosure(questionCount: number, verbatimNumbers: number[]): string {
  const base =
    `Note on this question bank: Every question stem, correct answer and explanation below is ` +
    `based on content contained in the approved course source documents. The distractor sets and ` +
    `the wording of the explanations have been authored for this blueprint, as the source ` +
    `documents do not contain an answer key.`;
  if (verbatimNumbers.length === 0) return base;
  const list = verbatimNumbers.join(', ');
  return `${base} Question${verbatimNumbers.length === 1 ? '' : 's'} ${list} ${
    verbatimNumbers.length === 1 ? 'is' : 'are'
  } reproduced verbatim from an exercise in the source documents.`;
}

const setAssessmentTool: ToolDefinition = {
  name: 'set_assessment_content',
  title: 'Set assessment content',
  description:
    'Writes the assessment strategy blueprint and the question bank, committing a new version. ' +
    'The template runs ten questions per module, grouped under a per-module heading. Every ' +
    'question must cite the chunk_ids that support its stem, correct answer and explanation; the ' +
    'three incorrect options are authored, since a source document contains no answer key, and ' +
    'the rendered document discloses that. Questions accumulate across calls, so you can submit ' +
    'one module at a time -- pass replace: true to start over. Question numbers are assigned ' +
    'automatically in module order unless you set them.',
  inputSchema: {
    artifact_id: z.string(),
    base_version: z.number().int(),
    questions: z.array(questionSchema).optional(),
    replace: z
      .boolean()
      .optional()
      .describe('Discard existing questions instead of adding to them. Default false.'),
    minimum_aggregate_pass_pct: z
      .number()
      .optional()
      .describe('From the QP, e.g. 70. Defaults to 70 if never set.'),
    strategy_points: z
      .array(z.string())
      .optional()
      .describe('Assessment guideline points from the QP. Defaults to the standard SCGJ seven.'),
    weightage_compulsory: z.array(weightageRowSchema).optional().describe('Compulsory NOS marks table from the QP.'),
    weightage_electives: z
      .record(z.string(), z.array(weightageRowSchema))
      .optional()
      .describe('Elective marks tables, keyed by elective name.'),
    remarks: z.string().optional().describe('The QP\'s remarks line, e.g. total hours breakdown.'),
    note: z.string().optional(),
  },
  handler: (args) => {
    const artifactId = String(args.artifact_id);
    const state = structuredClone(getState(artifactId)) as StoryboardState;

    // Start from whatever exists, so a caller can build the bank module by module.
    const existing = isInsufficientSource(state.assessment) ? undefined : state.assessment;
    const replace = args.replace === true;
    const kept = replace ? [] : (existing?.questions ?? []);

    const incoming = (args.questions ?? []) as z.infer<typeof questionSchema>[];
    const errors: string[] = [];

    const moduleNumbers = new Set(state.modules.map((m) => m.number));
    for (const q of incoming) {
      if (!moduleNumbers.has(q.module_number)) {
        errors.push(
          `Question "${q.stem.slice(0, 60)}..." targets module ${q.module_number}, which is not in ` +
            `this storyboard (modules: ${[...moduleNumbers].join(', ')}).`,
        );
      }
      if (!q.sources || q.sources.length === 0) {
        errors.push(`Question "${q.stem.slice(0, 60)}..." has no sources. Citations are required.`);
      }
    }
    if (errors.length > 0) {
      return fail('No changes were committed because part of the request could not be applied.', errors);
    }

    // Replacing a module's questions wholesale is the common case when redoing a
    // module, so incoming questions supersede kept ones for the same module.
    const touchedModules = new Set(incoming.map((q) => q.module_number));
    const merged = [
      ...kept.filter((q) => !touchedModules.has(q.module_number)),
      ...incoming.map((q) => ({
        question_id: '',
        number: q.number ?? 0,
        module_number: q.module_number,
        stem: q.stem,
        options: q.options,
        correct_option: q.correct_option,
        explanation: q.explanation,
        sources: q.sources as never,
        distractors_authored: true,
        ...(q.verbatim_from_source ? { verbatim_from_source: q.verbatim_from_source as never } : {}),
      })),
    ];

    // Renumber in module order so the bank reads continuously regardless of the
    // order modules were submitted in.
    const moduleOrder = state.modules.map((m) => m.number);
    merged.sort((a, b) => {
      const byModule = moduleOrder.indexOf(a.module_number) - moduleOrder.indexOf(b.module_number);
      return byModule !== 0 ? byModule : a.number - b.number;
    });
    merged.forEach((q, i) => {
      q.number = i + 1;
      q.question_id = `q-${String(i + 1).padStart(3, '0')}`;
    });

    const verbatim = merged.filter((q) => q.verbatim_from_source).map((q) => q.number);

    state.assessment = {
      strategy_points: (
        (args.strategy_points as string[] | undefined) ??
        existing?.strategy_points.map((p) => p.text) ??
        DEFAULT_STRATEGY_POINTS
      ).map((text, i) => ({
        bullet_id: `as-${i + 1}`,
        group: 'Assessment Strategy',
        text,
        sources: [],
      })),
      minimum_aggregate_pass_pct:
        (args.minimum_aggregate_pass_pct as number | undefined) ??
        existing?.minimum_aggregate_pass_pct ??
        70,
      weightage_compulsory:
        (args.weightage_compulsory as never) ?? existing?.weightage_compulsory ?? [],
      weightage_electives:
        (args.weightage_electives as never) ?? existing?.weightage_electives ?? {},
      remarks: (args.remarks as string | undefined) ?? existing?.remarks ?? '',
      disclosure_note: buildDisclosure(merged.length, verbatim),
      questions: merged,
    };

    const result = commitVersion({
      artifact_id: artifactId,
      base_version: Number(args.base_version),
      state,
      changes: [
        {
          target: null,
          field: 'assessment',
          change_type: replace ? 'replaced' : 'updated',
          old_value: String(kept.length),
          new_value: String(merged.length),
          ...(args.note ? { reason: String(args.note) } : {}),
        },
      ],
      ...(args.note ? { note: String(args.note) } : {}),
    });

    const perModule = state.modules.map((m) => ({
      module: m.number,
      questions: merged.filter((q) => q.module_number === m.number).length,
    }));

    return ok({
      artifact_id: artifactId,
      version: result.version,
      total_questions: merged.length,
      per_module: perModule,
      expected_per_module: config.assessment.questionsPerModule,
      next_step: 'Call validate_storyboard, then render_storyboard_docx.',
    });
  },
};

const validateTool: ToolDefinition = {
  name: 'validate_storyboard',
  title: 'Validate storyboard',
  description:
    'Runs all three validation levels and returns structured findings. Level 1 checks ' +
    'traceability mechanically: every content field carries a citation, each citation ' +
    'resolves to a real chunk in the correct course and chapter, and the wording measurably ' +
    'overlaps the cited text. Level 2 checks timing arithmetic against the Timing Allocation ' +
    'Document. Level 3 checks structural conformance to the template. Findings are reported, ' +
    'never auto-fixed -- decide how to address each one and resubmit via set_storyboard_content. ' +
    'Note that low_grounding_overlap is a lexical signal only, not a judgement about meaning.',
  inputSchema: {
    artifact_id: z.string(),
    version: z.number().int().optional(),
    skip_content: z.boolean().optional().describe('Run only timing and structure checks.'),
  },
  handler: async (args) => {
    const state = getState(
      String(args.artifact_id),
      args.version !== undefined ? Number(args.version) : undefined,
    );
    const allocation = await loadTiming(state.course_id);
    return ok(
      validateStoryboard({
        state,
        allocation,
        ...(args.skip_content !== undefined ? { skipContent: Boolean(args.skip_content) } : {}),
      }),
    );
  },
};

const renderTool: ToolDefinition = {
  name: 'render_storyboard_docx',
  title: 'Render storyboard DOCX',
  description:
    'Renders the storyboard to .docx by cloning the template and inserting content. Template ' +
    'formatting is preserved by construction -- styles, theme, numbering, header, footer and ' +
    'section properties are carried over untouched. Returns the output path. Refuses by ' +
    'default if validation has errors; pass allow_invalid to render a draft anyway.',
  inputSchema: {
    artifact_id: z.string(),
    version: z.number().int().optional(),
    allow_invalid: z.boolean().optional(),
  },
  handler: async (args) => {
    const artifactId = String(args.artifact_id);
    const artifact = getArtifact(artifactId);
    const version = args.version !== undefined ? Number(args.version) : artifact.current_version;
    const state = getState(artifactId, version);
    const allocation = await loadTiming(state.course_id);

    const report = validateStoryboard({ state, allocation });
    if (!report.passed && !args.allow_invalid) {
      return fail(
        `Validation found ${report.summary.errors} error(s), so rendering was refused to avoid ` +
          'producing a document with unsupported or missing content. Fix the findings, or pass ' +
          'allow_invalid: true to render a draft deliberately.',
        report,
      );
    }

    const template = await loadTemplate(state.template_version);
    const bytes = await renderStoryboardDocx({ template, state });
    const file = attachDocx(artifactId, version, bytes);

    return ok({
      artifact_id: artifactId,
      version,
      docx_path: file,
      bytes: bytes.length,
      validation_passed: report.passed,
      errors: report.summary.errors,
      warnings: report.summary.warnings,
      insufficient_source_modules: report.insufficient_source_modules,
      note:
        'The table of contents is a Word field; page numbers refresh when the document is ' +
        'opened in Word.',
    });
  },
};

const historyTool: ToolDefinition = {
  name: 'get_storyboard_history',
  title: 'Get storyboard history',
  description:
    'Returns the version list and change log for an artifact, so you can answer "what changed ' +
    'between version 1 and 4" or "what changed in module 3". Narrow with from_version / to_version.',
  inputSchema: {
    artifact_id: z.string(),
    from_version: z.number().int().optional(),
    to_version: z.number().int().optional(),
  },
  handler: (args) => {
    const artifactId = String(args.artifact_id);
    return ok({
      artifact: getArtifact(artifactId),
      versions: listVersions(artifactId),
      changes: listChanges(
        artifactId,
        args.from_version !== undefined ? Number(args.from_version) : undefined,
        args.to_version !== undefined ? Number(args.to_version) : undefined,
      ),
    });
  },
};

const rollbackTool: ToolDefinition = {
  name: 'rollback_storyboard',
  title: 'Rollback storyboard',
  description:
    'Restores a previous version\'s state as a new version. History is append-only: the ' +
    'versions between are preserved and the rollback can itself be rolled back.',
  inputSchema: { artifact_id: z.string(), to_version: z.number().int(), reason: z.string().optional() },
  handler: (args) => {
    const result = rollback(
      String(args.artifact_id),
      Number(args.to_version),
      args.reason ? String(args.reason) : undefined,
    );
    return ok({
      artifact_id: String(args.artifact_id),
      restored_from: Number(args.to_version),
      new_version: result.version,
    });
  },
};

const modifyTimingTool: ToolDefinition = {
  name: 'modify_storyboard_timing',
  title: 'Modify storyboard timing',
  description:
    'Attempts to change a module or unit duration. Permitted only when the requested value ' +
    'matches the Timing Allocation Document, which is authoritative for time. A conflicting ' +
    'request is refused with an explanation rather than applied -- durations may never come ' +
    'from model judgement.',
  inputSchema: {
    artifact_id: z.string(),
    base_version: z.number().int(),
    module_number: z.number().int(),
    requested_minutes: z.number().int(),
    unit_code: z.string().optional().describe('Omit to target the module total.'),
    reason: z.string().optional(),
  },
  handler: async (args) => {
    const artifactId = String(args.artifact_id);
    const moduleNumber = Number(args.module_number);
    const requested = Number(args.requested_minutes);
    const state = structuredClone(getState(artifactId)) as StoryboardState;
    const allocation = await loadTiming(state.course_id);

    const timingModule = allocation.modules.find((m) => m.number === moduleNumber);
    if (!timingModule) return fail(`Module ${moduleNumber} is not in the Timing Allocation Document.`);

    const unitCode = args.unit_code ? String(args.unit_code) : undefined;
    const authoritative = unitCode
      ? timingModule.units.find((u) => u.code === unitCode)?.minutes
      : timingModule.minutes;

    if (authoritative === undefined) {
      return fail(`Unit ${unitCode} is not in module ${moduleNumber} of the Timing Allocation Document.`);
    }

    if (authoritative !== requested) {
      return fail(
        `The requested duration of ${requested} minutes for ` +
          `${unitCode ? `unit ${unitCode}` : `module ${moduleNumber}`} conflicts with the ` +
          `Timing Allocation Document, which states ${authoritative} minutes. The timing ` +
          'document is authoritative for time, so this change was not applied. Amend the ' +
          'timing document and re-ingest if the duration genuinely needs to change.',
        { requested, authoritative, source: unitCode ? undefined : timingModule.source },
      );
    }

    const module = state.modules.find((m) => m.number === moduleNumber);
    if (!module) return fail(`Storyboard has no module ${moduleNumber}.`);

    // The request already matches the authoritative value, so this is a no-op
    // confirmation rather than a change.
    return ok({
      artifact_id: artifactId,
      module_number: moduleNumber,
      ...(unitCode ? { unit_code: unitCode } : {}),
      requested_minutes: requested,
      authoritative_minutes: authoritative,
      applied: false,
      message:
        'The requested duration already matches the Timing Allocation Document, so the ' +
        'storyboard is unchanged and no new version was created.',
    });
  },
};

const readTemplateSpecTool: ToolDefinition = {
  name: 'get_storyboard_field_spec',
  title: 'Get storyboard field spec',
  description:
    'Describes exactly which fields you are expected to write for each section, what each ' +
    'one means in the reference document, and which fields are read-only because they come ' +
    'from the Timing Allocation Document. Read this before your first set_storyboard_content call.',
  inputSchema: {},
  handler: () =>
    ok({
      writable: {
        module_description:
          'One paragraph introducing the module, drawn from the handbook chapter it maps to. Pass its citations as module_description_sources.',
        'part_a_rows[].activity_name':
          'Short name of the interactive learning activity, e.g. "Pellet Die Configurator".',
        'part_a_rows[].interactive_description':
          'What the learner does in that activity. In the reference these read "<Activity>: <what the learner does>".',
        'part_a_rows[].correlation':
          'NOS code plus the performance criteria the unit covers, e.g. "SGJ/N4105 / PC1, PC3".',
        'lms_rows[]':
          'One row per tracked activity: unit_range, activity_type (must match a Part A activity_name), recommended_standard (xAPI | SCORM 2004 | SCORM 1.2), tracking, completion_criteria.',
        'part_b_rows[].visual': 'Camera/animation direction for the 3-minute segment.',
        'part_b_rows[].gfx': 'On-screen text or graphics for the segment. Optional.',
        'part_b_rows[].audio':
          'Speaker-attributed narration, e.g. \'Host (On-Camera): "..."\'. This is the segment\'s educational content and must be cited.',
        'slides[].title': 'Slide title, e.g. \'Interactive Poll - "Choosing the Feedstock" (3 Minutes)\'.',
        'slides[].visual_cues': 'What appears on the slide.',
        'slides[].instructor_script': 'What the instructor says. Must be cited.',
      },
      read_only: {
        'module.duration': 'From the Timing Allocation Document.',
        'part_a_rows[].duration': 'From the Timing Allocation Document.',
        'part_a_rows[].unit_code': 'From the Timing Allocation Document.',
        'part_a_rows[].unit_label': 'From the Timing Allocation Document.',
        'part_b_rows[].time_range': 'Fixed by the template: five 3-minute segments spanning 0:00-15:00.',
        'slides[].number': 'Fixed by the template: seven slides per module.',
      },
      assessment: {
        tool: 'set_assessment_content',
        'questions[]':
          'Ten per module. stem, options a-d, correct_option, explanation, and sources citing the chunk_ids that support the stem, correct answer and explanation.',
        distractors:
          'The three incorrect options are authored, not sourced, because a source document has no answer key. The rendered document discloses this. Distractors must be plausible but must not assert any fact absent from the sources.',
        'weightage_compulsory[] / weightage_electives':
          'The marks tables from the QP assessment weightage section.',
        strategy_points: 'The QP assessment guideline points. Defaults to the standard SCGJ seven if omitted.',
      },
      citation_rules: {
        required_on: [
          'module_description (via module_description_sources)',
          'part_a_rows[].interactive_description',
          'lms_rows[].completion_criteria',
          'part_b_rows[].audio',
          'slides[].instructor_script',
        ],
        how:
          'Pass the sources array with chunk_id values returned by search_course_content. ' +
          'validate_storyboard confirms each resolves and belongs to the module\'s mapped chapter.',
      },
    }),
};

/** The storyboard tool set, in the order the client sees it. */
export const STORYBOARD_TOOLS: ToolDefinition[] = [
  listCoursesTool,
  getCourseManifestTool,
  ingestTool,
  searchTool,
  getChunkTool,
  getPageTool,
  crosswalkTool,
  timingTool,
  validateTimingTool,
  analyzeTemplateTool,
  readTemplateSpecTool,
  createDraftTool,
  getStoryboardTool,
  listStoryboardsTool,
  setContentTool,
  setAssessmentTool,
  validateTool,
  renderTool,
  historyTool,
  rollbackTool,
  modifyTimingTool,
];

export { loadTiming, loadTemplate };
