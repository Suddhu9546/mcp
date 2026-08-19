/**
 * Minimal PowerPoint writer.
 *
 * The storyboard renderer clones an approved template because its formatting is
 * contractual. There is no approved deck template, so this builds a presentation
 * from first principles instead: one master, one layout, one theme, and a slide per
 * item, each with its speaker notes attached.
 *
 * Written by hand rather than pulled from a library because the package already
 * depends on jszip for DOCX output and nothing else is needed -- a deck of title,
 * bullets and notes uses a small, stable corner of the format. Every part below is
 * required by the OPC and PresentationML schemas; PowerPoint refuses a package that
 * is missing any of them, which is why boilerplate that looks unused is not.
 *
 * Layout comes from ./design.ts and the right-hand diagrams from ./diagram.ts, so
 * every slide in the deck is laid out the same way.
 *
 * Two structural rules here were found the hard way, by bisecting a package
 * PowerPoint refused to open. Each master needs its own theme part, and the
 * extended-properties elements are an ordered sequence. Both produce the same
 * useless "corrupted and unreadable" message when broken, which is why ./validate.ts
 * checks the finished bytes before they are ever written to disk.
 */

import JSZip from 'jszip';
import { CVC, GEOMETRY } from './design.js';
import { PptxPackageError, validatePptxPackage } from './validate.js';
import { drawVisual, drawVisualBrief, isDrawable } from './diagram.js';
import type { SlideVisual } from '../types/module-content.js';

export interface PptxSlideInput {
  title: string;
  bullets: string[];
  /** Presenter script, attached as the slide's notes. */
  notes?: string;
  /** Small line the learner should leave with, set below the bullets. */
  takeaway?: string;
  /** Unit label above the title, e.g. "Unit 7.2". */
  eyebrow?: string;
  /** The right-hand teaching visual: drawn as shapes when it carries labels. */
  visual?: SlideVisual;
}

export interface PptxDeckInput {
  title: string;
  subtitle?: string;
  slides: PptxSlideInput[];
}

/** XML text escaping. Ampersands and angle brackets appear in real slide copy. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '');
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const NS_P =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** 16:9, from the design system so the deck and its diagrams agree. */
const SLIDE_W = GEOMETRY.slideWidth;
const SLIDE_H = GEOMETRY.slideHeight;

function contentTypes(slideCount: number): string {
  const slides = Array.from(
    { length: slideCount },
    (_, i) =>
      `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` +
      `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
  ).join('');

  return (
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    slides +
    '</Types>'
  );
}

const ROOT_RELS =
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>';

function presentation(slideCount: number): string {
  // Slide ids start at 256; anything lower is reserved and PowerPoint rejects it.
  const list = Array.from(
    { length: slideCount },
    (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`,
  ).join('');
  return (
    `${XML_HEADER}<p:presentation ${NS_P} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:notesMasterIdLst><p:notesMasterId r:id="rId${slideCount + 2}"/></p:notesMasterIdLst>` +
    `<p:sldIdLst>${list}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/>` +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '</p:presentation>'
  );
}

function presentationRels(slideCount: number): string {
  const slides = Array.from(
    { length: slideCount },
    (_, i) =>
      `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
  ).join('');
  return (
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    slides +
    `<Relationship Id="rId${slideCount + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>` +
    `<Relationship Id="rId${slideCount + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
    '</Relationships>'
  );
}

/** A placeholder shape carrying one or more paragraphs. */
function shape(
  id: number,
  name: string,
  placeholder: string,
  index: number | undefined,
  x: number,
  y: number,
  cx: number,
  cy: number,
  paragraphs: string,
): string {
  const ph = index === undefined ? `<p:ph type="${placeholder}"/>` : `<p:ph type="${placeholder}" idx="${index}"/>`;
  return (
    '<p:sp>' +
    `<p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody>` +
    '</p:sp>'
  );
}

function para(
  text: string,
  options: {
    size?: number;
    bullet?: boolean;
    bold?: boolean;
    colour?: string;
    font?: string;
    spaceAfter?: number;
  } = {},
): string {
  const {
    size,
    bullet = false,
    bold = false,
    colour = CVC.colour.body,
    font = CVC.font.body,
    spaceAfter = 600,
  } = options;
  const props =
    `<a:pPr${bullet ? ' marL="285750" indent="-285750"' : ''}>` +
    `<a:spcAft><a:spcPct val="${spaceAfter}"/></a:spcAft>` +
    (bullet
      ? `<a:buClr><a:srgbClr val="${CVC.colour.accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="\u2013"/>`
      : '<a:buNone/>') +
    '</a:pPr>';
  const runProps =
    `<a:rPr lang="en-US"${size ? ` sz="${size}"` : ''}${bold ? ' b="1"' : ''} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${colour}"/></a:solidFill>` +
    `<a:latin typeface="${font}"/>` +
    '</a:rPr>';
  return `<a:p>${props}<a:r>${runProps}<a:t>${esc(text)}</a:t></a:r></a:p>`;
}

function emptyPara(): string {
  return '<a:p><a:endParaRPr lang="en-US"/></a:p>';
}

/**
 * One slide.
 *
 * The composition is fixed across the deck: an optional unit label, a title under a
 * short accent rule, teaching cues down the left, and the visual down the right.
 * Fixed on purpose -- a deck where every slide is laid out differently reads as a
 * collection of slides rather than one course.
 */
function slideXml(slide: PptxSlideInput, isTitleSlide: boolean): string {
  const shapes: string[] = [];
  let id = 2;

  if (slide.eyebrow) {
    shapes.push(
      textBox(
        id++,
        'Unit label',
        GEOMETRY.margin,
        GEOMETRY.titleTop - 330000,
        GEOMETRY.leftWidth,
        300000,
        para(slide.eyebrow.toUpperCase(), {
          size: CVC.size.unitLabel,
          colour: CVC.colour.accent,
          bold: true,
        }),
      ),
    );
  }

  shapes.push(
    textBox(
      id++,
      'Title',
      GEOMETRY.margin,
      GEOMETRY.titleTop,
      isTitleSlide ? SLIDE_W - GEOMETRY.margin * 2 : GEOMETRY.leftWidth + 800000,
      GEOMETRY.titleHeight,
      para(slide.title, {
        size: isTitleSlide ? CVC.size.deckTitle : CVC.size.slideTitle,
        colour: CVC.colour.ink,
        bold: true,
        font: CVC.font.heading,
        spaceAfter: 0,
      }),
      'bottom',
    ),
  );

  // A short accent rule under the title: the deck's one piece of ornament.
  shapes.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="Accent rule"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${GEOMETRY.margin}" y="${GEOMETRY.titleTop + GEOMETRY.titleHeight + 60000}"/>` +
      `<a:ext cx="900000" cy="45720"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      `<a:solidFill><a:srgbClr val="${CVC.colour.accent}"/></a:solidFill></p:spPr>` +
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>',
  );

  const bulletParas =
    slide.bullets.length > 0
      ? slide.bullets.map((b) => para(b, { size: CVC.size.bullet, bullet: !isTitleSlide })).join('')
      : emptyPara();
  const takeaway = slide.takeaway
    ? para(slide.takeaway, { size: CVC.size.takeaway, colour: CVC.colour.accent, bold: true })
    : '';

  shapes.push(
    textBox(
      id++,
      'Content',
      GEOMETRY.margin,
      GEOMETRY.bodyTop,
      isTitleSlide && !slide.visual ? SLIDE_W - GEOMETRY.margin * 2 : GEOMETRY.leftWidth,
      GEOMETRY.bodyHeight,
      bulletParas + (takeaway ? emptyPara() + takeaway : ''),
    ),
  );

  // The right column teaches: a drawn diagram where the visual carries labels, a
  // brief card where it does not.
  if (slide.visual) {
    const drawn = isDrawable(slide.visual)
      ? drawVisual(slide.visual, id)
      : drawVisualBrief(slide.visual, id);
    shapes.push(drawn.xml);
    id = drawn.nextId;
  }

  return (
    `${XML_HEADER}<p:sld ${NS_P}><p:cSld>` +
    `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${CVC.colour.background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    '<p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes.join('') +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

/** A plain text box. Slides use these rather than placeholders so the layout holds. */
function textBox(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  paragraphs: string,
  anchor: 'top' | 'bottom' = 'top',
): string {
  return (
    '<p:sp>' +
    `<p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0" tIns="0" bIns="0"${
      anchor === 'bottom' ? ' anchor="b"' : ''
    }><a:normAutofit/></a:bodyPr>` +
    `<a:lstStyle/>${paragraphs}</p:txBody>` +
    '</p:sp>'
  );
}

function slideRels(index: number): string {
  return (
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${index}.xml"/>` +
    '</Relationships>'
  );
}

/**
 * The notes slide.
 *
 * This is where the presenter script lives, which is the point of generating a
 * deck rather than a list of bullets: the forty seconds of narration per slide
 * travels with the slide instead of in a separate document.
 */
function notesSlideXml(notes: string, slideNumber: number): string {
  const paragraphs = notes
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => para(line, { size: 1200 }))
    .join('');

  return (
    `${XML_HEADER}<p:notes ${NS_P}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs || emptyPara()}</p:txBody></p:sp>` +
    '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="sldNum" sz="quarter" idx="10"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1200"/><a:t>${slideNumber}</a:t></a:r></a:p></p:txBody></p:sp>` +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
  );
}

function notesSlideRels(slideIndex: number): string {
  return (
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/>' +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${slideIndex}.xml"/>` +
    '</Relationships>'
  );
}

/** Placeholder geometry shared by the master and the single layout. */
function placeholderShapes(): string {
  return (
    shape(2, 'Title Placeholder', 'title', undefined, 838200, 697706, 10515600, 1325563, emptyPara()) +
    shape(3, 'Text Placeholder', 'body', 1, 838200, 2160588, 10515600, 3000000, emptyPara())
  );
}

const TEXT_STYLES =
  '<p:txStyles>' +
  '<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200" b="1"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill>' +
  '<a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr marL="285750" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="•"/>' +
  '<a:defRPr sz="2000"><a:solidFill><a:srgbClr val="262626"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>' +
  '<a:lvl2pPr marL="742950" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="–"/>' +
  '<a:defRPr sz="1800"/></a:lvl2pPr></p:bodyStyle>' +
  '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>' +
  '</p:txStyles>';

const SLIDE_MASTER =
  `${XML_HEADER}<p:sldMaster ${NS_P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${CVC.colour.background}"/></a:solidFill>` +
  '<a:effectLst/></p:bgPr></p:bg><p:spTree>' +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  placeholderShapes() +
  '</p:spTree></p:cSld>' +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  TEXT_STYLES +
  '</p:sldMaster>';

const SLIDE_MASTER_RELS =
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
  '</Relationships>';

const SLIDE_LAYOUT =
  `${XML_HEADER}<p:sldLayout ${NS_P} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>` +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  placeholderShapes() +
  '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const SLIDE_LAYOUT_RELS =
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
  '</Relationships>';

const NOTES_MASTER =
  `${XML_HEADER}<p:notesMaster ${NS_P}><p:cSld><p:spTree>` +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>' +
  '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="1143000" y="685800"/><a:ext cx="4572000" cy="2571750"/></a:xfrm></p:spPr></p:sp>' +
  '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
  '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="685800" y="3429000"/><a:ext cx="5486400" cy="4114800"/></a:xfrm></p:spPr>' +
  `<p:txBody><a:bodyPr/><a:lstStyle/>${emptyPara()}</p:txBody></p:sp>` +
  '</p:spTree></p:cSld>' +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:notesStyle><a:lvl1pPr><a:defRPr sz="1200"/></a:lvl1pPr></p:notesStyle>' +
  '</p:notesMaster>';

/**
 * The notes master's own theme.
 *
 * Not theme1.xml. A theme part may be the target of exactly one master's theme
 * relationship: point both the slide master and the notes master at the same theme
 * and PowerPoint rejects the whole package as corrupt, with no indication of which
 * part it objected to. Office writes theme1 for the slide master and theme2 for the
 * notes master, and so does this.
 */
const NOTES_MASTER_RELS =
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme2.xml"/>' +
  '</Relationships>';

/** A complete minimal theme. PowerPoint will not open a deck without one. */
function themeXml(name: string): string {
  const accents = [CVC.colour.accent, CVC.colour.ink, CVC.colour.muted, '6E8F5E', 'A8763E', 'C2A25B'];
  const accentXml = accents
    .map((hex, i) => `<a:accent${i + 1}><a:srgbClr val="${hex}"/></a:accent${i + 1}>`)
    .join('');
  const fontScheme = (tag: 'major' | 'minor') =>
    `<a:${tag}Font><a:latin typeface="${tag === 'major' ? CVC.font.heading : CVC.font.body}"/>` +
    `<a:ea typeface=""/><a:cs typeface=""/></a:${tag}Font>`;

  return (
    `${XML_HEADER}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${esc(name)}">` +
    '<a:themeElements>' +
    '<a:clrScheme name="CVC"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    `<a:dk2><a:srgbClr val="${CVC.colour.ink}"/></a:dk2><a:lt2><a:srgbClr val="${CVC.colour.background}"/></a:lt2>` +
    accentXml +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
    `<a:fontScheme name="CVC">${fontScheme('major')}${fontScheme('minor')}</a:fontScheme>` +
    '<a:fmtScheme name="CVC">' +
    '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
    '<a:lnStyleLst>' +
    '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '</a:lnStyleLst>' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
    '</a:fmtScheme></a:themeElements></a:theme>'
  );
}

function coreProps(title: string, isoDate: string): string {
  return (
    `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title><dc:creator>CVC-MCP</dc:creator><cp:lastModifiedBy>CVC-MCP</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${isoDate}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${isoDate}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

/**
 * Extended properties.
 *
 * The elements are a schema *sequence*, not a set: PresentationFormat precedes
 * Slides, which precedes Application. Office rejects the package outright if they
 * appear in any other order, which is not obvious from reading a sample file.
 */
function appProps(slideCount: number): string {
  return (
    `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<PresentationFormat>Widescreen</PresentationFormat>' +
    `<Slides>${slideCount}</Slides>` +
    '<Paragraphs>0</Paragraphs>' +
    '<Words>0</Words>' +
    '<Application>Microsoft Office PowerPoint</Application>' +
    '<AppVersion>16.0000</AppVersion>' +
    '</Properties>'
  );
}

/**
 * Adds one part.
 *
 * `createFolders: false` matters: by default JSZip inserts a zero-length directory
 * entry for every path segment, and an OPC package may contain nothing but parts and
 * the content-types stream. It is a `file()` option, not a `generateAsync()` one,
 * which is easy to get wrong and invisible until PowerPoint refuses the result.
 */
function part(zip: JSZip, name: string, contents: string | Uint8Array): void {
  zip.file(name, contents, { createFolders: false });
}

/** Builds the .pptx package. Returns the bytes; the caller decides where they go. */
export async function renderPptx(deck: PptxDeckInput): Promise<Uint8Array> {
  if (deck.slides.length === 0) throw new Error('A deck needs at least one slide.');

  const zip = new JSZip();
  const count = deck.slides.length;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  part(zip, '[Content_Types].xml', contentTypes(count));
  part(zip, '_rels/.rels', ROOT_RELS);
  part(zip, 'docProps/core.xml', coreProps(deck.title, now));
  part(zip, 'docProps/app.xml', appProps(count));
  part(zip, 'ppt/presentation.xml', presentation(count));
  part(zip, 'ppt/_rels/presentation.xml.rels', presentationRels(count));
  part(zip, 'ppt/slideMasters/slideMaster1.xml', SLIDE_MASTER);
  part(zip, 'ppt/slideMasters/_rels/slideMaster1.xml.rels', SLIDE_MASTER_RELS);
  part(zip, 'ppt/slideLayouts/slideLayout1.xml', SLIDE_LAYOUT);
  part(zip, 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', SLIDE_LAYOUT_RELS);
  part(zip, 'ppt/notesMasters/notesMaster1.xml', NOTES_MASTER);
  part(zip, 'ppt/notesMasters/_rels/notesMaster1.xml.rels', NOTES_MASTER_RELS);
  part(zip, 'ppt/theme/theme1.xml', themeXml('CVC'));
  part(zip, 'ppt/theme/theme2.xml', themeXml('CVC Notes'));

  deck.slides.forEach((slide, i) => {
    const number = i + 1;
    part(zip, `ppt/slides/slide${number}.xml`, slideXml(slide, number === 1));
    part(zip, `ppt/slides/_rels/slide${number}.xml.rels`, slideRels(number));
    part(zip, `ppt/notesSlides/notesSlide${number}.xml`, notesSlideXml(slide.notes ?? '', number));
    part(zip, `ppt/notesSlides/_rels/notesSlide${number}.xml.rels`, notesSlideRels(number));
  });

  // No directory entries: OPC requires every item in the package to be a part or
  // the content-types stream, and a zero-length folder entry is neither. Office
  // rejects such a package outright as corrupt.
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

  // The final integrity check, on the bytes rather than on the intention. A package
  // that fails it is never written: PowerPoint's only complaint about an invalid one
  // is that it is "corrupted and unreadable", which tells a user nothing.
  const findings = await validatePptxPackage(bytes);
  const errors = findings.filter((f) => f.severity === 'error');
  if (errors.length > 0) throw new PptxPackageError(errors);

  return bytes;
}
