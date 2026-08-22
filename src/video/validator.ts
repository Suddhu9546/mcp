/**
 * Video transcript validation -- mechanical, like the storyboard's.
 *
 * Three questions can be answered without a model, so those are the three asked:
 *
 *   Structure   is there exactly one scene per planned scene, in order, with
 *               narration in it?
 *   Duration    does the script's word count read back in about the time the user
 *               asked for, at the plan's stated speaking rate?
 *   Grounding   does every scene cite chunks that resolve, that come from the
 *               Participant Handbook, and that belong to *this unit* -- and does
 *               its wording measurably overlap them?
 *
 * Whether the narration is a fair rendering of the source is a reasoning question
 * and stays with the client. Findings are reported and never repaired here.
 */


export function countWords(text: string): number {
  const matched = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu);
  return matched ? matched.length : 0;
}

/** How far off the requested duration is acceptable before it is worth reporting. */

/**
 * References to the source that must not appear in the script itself.
 *
 * The citations belong in the stored state, where validation and audit use them.
 * They do not belong in what the narrator says or in what is burned onto the
 * screen: "Watch: NREL Energy Basics -- Biomass (QR in handbook, p.11)" is an
 * instruction to a reader of the handbook, not a line of a video, and a user
 * copying the script has to strip it out by hand. Caught mechanically because the
 * patterns are unambiguous and a reminder in the prompt is not enforcement.
 */
const SOURCE_REFERENCE_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /\b(participant\s+handbook|facilitator\s+guide|faculty\s+guide|qualification\s+pack)\b/i, what: 'a source document by name' },
  { pattern: /\b(handbook|workbook)\b/i, what: 'the handbook' },
  { pattern: /\bpp?\.\s?\d+/i, what: 'a page number' },
  { pattern: /\bpages?\s+\d+/i, what: 'a page number' },
  { pattern: /\b(figure|fig\.|table|annexure)\s*\d+/i, what: 'a figure or table number' },
  { pattern: /\bQR\b/, what: 'a QR code reference' },
  { pattern: /\b(SGJ|DGT)\/[NQ]?\w*\d+/i, what: 'a qualification code' },
  { pattern: /\b(unit|module|chapter)\s+\d+(\.\d+)?\b/i, what: 'a unit, module or chapter number' },
];

export function findSourceReference(text: string): { what: string; match: string } | undefined {
  for (const { pattern, what } of SOURCE_REFERENCE_PATTERNS) {
    const found = pattern.exec(text);
    if (found) return { what, match: found[0] };
  }
  return undefined;
}
