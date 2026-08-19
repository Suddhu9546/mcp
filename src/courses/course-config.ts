/**
 * Course registry and cross-document module crosswalk.
 *
 * COURSE ISOLATION (INVARIANT 4): every retrieval is scoped by `course_id`.
 * Nothing in this file grants access across courses.
 *
 * The crosswalk exists because the source documents do not agree on module
 * numbering. For Biofuels, the client-authored Timing Allocation Document
 * renumbers the SCGJ chapters so that the two electives sit at positions 5 and
 * 6:
 *
 *   timing M1 Entrepreneurship & Biomass Basics  -> PH/FG ch.1  SGJ/N4102
 *   timing M2 Financial Budget & Business Plans  -> PH/FG ch.2  SGJ/N4103
 *   timing M3 Sales, Supply & Marketing          -> PH/FG ch.3  SGJ/N4103 (element)
 *   timing M4 Compliance                         -> PH/FG ch.4  SGJ/N4104
 *   timing M5 Pellet Manufacturing (Elective 1)  -> PH/FG ch.7  SGJ/N4105
 *   timing M6 Small Biogas Plant  (Elective 2)   -> PH/FG ch.8  SGJ/N4106
 *   timing M7 HSE                                -> PH/FG ch.5  SGJ/N4050
 *   timing M8 Employability Skills               -> (no source content)
 *
 * Retrieving Module 5 content from PH chapter 5 instead of chapter 7 would
 * silently produce a storyboard about workplace safety under a pellet
 * manufacturing heading, with citations that look valid. Hence this mapping is
 * explicit, reviewable data rather than inferred at runtime.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { coursesRoot } from '../util/config.js';
import { CDR_COURSES, type CdrCourseDefinition } from './cdr-generated.js';
import type { DocumentType } from '../types/source.js';

export interface ModuleCrosswalkEntry {
  /** Module number in the Timing Allocation Document. Drives the output. */
  timing_module: number;
  /** Module title in the Timing Allocation Document. */
  timing_title: string;
  /** Chapter number in the Participant Handbook and Faculty Guide. */
  source_chapter: number;
  /** NOS the module assesses against. */
  nos_code: string;
  /** Elective number, when the module is an elective. */
  elective?: number;
  /**
   * Set when the approved documents contain no teachable content for this
   * module. Generation must return INSUFFICIENT_SOURCE_CONTENT rather than
   * inventing material.
   */
  no_source_content?: {
    reason: string;
    /** What the source documents say instead, reproduced verbatim. */
    source_statement: string;
    /** Document that would close the gap if supplied as an approved source. */
    required_document: string;
  };
}

export interface CourseDocumentConfig {
  document_type: DocumentType;
  /** Path relative to the course directory. */
  file: string;
  /**
   * Identifies this document within its course.
   *
   * A qualification course has one document per type, so the type is the key and
   * this is omitted. A CDR course has nine REF documents; each declares its own
   * key so a module can be scoped to the documents its master file names.
   */
  doc_key?: string;
  /** Human-readable title, as the master file names it. REF documents only. */
  title?: string;
  /**
   * Offset to add to a printed page number to get the PDF page index, i.e.
   * pdf_page = printed_page + printed_page_offset. Detected during ingestion and
   * recorded here so citations can carry both numbers.
   */
  printed_page_offset?: number;
}

export interface CourseConfig {
  course_id: string;
  name: string;
  /**
   * Which shape of course this is.
   *
   * "qualification" is the SCGJ pattern: one QP, one Participant Handbook, one
   * Facilitator Guide, one Timing Allocation Document, modules mapped to handbook
   * chapters by a crosswalk. "cdr" is the Carbon Dioxide Removal pattern: many
   * unrelated reference documents and a master file that says which of them each
   * module is built from and how long it runs. Defaults to qualification.
   */
  kind?: 'qualification' | 'cdr';
  /**
   * Set while the course is registered but its approved documents have not been
   * supplied yet. Such a course exists so that dropping its PDFs into
   * courses/<course_id>/ and ingesting is the whole onboarding procedure; until
   * then every tool reports it as missing documents rather than pretending it is
   * usable. The metadata below is a placeholder in that state and must be filled
   * in from the real Qualification Pack when the documents arrive.
   */
  documents_pending?: boolean;
  qp_code: string;
  nsqf_level: string;
  sector: string;
  sub_sector: string;
  occupation: string;
  reference_id: string;
  /** Cover subtitle used in the generated storyboard. */
  subtitle: string;
  documents: CourseDocumentConfig[];
  crosswalk: ModuleCrosswalkEntry[];
  /**
   * Per-module document routing, for a course whose modules each come from a
   * different reference document rather than from chapters of one handbook.
   *
   * Present only on CDR courses, where it is derived from the master file. Its
   * presence is what switches retrieval and citation checking from chapter
   * scoping to document scoping -- see courses/module-scope.ts.
   */
  module_sources?: Record<number, { doc_keys: string[]; nos_code?: string }>;
  /**
   * Chapter number to chapter title, as printed in the Participant Handbook and
   * Faculty Guide contents.
   *
   * Chunking uses this to decide whether a line like "7. Annexures" is really a
   * chapter opener. Without the check, any numbered line matches: a figure
   * caption ("7. Packaging Machine", on a chapter-2 page) and the annexure
   * heading both got filed as chapter 7, so a pellet-scoped search returned
   * chapter-2 content carrying a chapter-7 citation.
   */
  chapter_titles: Record<number, string>;
  /**
   * Known text artefacts in the source PDFs that must be stripped from chunks so
   * they are never retrieved as content or cited.
   */
  chunk_noise_patterns: string[];
  /**
   * Other names the course's directory under courses/ may have on disk.
   *
   * Documents arrive in folders named however whoever supplied them chose, and a
   * folder that does not match the course_id is otherwise invisible -- the course
   * reports "no documents supplied" while the PDFs sit next to it. Listing the
   * name here is the one-line fix, and is preferred to renaming the folder because
   * the folder is the thing that keeps arriving.
   */
  directory_aliases?: string[];
}

const BIOFUELS: CourseConfig = {
  course_id: 'biofuels',
  name: 'Bio-Energy Micro Entrepreneur',
  qp_code: 'SGJ/Q4102',
  nsqf_level: '4',
  sector: 'Green Jobs',
  sub_sector: 'Renewable Energy',
  occupation: 'Entrepreneur',
  reference_id: 'SGJ/Q4102, Version 1.0',
  subtitle: 'Complete Curriculum Storyboard and Assessment Blueprint',
  documents: [
    { document_type: 'QP', file: 'qp.pdf' },
    // The PH's printed page numbers run 10 behind the PDF page index: printed
    // page 292 is PDF page 302. Verified at both ends of the document.
    { document_type: 'PH', file: 'ph.pdf', printed_page_offset: 10 },
    { document_type: 'FG', file: 'fg.pdf', printed_page_offset: 10 },
    { document_type: 'TIMING', file: 'timing.pdf' },
  ],
  crosswalk: [
    {
      timing_module: 1,
      timing_title: 'Entrepreneurship and Basics of Biomass Energy',
      source_chapter: 1,
      nos_code: 'SGJ/N4102',
    },
    {
      timing_module: 2,
      timing_title: 'Manage Financial Budget & Develop Business Plans',
      source_chapter: 2,
      nos_code: 'SGJ/N4103',
    },
    {
      timing_module: 3,
      timing_title: 'Manage Sales, Supply, and Marketing of Product',
      source_chapter: 3,
      // "Manage sales, supply, and marketing of product" is an element of
      // N4103 in the QP, not a NOS of its own.
      nos_code: 'SGJ/N4103',
    },
    {
      timing_module: 4,
      timing_title: 'Compliance with Applicable Laws, Policies & Procedures',
      source_chapter: 4,
      nos_code: 'SGJ/N4104',
    },
    {
      timing_module: 5,
      timing_title: 'Manufacturing of Biomass Pellets (Elective 1)',
      source_chapter: 7,
      nos_code: 'SGJ/N4105',
      elective: 1,
    },
    {
      timing_module: 6,
      timing_title: 'Installation & Operation of Small Biogas Plant (Elective 2)',
      source_chapter: 8,
      nos_code: 'SGJ/N4106',
      elective: 2,
    },
    {
      timing_module: 7,
      timing_title: 'HSE (Health, Safety & Environment)',
      source_chapter: 5,
      nos_code: 'SGJ/N4050',
    },
    {
      timing_module: 8,
      timing_title: 'Employability Skills',
      source_chapter: 6,
      nos_code: 'DGT/VSQ/N0102',
      no_source_content: {
        reason:
          'Neither the Participant Handbook nor the Faculty Guide contains ' +
          'Employability Skills content. Both defer to an external DGT ' +
          'workbook. A keyword sweep of the 311-page handbook for the ' +
          'DGT/VSQ/N0102 topics named in the Timing Allocation Document ' +
          '(constitutional values, 21st-century skills, POSH, resume, ' +
          'interview readiness, digital literacy, financial literacy, ' +
          'apprenticeship) returned no matches.',
        source_statement:
          'It is recommended that all trainings include the appropriate ' +
          'Employability skills Module. Content for the same can be accessed: ' +
          'Employability skills workbook',
        required_document: 'DGT/VSQ/N0102 Employability Skills workbook (60 Hours)',
      },
    },
  ],
  // Titles as printed in the PH and FG contents. Both documents use the same
  // chapter numbering, which is the SCGJ numbering rather than the timing
  // document's -- see the crosswalk above.
  chapter_titles: {
    1: 'Entrepreneurship and Basics of Biomass Energy',
    2: 'Manage financial budget and developing business plans',
    3: 'Manage sales, supply, and marketing of product',
    4: 'Assess Compliance with Applicable Laws, Policies, and Procedures',
    5: 'Health & Safety in Bioenergy Manufacturing facility',
    6: 'Employability Skills',
    7: 'Ensure Manufacturing of Biomass pellet',
    8: 'Ensure installation and operation of small biogas plant',
  },
  chunk_noise_patterns: [
    // The Biofuels handbook carries a stray running header from another
    // qualification on printed pages 283-291. It must never be retrieved as
    // Biofuels content or cited as a section.
    '^Plastic Recycling Operator$',
    '^Participant Handbook$',
    '^Facilitator Guide$',
    '^Qualification Pack$',
    '^NSQC Approved \\|\\| Skill Council for Green Jobs \\d+$',
  ],
};

/**
 * Placeholder registration for a subject whose approved documents have not been
 * supplied yet.
 *
 * The four document filenames are declared up front so that ingestion picks up
 * whichever of them appears on disk and reports the rest as missing. `crosswalk`
 * and `chapter_titles` are left empty on purpose: both are reviewed data that must
 * be read off the real documents, and inventing them would produce citations that
 * look valid while pointing at the wrong chapter. Their absence costs the video
 * flows nothing -- unit headings in the handbook carry their own chapter number,
 * so the handbook outline is derived without either table -- but a storyboard
 * cannot be built until they are filled in.
 */
function pendingCourse(
  courseId: string,
  name: string,
  occupation: string,
  directoryAliases: string[] = [],
): CourseConfig {
  return {
    course_id: courseId,
    name,
    ...(directoryAliases.length > 0 ? { directory_aliases: directoryAliases } : {}),
    documents_pending: true,
    qp_code: '(pending)',
    nsqf_level: '(pending)',
    sector: 'Green Jobs',
    sub_sector: '(pending)',
    occupation,
    reference_id: '(pending)',
    subtitle: 'Complete Curriculum Storyboard and Assessment Blueprint',
    documents: [
      { document_type: 'QP', file: 'qp.pdf' },
      { document_type: 'PH', file: 'ph.pdf' },
      { document_type: 'FG', file: 'fg.pdf' },
      { document_type: 'TIMING', file: 'timing.pdf' },
    ],
    crosswalk: [],
    chapter_titles: {},
    chunk_noise_patterns: [
      '^Participant Handbook$',
      '^Facilitator Guide$',
      '^Qualification Pack$',
      '^NSQC Approved \\|\\| Skill Council for Green Jobs \\d+$',
    ],
  };
}

/**
 * Solar Photovoltaic Entrepreneur.
 *
 * Metadata is read off the Qualification Pack's cover page. The crosswalk is 1:1
 * -- Timing Allocation module N is Participant Handbook chapter N -- because the
 * timing document was built from the handbook's own reviewed topic structure
 * rather than issued separately, so the two cannot disagree the way the Biofuels
 * pair does.
 *
 * Module 7 prints no NOS code on its cover page. The QP lists SGJ/N4126 for the
 * ground-mount installation role, but the handbook does not say so, and a citation
 * check that trusted a guess here would pass while pointing at the wrong standard.
 * It is recorded as unknown.
 */
const SOLAR_PV: CourseConfig = {
  course_id: 'solar-pv',
  name: 'Solar Photovoltaic Entrepreneur',
  directory_aliases: ['solar'],
  qp_code: 'SGJ/Q0901',
  nsqf_level: '4',
  sector: 'Green Jobs',
  sub_sector: 'Renewable Energy',
  occupation: 'Entrepreneur',
  reference_id: 'SGJ/Q0901, Version 3.0',
  subtitle: 'Complete Curriculum Storyboard and Assessment Blueprint',
  documents: [
    { document_type: 'QP', file: 'qp.pdf' },
    { document_type: 'PH', file: 'ph.pdf' },
    { document_type: 'FG', file: 'fg.pdf' },
    { document_type: 'TIMING', file: 'timing.pdf' },
  ],
  crosswalk: [
    {
      timing_module: 1,
      timing_title: 'Introduction to Solar PV Sector in India',
      source_chapter: 1,
      nos_code: 'SGJ/N0111',
    },
    {
      timing_module: 2,
      timing_title: 'Set up new venture for Solar Photovoltaic System',
      source_chapter: 2,
      nos_code: 'SGJ/N0111',
    },
    {
      timing_module: 3,
      timing_title: 'Business Model in Solar Photovoltaic',
      source_chapter: 3,
      nos_code: 'SGJ/N4125',
    },
    {
      timing_module: 4,
      timing_title: 'Site Feasibility Study for Rooftop Solar power plant',
      source_chapter: 4,
      // The cover page prints SGJ/N0111 and SGJ/N4125 run together.
      nos_code: 'SGJ/N4125',
    },
    {
      timing_module: 5,
      timing_title: 'Site Feasibility Study for Ground Mount Solar power plant',
      source_chapter: 5,
      nos_code: 'SGJ/N4125',
    },
    {
      timing_module: 6,
      timing_title: 'Installation of Solar Rooftop PV Plant',
      source_chapter: 6,
      nos_code: 'SGJ/N4125',
    },
    {
      timing_module: 7,
      timing_title: 'Installation of Solar Ground Mounted PV Plant',
      source_chapter: 7,
      nos_code: 'UNKNOWN',
    },
    {
      timing_module: 8,
      timing_title: 'Operation and maintenance of Solar Rooftop PV Plant',
      source_chapter: 8,
      nos_code: 'SGJ/N4126',
    },
    {
      timing_module: 9,
      timing_title: 'Operation and maintenance of Solar Ground Mounted PV Plant',
      source_chapter: 9,
      nos_code: 'SGJ/N4126',
    },
    {
      timing_module: 10,
      timing_title: 'Maintain Personal Health & Safety at Project Site',
      source_chapter: 10,
      nos_code: 'SGJ/N0106',
    },
  ],
  chapter_titles: {
    1: 'Introduction to Solar PV Sector in India',
    2: 'Set up new venture for Solar Photovoltaic System',
    3: 'Business Model in Solar Photovoltaic',
    4: 'Site Feasibility Study for Rooftop Solar power plant',
    5: 'Site Feasibility Study for Ground Mount Solar power plant',
    6: 'Installation of Solar Rooftop PV Plant',
    7: 'Installation of Solar Ground Mounted PV Plant',
    8: 'Operation and maintenance of Solar Rooftop PV Plant',
    9: 'Operation and maintenance of Solar Ground Mounted PV Plant',
    10: 'Maintain Personal Health & Safety at Project Site',
  },
  chunk_noise_patterns: [
    '^Participant Handbook$',
    '^Facilitator Guide$',
    '^Qualification Pack$',
    '^Solar PV Entrepreneur$',
    '^NSQC Approved \\|\\| Skill Council for Green Jobs \\d+$',
  ],
};

const PENDING: CourseConfig[] = [
  pendingCourse('esg', 'Environmental, Social and Governance', 'Orientation'),
  pendingCourse('ghg', 'Greenhouse Gas', 'Orientation'),
  pendingCourse('green-logistics', 'Green Logistics', 'Orientation'),
  pendingCourse('biogas', 'Biogas', 'Orientation'),
  pendingCourse('agri-residue-aggregator', 'Agri-Residue Aggregator', 'Entrepreneur'),
  pendingCourse('green-hydrogen', 'Green Hydrogen', 'Entrepreneur'),
];

/**
 * A CDR course, expanded from its generated definition.
 *
 * These courses have no Qualification Pack, Participant Handbook or Facilitator
 * Guide, so they carry none of the qualification metadata: their nine reference
 * documents are REF, and their master file is MASTER. `module_sources` is what
 * routes each module to its own documents, and its presence is what switches
 * scoping from chapters to documents everywhere downstream.
 */
function cdrCourse(definition: CdrCourseDefinition): CourseConfig {
  return {
    course_id: definition.course_id,
    name: definition.name,
    kind: 'cdr',
    qp_code: '(none)',
    nsqf_level: '(none)',
    sector: 'Green Jobs',
    sub_sector: 'Carbon Dioxide Removal',
    occupation: 'Carbon Dioxide Removal',
    reference_id: definition.name,
    subtitle: 'Complete Curriculum Storyboard and Assessment Blueprint',
    documents: [
      { document_type: 'MASTER', doc_key: 'MASTER', file: definition.master_file },
      ...definition.documents.map((d) => ({
        document_type: 'REF' as const,
        doc_key: d.doc_key,
        file: d.file,
        title: d.title,
      })),
    ],
    // Routing replaces the crosswalk, so there is none: a CDR module's sources
    // are documents, not a chapter of a handbook it does not have.
    crosswalk: [],
    chapter_titles: definition.module_titles,
    module_sources: Object.fromEntries(
      Object.entries(definition.module_sources).map(([number, keys]) => [Number(number), { doc_keys: keys }]),
    ),
    chunk_noise_patterns: [],
  };
}

const REGISTRY: Record<string, CourseConfig> = {
  [BIOFUELS.course_id]: BIOFUELS,
  [SOLAR_PV.course_id]: SOLAR_PV,
  ...Object.fromEntries(CDR_COURSES.map((c) => [c.course_id, cdrCourse(c)])),
  // The remaining six subjects of the Orientation and Entrepreneur tracks are
  // registered as placeholders. Each becomes fully usable by supplying its PDFs
  // and, for storyboards, a reviewed crosswalk and chapter title table.
  ...Object.fromEntries(PENDING.map((c) => [c.course_id, c])),
};

export function listCourseIds(): string[] {
  return Object.keys(REGISTRY);
}

export function listCourses(): CourseConfig[] {
  return Object.values(REGISTRY);
}

/**
 * The directory holding a course's documents.
 *
 * Normally courses/<course_id>. When that directory does not exist but one of the
 * course's declared aliases does, the alias wins -- so documents delivered in a
 * folder named for the subject rather than for the course_id are still found. The
 * course_id path is returned when nothing exists, so the "supply the documents
 * here" message names the canonical location rather than an alias.
 */
export function courseDir(courseId: string): string {
  const canonical = path.join(coursesRoot(), courseId);
  if (existsSync(canonical)) return canonical;
  for (const alias of REGISTRY[courseId]?.directory_aliases ?? []) {
    const candidate = path.join(coursesRoot(), alias);
    if (existsSync(candidate)) return candidate;
  }
  return canonical;
}

/** Throws for an unknown course. Never falls back to another course's config. */
export function getCourseConfig(courseId: string): CourseConfig {
  const config = REGISTRY[courseId];
  if (!config) {
    throw new Error(
      `Unknown course_id "${courseId}". Registered courses: ${listCourseIds().join(', ') || '(none)'}`,
    );
  }
  return config;
}

export function getCrosswalkEntry(courseId: string, timingModule: number): ModuleCrosswalkEntry {
  const entry = getCourseConfig(courseId).crosswalk.find((c) => c.timing_module === timingModule);
  if (!entry) {
    throw new Error(`Course "${courseId}" has no crosswalk entry for module ${timingModule}.`);
  }
  return entry;
}
