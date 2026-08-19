/**
 * Continuity checking between segments.
 *
 * Each 10-second clip is generated in isolation, so the only thing holding the film
 * together is what the script says explicitly: that this segment opens on the state
 * the last one ended in, that the protagonist looks the same, that we are in a place
 * the film has established. Those are claims in text, and claims in text can be
 * checked without a model.
 *
 * What is checked is the *link*, not the quality: whether segment N's opening state
 * refers to the same things as segment N-1's closing state. A hand holding residue
 * followed by a hand placing residue on a scale shares "hand" and "residue" and
 * passes; a hand holding residue followed by a drone shot of a distant highway
 * shares nothing and is reported. A person still has to decide whether the cut is
 * any good.
 */

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'of', 'in', 'to', 'a', 'an', 'with', 'on', 'at', 'by', 'from', 'that',
  'this', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'as', 'it', 'its', 'or',
  'their', 'they', 'you', 'your', 'will', 'can', 'should', 'must', 'which', 'what', 'how',
  'we', 'he', 'she', 'his', 'her', 'him', 'into', 'onto', 'over', 'still', 'same', 'then',
  'now', 'next', 'shot', 'camera', 'frame', 'scene', 'segment', 'continues', 'begins', 'ends',
  'holds', 'held', 'moving', 'moves', 'seen', 'shows', 'showing', 'while', 'after', 'before',
]);

/** Content words, lightly stemmed so "bales" and "bale" match. */
export function continuityTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t))
    .map((t) => (t.endsWith('ies') ? `${t.slice(0, -3)}y` : t.endsWith('es') && t.length > 4 ? t.slice(0, -2) : t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
    .map((t) => (t.endsWith('ing') && t.length > 5 ? t.slice(0, -3) : t));
  return new Set(tokens);
}

export interface ContinuityLink {
  shared: string[];
  /** Share of the incoming description's distinctive words that the outgoing one also used. */
  overlap: number;
}

/**
 * Measures how strongly one description carries over into another.
 *
 * Scored against the shorter of the two so that a long, detailed hand-over is not
 * penalised for being detailed: what matters is whether the same subject, object or
 * action appears on both sides of the cut.
 */
export function linkStrength(previousEnd: string, nextStart: string): ContinuityLink {
  const a = continuityTokens(previousEnd);
  const b = continuityTokens(nextStart);
  if (a.size === 0 || b.size === 0) return { shared: [], overlap: 0 };

  const shared = [...b].filter((t) => a.has(t));
  return { shared, overlap: shared.length / Math.min(a.size, b.size) };
}

/** Below this the cut reads as a jump rather than a continuation. */
export const WEAK_LINK_OVERLAP = 0.2;

/**
 * Visuals that break the film's world.
 *
 * The brief is a rural documentary shot by one crew. These are the defaults a model
 * reaches for when it stops thinking about the world and starts thinking about
 * "video": a studio, a hologram, floating icons. Flagged rather than blocked --
 * occasionally a diagram genuinely is the clearest way to show something -- but a
 * segment claiming to be real-world footage may not contain them.
 */
export const OUT_OF_WORLD_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /\bwhite (studio|background|void|room)\b/i, what: 'a white studio' },
  { pattern: /\b(futuristic|sci-?fi|hologram|holographic|neon)\b/i, what: 'a futuristic or holographic look' },
  { pattern: /\b(corporate office|boardroom|glass tower|skyscraper)\b/i, what: 'a corporate office' },
  { pattern: /\b(laboratory|lab coat)\b/i, what: 'a laboratory' },
  { pattern: /\bfloating (text|icons?|infographics?|numbers?)\b/i, what: 'floating graphics' },
  { pattern: /\b(rotating platform|turntable|3d render|cgi render)\b/i, what: 'a rendered showcase shot' },
  { pattern: /\bsplit[- ]screen\b/i, what: 'a split screen' },
  { pattern: /\b(stock footage|generic business|silicon valley|startup montage)\b/i, what: 'generic stock imagery' },
  { pattern: /\b(white flash|light leak transition|wipe transition|swipe transition)\b/i, what: 'an unmotivated transition' },
];

export function findOutOfWorldVisual(text: string): { what: string; match: string } | undefined {
  for (const { pattern, what } of OUT_OF_WORLD_PATTERNS) {
    const found = pattern.exec(text);
    if (found) return { what, match: found[0] };
  }
  return undefined;
}

/** Sentence count, for the one-idea-per-segment rule. */
export function sentenceCount(text: string): number {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length;
}

export interface SubtitleCue {
  /** Seconds from the start of the film. */
  start_seconds: number;
  end_seconds: number;
  /** The words revealed so far, which is what a typewriter reveal shows. */
  text: string;
  /** The word added at this cue. */
  word: string;
}

/**
 * Builds a progressive, word-by-word subtitle reveal for one segment.
 *
 * Timing is proportional to word length rather than uniform: "a" and
 * "entrepreneur" do not take the same time to say, and evenly spaced cues drift
 * audibly out of sync by the end of a line. This is an approximation of speech
 * timing, not a transcript alignment -- it has no audio to align to -- so it is
 * offered as a starting point an editor can nudge.
 */
export function buildSubtitleCues(
  narration: string,
  startSeconds: number,
  durationSeconds: number,
): SubtitleCue[] {
  const words = narration.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  // A short pause after punctuation, which is where a reader expects one.
  const weights = words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length + (/[.,;:!?]$/.test(w) ? 3 : 1));
  const total = weights.reduce((a, w) => a + w, 0);

  const cues: SubtitleCue[] = [];
  let elapsed = 0;
  let revealed = '';
  for (const [index, word] of words.entries()) {
    const share = (weights[index]! / total) * durationSeconds;
    const start = startSeconds + elapsed;
    elapsed += share;
    revealed = revealed.length === 0 ? word : `${revealed} ${word}`;
    cues.push({
      start_seconds: Number(start.toFixed(2)),
      end_seconds: Number((startSeconds + elapsed).toFixed(2)),
      text: revealed,
      word,
    });
  }
  return cues;
}

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0');
  const milli = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${milli}`;
}

/** Renders cues as SubRip, which is what an editor or a burn-in tool takes. */
export function toSrt(cues: readonly SubtitleCue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${srtTime(cue.start_seconds)} --> ${srtTime(cue.end_seconds)}\n${cue.text}\n`)
    .join('\n');
}
