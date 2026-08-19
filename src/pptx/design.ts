/**
 * The CVC deck design system.
 *
 * One place, so every slide is the same deck. The palette is the warm editorial one
 * the course uses: a cream page rather than white, deep green type rather than
 * black, a single green accent, hairline borders and a lot of air. White slides with
 * black Calibri are what a generated deck looks like when nobody decided anything;
 * this file is that decision.
 *
 * Restraint is part of the specification, not an accident of effort: no gradients,
 * no shadows, no second accent colour, no decorative furniture. If a change here
 * makes a slide busier, it is the wrong change.
 */

export const CVC = {
  colour: {
    /** Warm cream page. */
    background: 'FAF6EC',
    /** Deep forest green: titles and headings. */
    ink: '17352A',
    /** Body text: the same green, lightened enough to sit under the titles. */
    body: '2F4A3E',
    /** Muted green-grey: captions, labels, slide numbers. */
    muted: '7B8C82',
    /** The single accent, used for rules, bullets and diagram fills. */
    accent: '3F7A55',
    /** Tint of the accent, for diagram cards. */
    accentSoft: 'E4EDE5',
    /** Hairline borders on cards and diagram boxes. */
    border: 'DCD5C2',
    /** Card fill, a shade lighter than the page. */
    card: 'FFFDF7',
  },
  font: {
    /** Titles. A serif would fight the diagrams; this is the editorial sans. */
    heading: 'Georgia',
    body: 'Calibri',
  },
  size: {
    deckTitle: 4400,
    slideTitle: 2800,
    unitLabel: 1200,
    bullet: 1800,
    takeaway: 1400,
    caption: 1100,
    diagramLabel: 1200,
  },
} as const;

/** 16:9 at the standard EMU size, and the margins every slide is built on. */
export const GEOMETRY = {
  slideWidth: 12192000,
  slideHeight: 6858000,
  margin: 838200,
  titleTop: 620000,
  titleHeight: 1150000,
  bodyTop: 1950000,
  bodyHeight: 3600000,
  /** Left column holds the teaching text; the right holds the visual. */
  leftWidth: 6000000,
  gutter: 400000,
} as const;

export const RIGHT_COLUMN_X = GEOMETRY.margin + GEOMETRY.leftWidth + GEOMETRY.gutter;
export const RIGHT_COLUMN_WIDTH =
  GEOMETRY.slideWidth - RIGHT_COLUMN_X - GEOMETRY.margin;
