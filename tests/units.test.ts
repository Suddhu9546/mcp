/**
 * Unit tests for the deterministic pieces, exercised without touching the
 * database or the filesystem index.
 */

import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseTimingText } from '../src/timing/timing-parser.js';
import { validateTimingArithmetic } from '../src/timing/timing-validator.js';
import { chunkDocument } from '../src/documents/chunker.js';
import { toMatchExpression } from '../src/documents/retriever.js';
import { groundingOverlap } from '../src/storyboard/validator.js';
import { setParagraphText, parseXml, textOf, W, descendants } from '../src/docx/ooxml.js';
import { courseDir, getCourseConfig } from '../src/courses/course-config.js';
import { parseTimingDocument } from '../src/timing/timing-parser.js';
import { withValidatedArithmetic } from '../src/timing/timing-validator.js';
import type { OffsetMappedText } from '../src/documents/pdf-extractor.js';

function mapped(text: string): OffsetMappedText {
  return { text, spans: [{ start: 0, end: text.length + 1, pdf_page: 1, printed_page: 1 }] };
}

describe('timing parser', () => {
  const doc = `Bio-Fuels
Qualification Pack: SGJ/Q4102 | NSQF Level: 4 | Total Duration: 4 Hours (240 Mins)
Module 1: Intro to Things (1.0 Hours)
UNIT 1.1 First Unit (0.5 Hours / 30 Mins) 1.1.1 Alpha topic 1.1.2 Beta topic
UNIT 1.2 Second Unit (0.5 Hours / 30 Mins) 1.2.1 Gamma topic
Module 2: Advanced Things (Elective 1) (3.0 Hours)
UNIT 2.1 Third Unit (1.5 Hours / 90 Mins) 2.1.1 Delta topic
UNIT 2.2 Fourth Unit (1.5 Hours / 90 Mins) 2.2.1 Epsilon topic`;

  it('reads the header, modules, units and sub-topics', () => {
    const a = parseTimingText('test', mapped(doc));
    expect(a.qp_code).toBe('SGJ/Q4102');
    expect(a.stated_total_minutes).toBe(240);
    expect(a.modules).toHaveLength(2);
    expect(a.modules[0]!.units).toHaveLength(2);
    expect(a.modules[0]!.units[0]!.minutes).toBe(30);
    expect(a.modules[0]!.units[0]!.sub_topics.map((s) => s.code)).toEqual(['1.1.1', '1.1.2']);
  });

  it('parses a title containing parentheses and extracts the elective number', () => {
    // Regression: an earlier title pattern excluded parentheses, so
    // "(Elective 1)" and "HSE (Health, Safety & Environment)" silently failed to
    // match and their units were absorbed into the preceding module.
    const a = parseTimingText('test', mapped(doc));
    expect(a.modules[1]!.title).toBe('Advanced Things');
    expect(a.modules[1]!.elective).toBe(1);
    expect(a.modules[1]!.units).toHaveLength(2);
  });

  it('validates arithmetic and reports a mismatch without repairing it', () => {
    const good = validateTimingArithmetic(parseTimingText('test', mapped(doc)));
    expect(good.course_total_ok).toBe(true);
    expect(good.all_modules_ok).toBe(true);

    const broken = doc.replace('UNIT 1.2 Second Unit (0.5 Hours / 30 Mins)', 'UNIT 1.2 Second Unit (0.5 Hours / 45 Mins)');
    const report = validateTimingArithmetic(parseTimingText('test', mapped(broken)));
    expect(report.all_modules_ok).toBe(false);
    expect(report.discrepancies.length).toBeGreaterThan(0);
    expect(report.discrepancies[0]!.message).toMatch(/units sum to/);
  });

  it('refuses a document with no parseable header', () => {
    expect(() => parseTimingText('test', mapped('Module 1: Thing (1.0 Hours)'))).toThrow(/no parseable header/);
  });

  it('refuses a module with no units rather than distributing its duration', () => {
    const noUnits = `Qualification Pack: X | NSQF Level: 4 | Total Duration: 1 Hours (60 Mins)
Module 1: Empty Module (1.0 Hours)`;
    expect(() => parseTimingText('test', mapped(noUnits))).toThrow(/no parseable units/);
  });
});

describe('chunker chapter attribution', () => {
  const chapterTitles = { 5: 'Health & Safety in Bioenergy Manufacturing facility', 7: 'Ensure Manufacturing of Biomass pellet' };

  const page = (pdf_page: number, text: string) => ({ pdf_page, text });

  it('takes the chapter from a unit code, which is the reliable signal', () => {
    const chunks = chunkDocument({
      courseId: 'c',
      documentType: 'PH',
      chapterTitles,
      pages: [
        page(1, 'UNIT 7.2: Operations with Machinery\n' + 'Pellet mill operation requires die selection and moisture control below fifteen percent for stable extrusion.'),
      ],
    });
    expect(chunks[0]!.chapter).toBe(7);
    expect(chunks[0]!.unit_code).toBe('7.2');
  });

  it('ignores numbered lines that are not real chapter openers', () => {
    // Regression: "7. Annexures" and "7. Packaging Machine" (a figure caption on a
    // chapter-2 page) both matched a bare numbered-heading pattern and reassigned
    // every following chunk to chapter 7.
    const chunks = chunkDocument({
      courseId: 'c',
      documentType: 'PH',
      chapterTitles,
      pages: [
        page(1, 'UNIT 5.1: Workplace Safety\nSafe work areas require marked exits, ventilation and designated fire safety zones at all times.'),
        page(2, '7. Packaging Machine\nThe packaging machine seals filled bags before they are moved to the storage area for dispatch.'),
        page(3, '7. Annexures\nAdditional reference material is provided in the annexure section of this handbook for learners.'),
      ],
    });
    for (const chunk of chunks) {
      expect(chunk.chapter, `chunk on page ${chunk.pdf_page}`).toBe(5);
    }
  });

  it('accepts a genuine chapter opener that matches the declared title', () => {
    const chunks = chunkDocument({
      courseId: 'c',
      documentType: 'PH',
      chapterTitles,
      pages: [
        page(1, '7. Ensure Manufacturing of Biomass pellet\nThis chapter explains how biomass pellets are manufactured from prepared agricultural residues.'),
      ],
    });
    expect(chunks[0]!.chapter).toBe(7);
  });

  it('does not assign chapters to the QP, which is organised by NOS', () => {
    const chunks = chunkDocument({
      courseId: 'c',
      documentType: 'QP',
      chapterTitles,
      pages: [
        page(1, 'SGJ/N4105: Ensure Manufacturing of Biomass pellet\nPC1. prepare the biomass feedstock to the required particle size before pelletisation begins.'),
      ],
    });
    expect(chunks[0]!.chapter).toBeUndefined();
    expect(chunks[0]!.nos_code).toBe('SGJ/N4105');
  });

  it('strips the stray running header from another qualification', () => {
    const chunks = chunkDocument({
      courseId: 'c',
      documentType: 'PH',
      chapterTitles,
      noisePatterns: ['^Plastic Recycling Operator$'],
      pages: [
        page(1, 'Plastic Recycling Operator\nUNIT 7.3: Quality Control\nGross calorific value is measured with a bomb calorimeter and ash content is determined separately.'),
      ],
    });
    expect(chunks.map((c) => c.content).join(' ')).not.toMatch(/Plastic Recycling Operator/);
  });
});

describe('FTS query escaping', () => {
  it('turns punctuation-heavy queries into a valid MATCH expression', () => {
    // "CTE / CTO (Consent to Establish)" is a syntax error if passed through raw.
    expect(toMatchExpression('CTE / CTO (Consent to Establish)')).toBe(
      '"cte" OR "cto" OR "consent" OR "to" OR "establish"',
    );
  });

  it('rejects a query with no searchable terms', () => {
    expect(() => toMatchExpression('   ?  ')).toThrow(/no searchable terms/);
  });
});

describe('grounding overlap', () => {
  it('scores content drawn from the source highly', () => {
    const source = 'Pellets must be crushed below five millimetres with moisture content between ten and fifteen percent.';
    const content = 'Crushed below five millimetres, moisture between ten and fifteen percent.';
    expect(groundingOverlap(content, source)).toBeGreaterThan(0.7);
  });

  it('scores unrelated content near zero', () => {
    const source = 'Pellets must be crushed below five millimetres before pelletisation.';
    const content = 'Photovoltaic modules convert sunlight using crystalline silicon junctions.';
    expect(groundingOverlap(content, source)).toBeLessThan(0.2);
  });
});

describe('paragraph text replacement', () => {
  it('preserves the paragraph style and the first run properties', () => {
    const xml = `<w:p xmlns:w="${W}">
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>Old text</w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t> extra</w:t></w:r>
    </w:p>`;
    const p = parseXml(xml).documentElement!;
    setParagraphText(p, 'New text');

    expect(textOf(p)).toBe('New text');
    // Style and the first run's bold/colour survive; the second run is dropped so
    // its italics cannot leak into the replacement.
    expect(descendants(p, 'pStyle')[0]!.getAttribute('w:val')).toBe('Heading1');
    expect(descendants(p, 'b')).toHaveLength(1);
    expect(descendants(p, 'color')).toHaveLength(1);
    expect(descendants(p, 'i')).toHaveLength(0);
    expect(descendants(p, 'r')).toHaveLength(1);
  });

  it('renders multi-line text as breaks inside one paragraph', () => {
    const p = parseXml(`<w:p xmlns:w="${W}"><w:r><w:t>x</w:t></w:r></w:p>`).documentElement!;
    setParagraphText(p, 'line one\nline two');
    expect(descendants(p, 'br')).toHaveLength(1);
    expect(textOf(p)).toBe('line oneline two');
  });
});

describe('course directory resolution', () => {
  const asPosix = (p: string) => p.split(path.sep).join('/');

  it('finds documents delivered in a folder named differently from the course_id', () => {
    // Solar's PDFs arrived in courses/solar, but the course is registered as
    // solar-pv. Without the alias the course reports "no documents supplied"
    // while the files sit next to it.
    expect(getCourseConfig('solar-pv').directory_aliases).toContain('solar');
    expect(asPosix(courseDir('solar-pv')).endsWith('/courses/solar')).toBe(true);
  });

  it('uses the course_id directory when it exists', () => {
    expect(asPosix(courseDir('biofuels')).endsWith('/courses/biofuels')).toBe(true);
  });

  it('names the canonical location when nothing is on disk', () => {
    // The "supply the documents here" message must not point at an alias.
    expect(asPosix(courseDir('green-hydrogen')).endsWith('/courses/green-hydrogen')).toBe(true);
  });
});

describe('Solar Photovoltaic timing allocation', () => {
  it('reads as a whole document: 10 modules of 3 hours, 30 hours in total', async () => {
    const file = `${courseDir('solar-pv')}/timing.pdf`;
    const timing = withValidatedArithmetic(await parseTimingDocument('solar-pv', file));

    expect(timing.qp_code).toBe('SGJ/Q0901');
    expect(timing.nsqf_level).toBe('4');
    expect(timing.stated_total_minutes).toBe(1800);
    expect(timing.modules).toHaveLength(10);

    // Every module is three hours, and its units account for all of it. The
    // generator distributes minutes; this is the check that it distributed them
    // into a document that reads back exactly.
    for (const module of timing.modules) {
      expect(module.minutes).toBe(180);
      expect(module.units.reduce((a, u) => a + u.minutes, 0)).toBe(180);
      expect(module.units.length).toBeGreaterThan(0);
    }

    expect(timing.arithmetic.course_total_ok).toBe(true);
    expect(timing.arithmetic.all_modules_ok).toBe(true);
    expect(timing.arithmetic.discrepancies).toEqual([]);
  }, 60_000);

  it('numbers units sequentially within each module', async () => {
    // The handbook prints Module 5's units as 5.1, 4.2, 5.3, 5.4, 5.2. A timing
    // document reproducing that could not be parsed, so position is authoritative.
    const timing = await parseTimingDocument('solar-pv', `${courseDir('solar-pv')}/timing.pdf`);
    for (const module of timing.modules) {
      expect(module.units.map((u) => u.code)).toEqual(
        module.units.map((_, i) => `${module.number}.${i + 1}`),
      );
    }
    expect(timing.modules.flatMap((m) => m.units)).toHaveLength(39);
  }, 60_000);
});
