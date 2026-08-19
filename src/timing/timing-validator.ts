/**
 * Level 2 validation -- timing arithmetic.
 *
 * Checks, per the spec:
 *   SUM(unit minutes)   === module minutes,  for every module
 *   SUM(module minutes) === stated course total
 *
 * A discrepancy is reported, never repaired. Silently adjusting a duration to
 * make the arithmetic close would defeat the purpose of the timing document.
 */

import type {
  TimingAllocation,
  TimingArithmeticReport,
  TimingDiscrepancy,
} from '../types/timing.js';

export function validateTimingArithmetic(allocation: TimingAllocation): TimingArithmeticReport {
  const discrepancies: TimingDiscrepancy[] = [];

  let computedTotal = 0;
  let allModulesOk = true;

  for (const module of allocation.modules) {
    const unitSum = module.units.reduce((acc, u) => acc + u.minutes, 0);
    computedTotal += module.minutes;

    if (unitSum !== module.minutes) {
      allModulesOk = false;
      discrepancies.push({
        scope: 'module',
        module: module.number,
        stated: module.minutes,
        computed: unitSum,
        delta: unitSum - module.minutes,
        message:
          `Module ${module.number} ("${module.title}") is stated as ${module.minutes} minutes ` +
          `(${module.stated_hours} hours) but its ${module.units.length} units sum to ${unitSum} minutes ` +
          `(delta ${unitSum - module.minutes >= 0 ? '+' : ''}${unitSum - module.minutes}). ` +
          'The Timing Allocation Document is internally inconsistent for this module.',
      });
    }

    // Cross-check the stated hours figure against the stated minutes figure on
    // each unit; the document prints both and they should agree.
    for (const unit of module.units) {
      const impliedMinutes = Math.round(unit.stated_hours * 60);
      if (impliedMinutes !== unit.minutes) {
        allModulesOk = false;
        discrepancies.push({
          scope: 'module',
          module: module.number,
          stated: unit.minutes,
          computed: impliedMinutes,
          delta: impliedMinutes - unit.minutes,
          message:
            `Unit ${unit.code} ("${unit.title}") states "${unit.raw_duration}", but ` +
            `${unit.stated_hours} hours is ${impliedMinutes} minutes, not ${unit.minutes}.`,
        });
      }
    }
  }

  const courseTotalOk = computedTotal === allocation.stated_total_minutes;
  if (!courseTotalOk) {
    discrepancies.push({
      scope: 'course',
      stated: allocation.stated_total_minutes,
      computed: computedTotal,
      delta: computedTotal - allocation.stated_total_minutes,
      message:
        `The document header states a total of ${allocation.stated_total_minutes} minutes ` +
        `(${allocation.stated_total_hours} hours) but the ${allocation.modules.length} module ` +
        `durations sum to ${computedTotal} minutes.`,
    });
  }

  return {
    course_total_ok: courseTotalOk,
    all_modules_ok: allModulesOk,
    computed_total_minutes: computedTotal,
    discrepancies,
  };
}

/** Attaches the report to the allocation and returns it. */
export function withValidatedArithmetic(allocation: TimingAllocation): TimingAllocation {
  return { ...allocation, arithmetic: validateTimingArithmetic(allocation) };
}

/**
 * Throws when the timing document cannot be trusted. Called before any
 * timing-dependent generation, per ERROR HANDLING: "Timing inconsistency -> flag
 * the inconsistency. Do not silently invent timing."
 */
export function assertTimingUsable(allocation: TimingAllocation): void {
  const { arithmetic } = allocation;
  if (arithmetic.course_total_ok && arithmetic.all_modules_ok) return;
  const lines = arithmetic.discrepancies.map((d) => `  - ${d.message}`).join('\n');
  throw new Error(
    `Timing Allocation Document for course "${allocation.course_id}" failed arithmetic ` +
      `validation. Storyboard generation is blocked because durations cannot be ` +
      `established from the authoritative source:\n${lines}`,
  );
}
