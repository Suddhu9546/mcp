/**
 * Native diagram drawing for the right-hand column.
 *
 * A slide's right side is half its teaching area. Filled with a stock photograph it
 * teaches nothing; filled with a labelled diagram it carries the structure of the
 * idea while the words carry the detail. So the labelled visual types are drawn as
 * real PowerPoint shapes -- rounded cards, arrows, numbered rings -- which means
 * they are editable, they print, and they need no image generation at all.
 *
 * Only the shapes a handbook concept actually calls for are here: a sequence, a
 * cycle, a comparison, a set of parts, a cause and its effect, a reading on an
 * instrument. Anything else falls back to a titled brief card, which is honest about
 * being a brief rather than pretending to be a diagram.
 */

import { CVC, RIGHT_COLUMN_WIDTH, RIGHT_COLUMN_X, GEOMETRY } from './design.js';
import type { SlideVisual, SlideVisualType } from '../types/module-content.js';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '');
}

interface ShapeOptions {
  id: number;
  name: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
  geometry?: string;
  fill?: string;
  line?: string;
  lineWidth?: number;
  text?: string;
  textColour?: string;
  textSize?: number;
  bold?: boolean;
  align?: 'ctr' | 'l';
}

/** One drawn shape. Text is centred and wrapped, which is what a label wants. */
function shape(options: ShapeOptions): string {
  const {
    id,
    name,
    x,
    y,
    cx,
    cy,
    geometry = 'roundRect',
    fill,
    line,
    lineWidth = 9525,
    text,
    textColour = CVC.colour.ink,
    textSize = CVC.size.diagramLabel,
    bold = false,
    align = 'ctr',
  } = options;

  const fillXml = fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : '<a:noFill/>';
  const lineXml = line
    ? `<a:ln w="${lineWidth}"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>`
    : '<a:ln><a:noFill/></a:ln>';
  const body =
    text === undefined
      ? '<a:p><a:endParaRPr lang="en-US"/></a:p>'
      : `<a:p><a:pPr algn="${align}"><a:buNone/></a:pPr><a:r>` +
        `<a:rPr lang="en-US" sz="${textSize}"${bold ? ' b="1"' : ''} dirty="0">` +
        `<a:solidFill><a:srgbClr val="${textColour}"/></a:solidFill>` +
        `<a:latin typeface="${CVC.font.body}"/></a:rPr>` +
        `<a:t>${esc(text)}</a:t></a:r></a:p>`;

  return (
    '<p:sp>' +
    `<p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom>${fillXml}${lineXml}</p:spPr>` +
    `<p:txBody><a:bodyPr lIns="91440" rIns="91440" tIns="45720" bIns="45720" anchor="ctr" wrap="square">` +
    `<a:normAutofit fontScale="90000" lnSpcReduction="10000"/></a:bodyPr><a:lstStyle/>${body}</p:txBody>` +
    '</p:sp>'
  );
}

/** How many labels a shape of this type can carry before it stops being readable. */
const MAX_LABELS = 6;

/** Types drawn as real shapes. Everything else becomes a brief card. */
const DRAWN: readonly SlideVisualType[] = [
  'process',
  'workflow',
  'lifecycle',
  'comparison',
  'components',
  'relationship',
  'cause_effect',
  'measurement',
];

export function isDrawable(visual: SlideVisual | undefined): boolean {
  return visual !== undefined && DRAWN.includes(visual.type) && visual.labels.length >= 2;
}

/**
 * Draws the visual into the right-hand column.
 *
 * Returns the shape XML and the next free shape id, so the caller can keep ids
 * unique across the slide -- PowerPoint rejects a slide with two shapes sharing one.
 */
export function drawVisual(
  visual: SlideVisual,
  firstId: number,
): { xml: string; nextId: number } {
  const x = RIGHT_COLUMN_X;
  const width = RIGHT_COLUMN_WIDTH;
  const top = GEOMETRY.bodyTop;
  const height = GEOMETRY.bodyHeight;
  const labels = visual.labels.slice(0, MAX_LABELS);
  let id = firstId;
  const parts: string[] = [];

  const caption = (y: number): string =>
    shape({
      id: id++,
      name: 'Visual caption',
      x,
      y,
      cx: width,
      cy: 400000,
      geometry: 'rect',
      text: visual.description,
      textColour: CVC.colour.muted,
      textSize: CVC.size.caption,
      align: 'ctr',
    });

  switch (visual.type) {
    case 'comparison': {
      // Two columns, side by side, so the contrast is the shape of the visual.
      const columns = Math.min(labels.length, 3);
      const gap = 200000;
      const columnWidth = (width - gap * (columns - 1)) / columns;
      labels.slice(0, columns).forEach((label, i) => {
        parts.push(
          shape({
            id: id++,
            name: `Compare ${i + 1}`,
            x: x + i * (columnWidth + gap),
            y: top,
            cx: columnWidth,
            cy: height - 500000,
            fill: i === 0 ? CVC.colour.accentSoft : CVC.colour.card,
            line: CVC.colour.border,
            text: label,
            bold: true,
          }),
        );
      });
      parts.push(caption(top + height - 450000));
      break;
    }

    case 'components': {
      // A part list: even cards, no arrows, because parts have no order.
      const gap = 140000;
      const cardHeight = (height - 500000 - gap * (labels.length - 1)) / labels.length;
      labels.forEach((label, i) => {
        parts.push(
          shape({
            id: id++,
            name: `Component ${i + 1}`,
            x,
            y: top + i * (cardHeight + gap),
            cx: width,
            cy: cardHeight,
            fill: CVC.colour.card,
            line: CVC.colour.border,
            text: label,
            align: 'ctr',
          }),
        );
      });
      parts.push(caption(top + height - 450000));
      break;
    }

    case 'lifecycle': {
      // Numbered stages round a loop; the last card states the return.
      const gap = 120000;
      const cardHeight = (height - 500000 - gap * labels.length) / labels.length;
      labels.forEach((label, i) => {
        parts.push(
          shape({
            id: id++,
            name: `Stage ${i + 1}`,
            x,
            y: top + i * (cardHeight + gap),
            cx: width,
            cy: cardHeight,
            fill: i === 0 ? CVC.colour.accentSoft : CVC.colour.card,
            line: CVC.colour.border,
            text: `${i + 1}. ${label}`,
          }),
        );
      });
      parts.push(
        shape({
          id: id++,
          name: 'Cycle back',
          x: x + width / 2 - 400000,
          y: top + labels.length * (cardHeight + gap) - 40000,
          cx: 800000,
          cy: 260000,
          geometry: 'upArrow',
          fill: CVC.colour.accent,
          text: undefined,
        }),
      );
      parts.push(caption(top + height - 420000));
      break;
    }

    case 'cause_effect':
    case 'relationship':
    case 'measurement':
    case 'process':
    case 'workflow':
    default: {
      // A sequence: cards with arrows between them, top to bottom.
      const arrow = 200000;
      const gap = 90000;
      const cardHeight =
        (height - 500000 - (labels.length - 1) * (arrow + gap * 2)) / labels.length;
      labels.forEach((label, i) => {
        const y = top + i * (cardHeight + arrow + gap * 2);
        parts.push(
          shape({
            id: id++,
            name: `Step ${i + 1}`,
            x,
            y,
            cx: width,
            cy: cardHeight,
            fill: i === 0 ? CVC.colour.accentSoft : CVC.colour.card,
            line: CVC.colour.border,
            text: label,
          }),
        );
        if (i < labels.length - 1) {
          parts.push(
            shape({
              id: id++,
              name: `Arrow ${i + 1}`,
              x: x + width / 2 - 130000,
              y: y + cardHeight + gap,
              cx: 260000,
              cy: arrow,
              geometry: 'downArrow',
              fill: CVC.colour.accent,
            }),
          );
        }
      });
      parts.push(caption(top + height - 420000));
      break;
    }
  }

  return { xml: parts.join(''), nextId: id };
}

/**
 * The fallback: a titled card carrying the visual brief.
 *
 * Used when the visual is a photograph or a scene rather than a labelled structure.
 * It states what should be produced instead of pretending a diagram exists, which
 * is what a designer or an image generator needs to act on.
 */
export function drawVisualBrief(
  visual: SlideVisual | undefined,
  firstId: number,
): { xml: string; nextId: number } {
  let id = firstId;
  const x = RIGHT_COLUMN_X;
  const width = RIGHT_COLUMN_WIDTH;
  const top = GEOMETRY.bodyTop;
  const height = GEOMETRY.bodyHeight - 400000;

  const parts = [
    shape({
      id: id++,
      name: 'Visual brief card',
      x,
      y: top,
      cx: width,
      cy: height,
      fill: CVC.colour.card,
      line: CVC.colour.border,
    }),
    shape({
      id: id++,
      name: 'Visual brief label',
      x: x + 200000,
      y: top + 200000,
      cx: width - 400000,
      cy: 300000,
      geometry: 'rect',
      text: visual ? `VISUAL - ${visual.type.replace(/_/g, ' ')}` : 'VISUAL',
      textColour: CVC.colour.accent,
      textSize: CVC.size.caption,
      bold: true,
      align: 'l',
    }),
    shape({
      id: id++,
      name: 'Visual brief text',
      x: x + 200000,
      y: top + 560000,
      cx: width - 400000,
      cy: height - 760000,
      geometry: 'rect',
      text: visual?.description ?? 'No visual specified for this slide.',
      textColour: CVC.colour.body,
      textSize: CVC.size.diagramLabel,
      align: 'l',
    }),
  ];

  return { xml: parts.join(''), nextId: id };
}
