/**
 * Timing model, mirroring the structure actually found in
 * "Bio-fuels- Duration Breakdown.pdf".
 *
 * That document states, per module and per unit, an explicit duration in both
 * hours and minutes -- e.g. "UNIT 1.1 Fundamentals of Biofuels & Biomass Energy
 * (0.75 Hours / 45 Mins)". Unit minutes sum exactly to their module total, and
 * module totals sum exactly to the course total (30 Hours / 1,800 Mins).
 *
 * INVARIANT 3: these numbers are authoritative. Nothing here may be adjusted by
 * model judgement.
 */

import type { SourceRef, TimingProvenance } from './source.js';

/** A numbered sub-topic under a unit, e.g. "1.1.2 Types of biofuels: ...". */
export interface TimingSubTopic {
  code: string;
  title: string;
}

export interface TimingUnit {
  /** Unit code as printed in the timing document, e.g. "1.1". */
  code: string;
  title: string;
  /** Authoritative duration in minutes, as stated in the timing document. */
  minutes: number;
  /** The hours figure stated alongside it, retained for cross-checking. */
  stated_hours: number;
  /** The exact substring the duration was read from, for audit. */
  raw_duration: string;
  sub_topics: TimingSubTopic[];
  source: SourceRef;
}

export interface TimingModule {
  /** Module number as printed in the timing document, 1-based. */
  number: number;
  title: string;
  /** Authoritative module duration in minutes. */
  minutes: number;
  stated_hours: number;
  raw_duration: string;
  /** True when the title is marked "(Elective N)" in the timing document. */
  elective?: number;
  units: TimingUnit[];
  source: SourceRef;
}

/**
 * Parsed representation of an entire Timing Allocation Document. This is the
 * single authority for every duration in the generated storyboard.
 */
export interface TimingAllocation {
  course_id: string;
  qp_code: string;
  nsqf_level: string;
  /** Course total in minutes as *stated* in the document header. */
  stated_total_minutes: number;
  stated_total_hours: number;
  modules: TimingModule[];
  /** Populated by the timing validator; empty array means arithmetic is exact. */
  arithmetic: TimingArithmeticReport;
}

export interface TimingDiscrepancy {
  scope: 'course' | 'module';
  /** Module number, absent for course scope. */
  module?: number;
  stated: number;
  computed: number;
  delta: number;
  message: string;
}

export interface TimingArithmeticReport {
  /** SUM(module minutes) === stated course total. */
  course_total_ok: boolean;
  /** SUM(unit minutes) === module total, for every module. */
  all_modules_ok: boolean;
  computed_total_minutes: number;
  discrepancies: TimingDiscrepancy[];
}

/**
 * How the storyboard's Part A / Part B / Part C durations are derived from the
 * timing document. Selected once per course and recorded on the artifact so a
 * later regeneration cannot silently change the arithmetic.
 *
 * `part_a_verbatim` (the configured default for Biofuels): Part A carries the
 * timing document's unit minutes exactly as written, and its header hours equal
 * the full module duration. Part B (15-minute video) and Part C (15-minute live
 * session) are production assets with their own internal timelines and are not
 * counted against curriculum hours.
 *
 * `part_a_minus_30`: mirrors the Solar reference document, where a 3.0-hour
 * module reads Part A 2.5h + Part B 15m + Part C 15m. Part A unit minutes are
 * scaled by (total - 30)/total, rounded to the nearest 5, with any rounding
 * remainder taken from the longest unit so the sum stays exact.
 *
 * `part_a_carve_last_unit`: Part A keeps verbatim unit minutes except the final
 * unit of each module, which is reduced by 30 to fund Parts B and C.
 */
export type TimingStrategy = 'part_a_verbatim' | 'part_a_minus_30' | 'part_a_carve_last_unit';

/** A duration placed into the storyboard, with its provenance attached. */
export interface AllocatedDuration {
  minutes: number;
  /** Label rendered into the DOCX, e.g. "45 mins". */
  label: string;
  provenance: TimingProvenance;
}
