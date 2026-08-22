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

/**
 * The three programme tracks.
 *
 * A track is the unit at which everything above the course varies: the storyboard
 * template, the menu branch, and the folder the documents arrive in. Defined here
 * rather than in the subject catalogue because course-config is the leaf every
 * other module already depends on, and the alternative is an import cycle.
 */
export const COURSE_TRACKS = ['entrepreneur', 'orientation', 'cdr'] as const;
export type CourseTrack = (typeof COURSE_TRACKS)[number];

export const TRACK_LABELS: Record<CourseTrack, string> = {
  entrepreneur: 'Entrepreneur',
  orientation: 'Orientation',
  cdr: 'CDR',
};

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
   * Which programme track this course belongs to.
   *
   * The track decides two things that are otherwise unknowable from a course_id:
   * which storyboard template the course renders to (`templates/<track>/`), and
   * which menu branch offers it. Every course declares one.
   */
  track: CourseTrack;
  /**
   * Where this course's documents live, relative to the courses root.
   *
   * Documents are filed by track -- `entrepreneur/solar`, `orientation/biogas` --
   * because that is how they arrive and how they are reviewed. Stating the path
   * here rather than deriving it from `track` + `course_id` keeps the one case
   * where the folder is named for the subject (`solar`) rather than the course
   * (`solar-pv`) as data instead of a special case in the resolver.
   */
  directory: string;
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
  track: 'entrepreneur',
  directory: 'entrepreneur/biofuels',
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
  track: CourseTrack,
  occupation: string,
  directoryName = courseId,
): CourseConfig {
  return {
    course_id: courseId,
    name,
    track,
    directory: `${track}/${directoryName}`,
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
  track: 'entrepreneur',
  // The documents arrive in a folder named for the subject, not the course_id.
  directory: 'entrepreneur/solar',
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

/**
 * Green Hydrogen Plant Entrepreneur.
 *
 * The crosswalk is 1:1. Its Timing Allocation Document was authored from this
 * handbook's own module and unit structure (see scripts/timing/README.md), so
 * timing module N is handbook chapter N by construction and the two cannot
 * disagree the way the Biofuels pair does.
 *
 * NOS codes are read off each module's cover page in the handbook, where exactly
 * one is printed per module. The Qualification Pack also lists SGJ/N4101 and
 * DGT/VSQ/N0103; the latter appears on no module cover and is not assigned here.
 *
 * `chapter_titles` is not optional for this course. Its contents page wraps the
 * titles of chapters 3, 4 and 6 across two lines, so the chapter number and its
 * title never share a line and the ingest-time derivation finds only chapters 1,
 * 2 and 5. The titles below are taken verbatim from the module cover pages.
 */
const GREEN_HYDROGEN: CourseConfig = {
  course_id: 'green-hydrogen',
  name: 'Green Hydrogen Plant Entrepreneur',
  track: 'entrepreneur',
  directory: 'entrepreneur/green-hydrogen',
  qp_code: 'SGJ/Q0121',
  nsqf_level: '5',
  sector: 'Green Jobs',
  sub_sector: 'Renewable Energy',
  occupation: 'Entrepreneur',
  reference_id: 'SGJ/Q0121, Version 1.0',
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
      timing_title: 'Introduction to Green Hydrogen',
      source_chapter: 1,
      nos_code: 'SGJ/N1817',
    },
    {
      timing_module: 2,
      timing_title: 'Components of Green Hydrogen Plant and its Layout',
      source_chapter: 2,
      nos_code: 'SGJ/N4101',
    },
    {
      timing_module: 3,
      timing_title:
        'Key Technical and Entrepreneurial Aspects for Supporting Growth and Business ' +
        'Development in Green Hydrogen Production',
      source_chapter: 3,
      nos_code: 'SGJ/N1818',
    },
    {
      timing_module: 4,
      timing_title:
        'Oversee the Assembly, Storage and O&M of Electrolyzer for Green Hydrogen Production',
      source_chapter: 4,
      nos_code: 'SGJ/N1820',
    },
    {
      timing_module: 5,
      timing_title: 'Micro-Entrepreneurship Opportunities in Green Hydrogen',
      source_chapter: 5,
      nos_code: 'SGJ/N1819',
    },
    {
      timing_module: 6,
      timing_title:
        'Perform Health and Safety Measures for Installing and Operating Green Hydrogen Systems',
      source_chapter: 6,
      nos_code: 'SGJ/N0802',
    },
  ],
  chapter_titles: {
    1: 'Introduction to Green Hydrogen',
    2: 'Components of Green Hydrogen Plant and its Layout',
    3:
      'Key technical and entrepreneurial aspects for supporting growth and business ' +
      'development green hydrogen production',
    4: 'Oversee the Assembly, storage and O&M of Electrolyzer for Green Hydrogen Production',
    5: 'Micro-entrepreneurship opportunities in Green Hydrogen',
    6: 'Perform Health and safety measures for installing and operating green hydrogen systems',
  },
  chunk_noise_patterns: [
    '^Participant Handbook$',
    '^Facilitator Guide$',
    '^Qualification Pack$',
    '^Green Hydrogen Plant$',
    '^Entrepreneur$',
    '^NSQC Approved \\|\\| Skill Council for Green Jobs \\d+$',
  ],
};

/**
 * Agri-Residue Aggregator.
 *
 * 1:1 crosswalk, for the same reason as Green Hydrogen: the timing document was
 * built from this handbook's structure.
 *
 * Modules 1, 2 and 3 all print SGJ/N6201 on their cover pages, so all three carry
 * it. The Qualification Pack also lists SGJ/N6202, which appears on no cover page;
 * assigning it to a module would be a guess, so it is left unassigned.
 *
 * Module 7 is Employability Skills, and this handbook covers it exactly as the
 * Biofuels one covers its own: with a link to the common DGT workbook and nothing
 * else. It is flagged so the task queue skips it rather than offering work the
 * sources cannot support.
 */
const AGRI_RESIDUE_AGGREGATOR: CourseConfig = {
  course_id: 'agri-residue-aggregator',
  name: 'Agri-Residue Aggregator',
  track: 'entrepreneur',
  directory: 'entrepreneur/agri-residue-aggregator',
  qp_code: 'SGJ/Q6201',
  nsqf_level: '3',
  sector: 'Green Jobs',
  sub_sector: 'Renewable Energy',
  occupation: 'Entrepreneur',
  reference_id: 'SGJ/Q6201, Version 1.0',
  subtitle: 'Complete Curriculum Storyboard and Assessment Blueprint',
  documents: [
    { document_type: 'QP', file: 'qp.pdf' },
    { document_type: 'PH', file: 'ph.pdf' },
    { document_type: 'FG', file: 'fg.pdf' },
    { document_type: 'TIMING', file: 'timing.pdf' },
  ],
  crosswalk: [
    { timing_module: 1, timing_title: 'Introduction', source_chapter: 1, nos_code: 'SGJ/N6201' },
    {
      timing_module: 2,
      timing_title: 'Assessing Demand and Supply of Agricultural Residue',
      source_chapter: 2,
      nos_code: 'SGJ/N6201',
    },
    {
      timing_module: 3,
      timing_title: 'Purchase of Agricultural Residue Stock from Nodal Point',
      source_chapter: 3,
      nos_code: 'SGJ/N6201',
    },
    {
      timing_module: 4,
      timing_title: 'Packing and Storing Compacted Agricultural Residues',
      source_chapter: 4,
      nos_code: 'SGJ/N6203',
    },
    {
      timing_module: 5,
      timing_title: 'Sales and Transportation of Agricultural Residues',
      source_chapter: 5,
      nos_code: 'SGJ/N6204',
    },
    {
      timing_module: 6,
      timing_title: 'Maintaining Basic Health and Workplace Safety',
      source_chapter: 6,
      nos_code: 'SGJ/N6205',
    },
    {
      timing_module: 7,
      timing_title: 'Employability Skills',
      source_chapter: 7,
      nos_code: 'DGT/VSQ/N0101',
      no_source_content: {
        reason:
          'The Participant Handbook does not contain Employability Skills content. Chapter 7 ' +
          'is a single page that links to the common DGT workbook, and the contents page ' +
          'carries the same note in place of unit entries.',
        source_statement:
          'It is recommended that all trainings include the appropriate Employability skills ' +
          'Module. Content for the same can be accessed: Employability skills workbook',
        required_document: 'DGT/VSQ/N0101 Employability Skills workbook',
      },
    },
  ],
  chapter_titles: {
    1: 'Introduction',
    2: 'Assessing Demand and Supply of Agricultural Residue',
    3: 'Purchase of Agricultural Residue Stock from Nodal Point',
    4: 'Packing and Storing Compacted Agricultural Residues',
    5: 'Sales and transportation of agricultural residues',
    6: 'Maintaining basic health and workplace safety',
    7: 'Employability Skills',
  },
  chunk_noise_patterns: [
    '^Participant Handbook$',
    '^Facilitator Guide$',
    '^Qualification Pack$',
    '^Agricultural Residue Aggregator$',
    '^NSQC Approved \\|\\| Skill Council for Green Jobs \\d+$',
  ],
};

const PENDING: CourseConfig[] = [
  pendingCourse('esg', 'Environmental, Social and Governance', 'orientation', 'Orientation', 'esg-fundamentals'),
  pendingCourse(
    'ghg',
    'Greenhouse Gas',
    'orientation',
    'Orientation',
    'ghg-accounting-and-sustainability',
  ),
  pendingCourse('green-logistics', 'Green Logistics', 'orientation', 'Orientation'),
  pendingCourse('biogas', 'Biogas', 'orientation', 'Orientation'),
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
    track: 'cdr',
    directory: definition.course_id,
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
  // The four Entrepreneur subjects, all with reviewed crosswalks.
  [SOLAR_PV.course_id]: SOLAR_PV,
  [BIOFUELS.course_id]: BIOFUELS,
  [GREEN_HYDROGEN.course_id]: GREEN_HYDROGEN,
  [AGRI_RESIDUE_AGGREGATOR.course_id]: AGRI_RESIDUE_AGGREGATOR,
  ...Object.fromEntries(CDR_COURSES.map((c) => [c.course_id, cdrCourse(c)])),
  // The four Orientation subjects are registered as placeholders. Each becomes
  // fully usable by supplying a reviewed crosswalk and chapter title table; their
  // documents are already on disk.
  ...Object.fromEntries(PENDING.map((c) => [c.course_id, c])),
};

/** Every course of one track, in registration order. */
export function listCoursesInTrack(track: CourseTrack): CourseConfig[] {
  return listCourses().filter((c) => c.track === track);
}

/** True when the course has the reviewed data a storyboard needs. */
export function hasReviewedCrosswalk(courseId: string): boolean {
  const course = REGISTRY[courseId];
  if (!course) return false;
  return course.kind === 'cdr' ? course.module_sources !== undefined : course.crosswalk.length > 0;
}

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
  const course = REGISTRY[courseId];
  const root = coursesRoot();
  const canonical = path.join(root, course?.directory ?? courseId);
  if (existsSync(canonical)) return canonical;
  // Legacy flat layouts, and folders named for the subject rather than the
  // course. Tried only when the declared directory is absent, so the declared
  // one always wins and the "supply the documents here" message names it.
  for (const alias of [courseId, ...(course?.directory_aliases ?? [])]) {
    const candidate = path.join(root, alias);
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
