/**
 * Builds the storyboard skeleton: every structural decision the tool layer can
 * make on its own, and nothing else.
 *
 * The skeleton fixes module count, module and unit durations, unit codes and
 * titles, row and slide counts, correlation NOS codes, and the source chapter each
 * module must draw from. Content fields are left empty for the client to fill via
 * `set_storyboard_content`.
 *
 * This is the division of labour: the tool layer decides *structure*, because
 * structure is derivable from the approved documents and the template. The client
 * decides *wording*, because that requires reading and understanding the sources.
 */

import type { SourceRef } from '../types/source.js';
import type { AllocatedDuration, TimingAllocation, TimingModule, TimingStrategy } from '../types/timing.js';
import type {
  FrontMatter,
  PartA,
  PartARow,
  PartB,
  PartBRow,
  PartC,
  Slide,
  StoryboardModule,
  StoryboardState,
} from '../types/storyboard.js';
import { getCourseConfig, getCrosswalkEntry, type CourseConfig } from '../courses/course-config.js';
import { isDocumentRouted, moduleScope } from '../courses/module-scope.js';

/**
 * Part B is always a 15-minute video in five 3-minute segments, and Part C always
 * seven slides. Both were read off the template -- all ten reference modules use
 * exactly this shape -- so they are template constants rather than choices.
 */
export const PART_B_SEGMENTS = 5;
export const PART_B_SEGMENT_SECONDS = 180;
export const PART_C_SLIDES = 7;
export const PART_B_MINUTES = 15;
export const PART_C_MINUTES = 15;

export class SkeletonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkeletonError';
  }
}

function minutesLabel(minutes: number): string {
  return `${minutes} mins`;
}

function hoursLabel(minutes: number): string {
  const hours = minutes / 60;
  const rendered = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${rendered} Hour${hours === 1 ? '' : 's'}`;
}

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Part A durations under the configured strategy.
 *
 * `part_a_verbatim` (the Biofuels default) copies the timing document's unit
 * minutes unchanged, so every duration in the output is traceable to a stated
 * value. The other strategies exist because the Solar reference document treats
 * Parts B and C as consuming 30 minutes of the module's curriculum time; they
 * derive values by a fixed rule rather than by judgement, and record that rule in
 * each duration's provenance.
 */
function allocatePartA(module: TimingModule, strategy: TimingStrategy): AllocatedDuration[] {
  const verbatim = (): AllocatedDuration[] =>
    module.units.map((u) => ({
      minutes: u.minutes,
      label: minutesLabel(u.minutes),
      provenance: { kind: 'timing_document', ref: u.source, raw: u.raw_duration },
    }));

  if (strategy === 'part_a_verbatim') return verbatim();

  if (strategy === 'part_a_carve_last_unit') {
    const out = verbatim();
    const lastIndex = out.length - 1;
    const last = out[lastIndex];
    const lastUnit = module.units[lastIndex];
    if (!last || !lastUnit) throw new SkeletonError(`Module ${module.number} has no units.`);
    const reduced = last.minutes - (PART_B_MINUTES + PART_C_MINUTES);
    if (reduced <= 0) {
      throw new SkeletonError(
        `Strategy "part_a_carve_last_unit" cannot be applied to module ${module.number}: its ` +
          `final unit ${lastUnit.code} is ${last.minutes} minutes, which cannot fund the ` +
          `${PART_B_MINUTES + PART_C_MINUTES} minutes needed for Parts B and C.`,
      );
    }
    out[lastIndex] = {
      minutes: reduced,
      label: minutesLabel(reduced),
      provenance: {
        kind: 'derived',
        rule: 'part_a_carve_last_unit: final unit reduced by Part B + Part C duration',
        inputs: [`${lastUnit.code}=${last.minutes}`, `partB=${PART_B_MINUTES}`, `partC=${PART_C_MINUTES}`],
        ref: lastUnit.source,
      },
    };
    return out;
  }

  // part_a_minus_30: scale unit minutes to (total - 30), round to the nearest 5,
  // then push any rounding remainder onto the longest unit so the sum is exact.
  const target = module.minutes - (PART_B_MINUTES + PART_C_MINUTES);
  if (target <= 0) {
    throw new SkeletonError(
      `Strategy "part_a_minus_30" cannot be applied to module ${module.number}: its total of ` +
        `${module.minutes} minutes leaves nothing for Part A after Parts B and C.`,
    );
  }
  const scale = target / module.minutes;
  const scaled = module.units.map((u) => Math.max(5, Math.round((u.minutes * scale) / 5) * 5));
  const drift = scaled.reduce((a, b) => a + b, 0) - target;
  if (drift !== 0) {
    let longest = 0;
    for (let i = 1; i < scaled.length; i++) if (scaled[i]! > scaled[longest]!) longest = i;
    scaled[longest] = scaled[longest]! - drift;
  }

  return module.units.map((u, i) => ({
    minutes: scaled[i]!,
    label: minutesLabel(scaled[i]!),
    provenance: {
      kind: 'derived',
      rule: `part_a_minus_30: unit minutes scaled by (${module.minutes}-30)/${module.minutes}, rounded to 5, remainder on longest unit`,
      inputs: [`${u.code}=${u.minutes}`, `moduleTotal=${module.minutes}`],
      ref: u.source,
    },
  }));
}

function buildPartA(module: TimingModule, nosCode: string, strategy: TimingStrategy): PartA {
  const durations = allocatePartA(module, strategy);
  const rows: PartARow[] = module.units.map((unit, i) => ({
    row_id: `m${String(module.number).padStart(2, '0')}-a-${unit.code}`,
    unit_code: unit.code,
    unit_label: `Unit ${unit.code}: ${unit.title}`,
    unit_title: unit.title,
    duration: durations[i]!,
    activity_name: '',
    interactive_description: '',
    correlation: nosCode,
    nos_code: nosCode,
    performance_criteria: [],
    sources: [],
  }));

  const headerMinutes = durations.reduce((a, d) => a + d.minutes, 0);
  return {
    header_hours: headerMinutes / 60,
    header_label: `Part A: eLMS with Online Faculty Instruction (${hoursLabel(headerMinutes).toLowerCase()})`,
    rows,
  };
}

function buildPartB(module: TimingModule): PartB {
  const rows: PartBRow[] = Array.from({ length: PART_B_SEGMENTS }, (_, i) => {
    const start = i * PART_B_SEGMENT_SECONDS;
    const end = start + PART_B_SEGMENT_SECONDS;
    return {
      row_id: `m${String(module.number).padStart(2, '0')}-b-${i + 1}`,
      time_range: `${mmss(start)}-${mmss(end)}`,
      start_seconds: start,
      end_seconds: end,
      visual: '',
      audio: '',
      sources: [],
    };
  });
  return { duration_minutes: PART_B_MINUTES, rows };
}

function buildPartC(module: TimingModule): PartC {
  const slides: Slide[] = Array.from({ length: PART_C_SLIDES }, (_, i) => ({
    slide_id: `m${String(module.number).padStart(2, '0')}-c-s${i + 1}`,
    number: i + 1,
    title: '',
    visual_cues: '',
    instructor_script: '',
    sources: [],
  }));
  return {
    duration_minutes: PART_C_MINUTES,
    deck_title: `Slide Deck & Presenter Script: Module ${module.number} Live Session`,
    subtitle: '',
    slides,
  };
}

function buildFrontMatter(course: CourseConfig, allocation: TimingAllocation, timingRef: SourceRef): FrontMatter {
  const metadata: FrontMatter['metadata'] = [
    { field: 'Qualification / Course', specification: course.name, sources: [] },
    { field: 'Sector', specification: course.sector, sources: [] },
    { field: 'Sub-sector', specification: course.sub_sector, sources: [] },
    { field: 'Occupation', specification: course.occupation, sources: [] },
    { field: 'QP Code', specification: course.qp_code, sources: [] },
    { field: 'NSQF Level', specification: course.nsqf_level, sources: [] },
    { field: 'Reference ID', specification: course.reference_id, sources: [] },
    {
      field: 'Total Duration',
      specification: `${allocation.stated_total_hours} Hours (${allocation.stated_total_minutes.toLocaleString('en-US')} Mins)`,
      sources: [timingRef],
    },
  ];

  return {
    title: course.name,
    subtitle: course.subtitle,
    strapline: `Official SCGJ Metadata Curriculum Storyboard & Assessment StrategyNSQF Level ${course.nsqf_level} | Micro-credential Reference: ${course.qp_code}`,
    blueprint_heading: `${course.name}: Storyboard & Curriculum Blueprint`,
    metadata,
    guideline_groups: ['1. xAPI Event Stream Configuration', '2. SCORM State Variable Persistence'],
    guidelines: [],
  };
}

export interface BuildSkeletonOptions {
  courseId: string;
  allocation: TimingAllocation;
  templateVersion: string;
  timingStrategy?: TimingStrategy;
  /** Restrict to these timing-document module numbers. Defaults to all. */
  modules?: readonly number[];
}

export function buildSkeleton(options: BuildSkeletonOptions): StoryboardState {
  const { courseId, allocation, templateVersion } = options;
  const strategy = options.timingStrategy ?? 'part_a_verbatim';
  const course = getCourseConfig(courseId);

  const wanted = options.modules;
  const timingModules = wanted
    ? allocation.modules.filter((m) => wanted.includes(m.number))
    : allocation.modules;

  if (timingModules.length === 0) {
    throw new SkeletonError(
      `No modules selected for course "${courseId}". Requested: ${wanted?.join(', ') ?? '(all)'}; ` +
        `available: ${allocation.modules.map((m) => m.number).join(', ')}.`,
    );
  }

  // A document-routed course states its sources in a master file rather than a
  // crosswalk, so there is no crosswalk entry to read. Its module number is its
  // own source scope, and it declares no known content gaps.
  const routed = isDocumentRouted(courseId);

  const modules: StoryboardModule[] = timingModules.map((tm) => {
    const cw = routed
      ? {
          timing_module: tm.number,
          timing_title: tm.title,
          source_chapter: tm.number,
          nos_code: moduleScope(courseId, tm.number).nos_code,
          no_source_content: undefined,
          elective: undefined,
        }
      : getCrosswalkEntry(courseId, tm.number);
    const gap = cw.no_source_content;

    const insufficient = gap
      ? {
          status: 'INSUFFICIENT_SOURCE_CONTENT' as const,
          requested: `Module ${tm.number} content ("${tm.title}")`,
          searched: ['QP', 'PH', 'FG'] as const,
          message:
            `${gap.reason} The approved documents state instead: "${gap.source_statement}" ` +
            `Supply ${gap.required_document} as an approved source document to generate this module.`,
        }
      : undefined;

    return {
      module_id: `module_${String(tm.number).padStart(2, '0')}`,
      number: tm.number,
      title: tm.title,
      duration: {
        minutes: tm.minutes,
        label: hoursLabel(tm.minutes),
        provenance: { kind: 'timing_document', ref: tm.source, raw: tm.raw_duration },
      },
      duration_label: `Total Duration: ${hoursLabel(tm.minutes)}`,
      description: insufficient ?? '',
      description_sources: [],
      source_chapter: cw.source_chapter,
      nos_code: cw.nos_code,
      ...(cw.elective !== undefined ? { elective: cw.elective } : {}),
      part_a: insufficient ?? buildPartA(tm, cw.nos_code, strategy),
      lms_mapping: insufficient ?? { rows: [] },
      part_b: insufficient ?? buildPartB(tm),
      part_c: insufficient ?? buildPartC(tm),
    };
  });

  const timingRef: SourceRef = {
    document_type: 'TIMING',
    pdf_page: 1,
    section: 'Document header',
    chunk_id: `timing:${courseId}:header`,
  };

  return {
    // Replaced with the allocated id when the artifact is created.
    artifact_id: 'PENDING',
    course_id: courseId,
    version: 0,
    template_version: templateVersion,
    timing_strategy: strategy,
    front_matter: buildFrontMatter(course, allocation, timingRef),
    modules,
    assessment: {
      status: 'INSUFFICIENT_SOURCE_CONTENT',
      requested: 'Assessment blueprint and question bank',
      searched: ['QP', 'PH', 'FG'],
      message:
        'The assessment blueprint has not been populated yet. Retrieve the QP assessment ' +
        'weightage table and the per-module source content, then submit it via ' +
        'set_storyboard_content with section "assessment".',
    },
  };
}
