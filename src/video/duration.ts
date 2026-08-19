/**
 * Duration parsing.
 *
 * The user says "2 min", "90 seconds", "1:30" or just "2". All of them are the
 * same request, and none of them should cost a round trip to clarify. A bare
 * number is read as minutes, because that is how people state video lengths.
 */

export class DurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurationError';
  }
}

const MMSS_RE = /^(\d{1,2}):([0-5]\d)$/;
const NUMBER_UNIT_RE = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|s|sec|secs|second|seconds)?$/;

export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) {
      throw new DurationError(`"${input}" is not a usable duration.`);
    }
    // A bare number is minutes, matching how the question is asked.
    return Math.round(input * 60);
  }

  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text.length === 0) throw new DurationError('No duration given.');

  const mmss = MMSS_RE.exec(text);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);

  const numeric = NUMBER_UNIT_RE.exec(text);
  if (numeric) {
    const value = Number(numeric[1]);
    const unit = numeric[2] ?? 'm';
    const seconds = unit.startsWith('s') ? value : value * 60;
    if (seconds <= 0) throw new DurationError(`"${input}" is not a usable duration.`);
    return Math.round(seconds);
  }

  throw new DurationError(
    `Could not read "${input}" as a duration. Use forms like "2 min", "90 seconds", "1:30" or "2".`,
  );
}
