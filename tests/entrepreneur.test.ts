/**
 * The Entrepreneur storyboard track, end to end.
 *
 * Four subjects reach the same document by the same three answers, and each one
 * has to come out of the Entrepreneur template with its formatting intact. The
 * cheap half of that -- the flow, the registry, the crosswalks -- is asserted for
 * all four; the expensive half, a full build and render, runs once, because it
 * takes several seconds and the loop it exercises is shared.
 *
 * The template check is the reason this file exists separately from the flow
 * tests. "Same format, pixel for pixel" is not a thing a reader can verify by
 * eye across a 60-page document, but it is exactly what byte-comparing the parts
 * that carry formatting proves: styles, theme, numbering, header, footer and the
 * section properties all arrive from the template unmodified, so fonts, colours,
 * sizes and page geometry cannot have drifted.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import JSZip from 'jszip';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runTool } from '../src/mcp/tools/index.js';
import { buildStoryboard, moduleSubmission } from './helpers/build-storyboard.js';
import { ensureAllCoursesRegistered } from '../src/courses/course-manager.js';
import { getCourseConfig, listCoursesInTrack } from '../src/courses/course-config.js';
import { templateFile } from '../src/util/config.js';

const SUBJECTS = ['solar-pv', 'biofuels', 'green-hydrogen', 'agri-residue-aggregator'] as const;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await runTool(name, args);
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  return { ...JSON.parse(text), __isError: res.isError ?? false };
}

beforeAll(() => ensureAllCoursesRegistered());

describe('Entrepreneur track', () => {
  it('registers exactly the four subjects, each with a reviewed crosswalk', () => {
    const courses = listCoursesInTrack('entrepreneur');
    expect(courses.map((c) => c.course_id)).toEqual([...SUBJECTS]);

    for (const course of courses) {
      // A storyboard cannot be built without these, and guessing either produces
      // citations that look valid while pointing at the wrong chapter.
      expect(course.crosswalk.length, `${course.course_id} crosswalk`).toBeGreaterThan(0);
      expect(
        Object.keys(course.chapter_titles).length,
        `${course.course_id} chapter titles`,
      ).toBeGreaterThan(0);
      expect(course.directory).toBe(
        `entrepreneur/${course.course_id === 'solar-pv' ? 'solar' : course.course_id}`,
      );

      // Every module maps to a chapter the course also names, so no module can be
      // scoped to a chapter that does not exist.
      for (const entry of course.crosswalk) {
        expect(
          course.chapter_titles[entry.source_chapter],
          `${course.course_id} module ${entry.timing_module} -> chapter ${entry.source_chapter}`,
        ).toBeTruthy();
      }
    }
  });

  it('reaches generation in three answers for every subject', async () => {
    for (const subject of SUBJECTS) {
      const start = await call('start_flow');
      const session = start.session_id;
      await call('flow_choose', { session_id: session, choice: '1' });
      await call('flow_choose', { session_id: session, choice: '1' });
      const done = await call('flow_choose', { session_id: session, choice: subject });

      expect(done.step, subject).toBe('storyboard_ready');
      expect(done.done, subject).toBe(true);
      expect(done.data.course_id, subject).toBe(subject);
      expect(done.data.track, subject).toBe('entrepreneur');
      // The subject is the last question: nothing further may be asked.
      expect(done.options, subject).toBeUndefined();
    }
  }, 300_000);

  it('renders every subject to the Entrepreneur template, not another track\'s', () => {
    for (const subject of SUBJECTS) {
      expect(getCourseConfig(subject).track).toBe('entrepreneur');
    }
    // Each track has its own document, and they are not interchangeable.
    expect(templateFile('entrepreneur')).not.toBe(templateFile('orientation'));
  });

  it('gives every Part A row source material about its own unit', async () => {
    // A row is written about one unit, so a work order that carries the chapter's
    // opening pages and nothing about unit 1.7 leaves that row ungroundable. The
    // per-unit budget exists for this, and a chapter long enough to be truncated
    // is exactly where it used to fail.
    for (const subject of ['green-hydrogen', 'solar-pv']) {
      await call('ingest_course_documents', { course_id: subject });
      const draft = await call('create_storyboard_draft', { course_id: subject });
      const work = await call('storyboard_next_module', { artifact_id: draft.artifact_id });

      const covered = new Set(
        work.module.sources.map((s: any) => s.unit_code).filter(Boolean),
      );
      for (const row of work.module.part_a) {
        expect(
          covered.has(row.unit_code),
          `${subject} module ${work.module.number}: no source for unit ${row.unit_code}`,
        ).toBe(true);
      }

      // And it stays bounded: source volume follows the unit count, not the
      // chapter length, so a 145-chunk chapter does not blow up one reply.
      expect(work.module.sources.length).toBeLessThan(90);
    }
  }, 300_000);

  it('gives Part A the module less the half hour Parts B and C spend', async () => {
    // The template states three-hour modules and heads their Part A "(2.5 hours)",
    // so Parts B and C are spent out of the module's own time. The parts must sum
    // to exactly the module's authoritative duration and no more.
    const draft = await call('create_storyboard_draft', { course_id: 'green-hydrogen' });
    const state = await call('get_storyboard', { artifact_id: draft.artifact_id });

    for (const module of state.modules) {
      if (module.part_a?.rows === undefined) continue;
      const partA = module.part_a.rows.reduce((a: number, r: any) => a + r.duration.minutes, 0);
      const partB = module.part_b.duration_minutes;
      const partC = module.part_c.duration_minutes;
      expect(partB, `module ${module.number} Part B`).toBe(15);
      expect(partC, `module ${module.number} Part C`).toBe(15);
      expect(partA + partB + partC, `module ${module.number} parts vs total`).toBe(
        module.duration.minutes,
      );
    }
  }, 120_000);

  it("fills the LMS Activity Type from the same module's Part A activity", async () => {
    // Both tables describe the same activity, so the LMS row's type is a copy of
    // that unit's Part A activity_name. It is derived from the state as just
    // written, not from the work order -- the work order was computed while Part A
    // was still blank, which left the column empty in every module.
    const draft = await call('create_storyboard_draft', { course_id: 'green-hydrogen' });
    const work = await call('storyboard_next_module', { artifact_id: draft.artifact_id });
    const res = await call('storyboard_submit_module', moduleSubmission(draft.artifact_id, work.module));
    expect(res.__isError, res.message).toBe(false);

    const state = await call('get_storyboard', {
      artifact_id: draft.artifact_id,
      module_number: work.module.number,
    });
    const activityByUnit = new Map(
      state.module.part_a.rows.map((r: any) => [r.unit_code, r.activity_name]),
    );
    expect(state.module.lms_mapping.rows.length).toBeGreaterThan(0);
    for (const row of state.module.lms_mapping.rows) {
      expect(row.activity_type, `LMS row ${row.unit_range}`).not.toBe('');
      expect(row.activity_type).toBe(activityByUnit.get(row.unit_range));
    }
  }, 120_000);

  it('closes the document with one alphabetical glossary, and lists it', async () => {
    const built = await buildStoryboard(call, 'agri-residue-aggregator');
    const rendered = await call('render_storyboard_docx', {
      artifact_id: built.artifactId,
      allow_invalid: true,
    });
    expect(rendered.__isError, rendered.message).toBe(false);

    const out = await JSZip.loadAsync(readFileSync(rendered.docx_path));
    const xml = await out.file('word/document.xml')!.async('string');
    const paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => ({
      style: (m[0].match(/<w:pStyle w:val="([^"]+)"/) ?? [])[1] ?? '',
      text: [...m[0].matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)]
        .map((t) => t[1])
        .join('')
        .replace(/&amp;/g, '&')
        .trim(),
    }));

    const heading = paras.findIndex(
      (p) => p.style === 'Heading1' && /^Glossary of Terms and Abbreviations$/.test(p.text),
    );
    expect(heading, 'no glossary heading').toBeGreaterThan(0);

    // It closes the document: nothing but the glossary follows its heading.
    const after = paras.slice(heading + 1).filter((p) => p.text !== '');
    expect(after.length).toBeGreaterThan(3);
    expect(after.some((p) => /^Module \d+:/.test(p.text))).toBe(false);

    // One list, alphabetical, with no term repeated across modules.
    const terms = after.filter((p) => p.style === 'ListBullet2').map((p) => p.text.split(':')[0]!);
    expect(terms.length).toBeGreaterThan(3);
    expect(terms).toEqual([...terms].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
    expect(new Set(terms.map((t) => t.toLowerCase())).size).toBe(terms.length);
  }, 300_000);

  it('leaves one folder per subject holding one finished document', async () => {
    // Rebuilding a subject must not accumulate. The folder used to be named for
    // the artifact and the file for the version, so every draft made a new
    // directory and every render added a file -- a subject built a few times left
    // a dozen folders and no way to tell which document was the real one.
    const first = await call('render_storyboard_docx', {
      artifact_id: (await buildStoryboard(call, 'agri-residue-aggregator')).artifactId,
      allow_invalid: true,
    });
    const second = await call('render_storyboard_docx', {
      artifact_id: (await buildStoryboard(call, 'agri-residue-aggregator')).artifactId,
      allow_invalid: true,
    });

    // Two separate builds, one path.
    expect(second.docx_path).toBe(first.docx_path);
    expect(path.basename(second.docx_path)).toBe('agri-residue-aggregator-storyboard.docx');

    const dir = path.dirname(second.docx_path);
    expect(path.basename(dir)).toBe('agri-residue-aggregator');
    expect(readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.docx'))).toEqual([
      'agri-residue-aggregator-storyboard.docx',
    ]);
  }, 300_000);

  it('builds and renders a storyboard with the template formatting untouched', async () => {
    const subject = 'green-hydrogen';
    expect((await call('ingest_course_documents', { course_id: subject })).__isError).toBe(false);

    const built = await buildStoryboard(call, subject);
    // One call per module: six modules, six submissions, plus the first ask.
    expect(built.calls).toBe(built.modules + 1);
    expect(built.final.status).toBe('READY_TO_RENDER');

    // A course whose crosswalk, chapter titles and timing document agree
    // validates without a single error on the first pass.
    const report = await call('validate_storyboard', { artifact_id: built.artifactId });
    expect(report.summary.errors, JSON.stringify(report.findings?.slice(0, 3))).toBe(0);

    const rendered = await call('render_storyboard_docx', { artifact_id: built.artifactId });
    expect(rendered.__isError, rendered.message).toBe(false);

    const out = await JSZip.loadAsync(readFileSync(rendered.docx_path));
    const template = await JSZip.loadAsync(readFileSync(templateFile('entrepreneur')));

    // Fonts, colours, sizes, list formatting and page furniture all live in these
    // parts. Byte-identical is the whole of "the same format, pixel for pixel".
    for (const part of [
      'word/styles.xml',
      'word/theme/theme1.xml',
      'word/numbering.xml',
      'word/header1.xml',
      'word/footer1.xml',
      'word/fontTable.xml',
      '[Content_Types].xml',
    ]) {
      const a = Buffer.from(await out.file(part)!.async('uint8array'));
      const b = Buffer.from(await template.file(part)!.async('uint8array'));
      expect(Buffer.compare(a, b), `${part} must arrive from the template unmodified`).toBe(0);
    }

    // Page size, orientation and margins.
    const sectPr = (xml: string) => xml.slice(xml.lastIndexOf('<w:sectPr'), xml.lastIndexOf('</w:sectPr>'));
    const outXml = await out.file('word/document.xml')!.async('string');
    expect(sectPr(outXml)).toBe(sectPr(await template.file('word/document.xml')!.async('string')));

    // The template is a populated Solar PV storyboard. None of its content may
    // survive into another subject's document.
    for (const leak of ['Solar Photovoltaic Entrepreneur', 'SGJ/Q0901', 'Rooftop']) {
      expect(outXml.includes(leak), `template content leaked: ${leak}`).toBe(false);
    }

    // The table of contents must describe this document, at the levels this
    // document uses. Both halves of that were wrong before: the Entrepreneur
    // template has no Instructional Design section, and the TOC paragraphs were
    // reused positionally, so a course with a different module count from the
    // template's ten put modules on TOC2 and their parts on TOC1.
    const toc = [...outXml.matchAll(/<w:pStyle w:val="(TOC[12])"\/>[\s\S]*?(?=<w:p[ >]|$)/g)]
      .map((m) => ({
        level: m[1] === 'TOC1' ? 1 : 2,
        // `<w:t` must be followed by a space or the close, or the pattern also
        // swallows the `<w:tab/>` that carries each entry's dot leader.
        text: [...m[0].matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)]
          .map((t) => t[1])
          .join('')
          .replace(/&amp;/g, '&')
          .trim(),
      }))
      .filter((e) => e.text !== '');

    const level1 = toc.filter((e) => e.level === 1).map((e) => e.text);
    expect(level1).toEqual([
      'Table of Contents',
      'Green Hydrogen Plant Entrepreneur: Storyboard & Curriculum Blueprint',
      'Module 1: Introduction to Green Hydrogen',
      'Module 2: Components of Green Hydrogen Plant and its Layout',
      'Module 3: Key Technical and Entrepreneurial Aspects for Supporting Growth and Business ' +
        'Development in Green Hydrogen Production',
      'Module 4: Oversee the Assembly, Storage and O&M of Electrolyzer for Green Hydrogen Production',
      'Module 5: Micro-Entrepreneurship Opportunities in Green Hydrogen',
      'Module 6: Perform Health and Safety Measures for Installing and Operating Green Hydrogen Systems',
      'Advanced Assessment Strategy Blueprint & 60-Question Bank',
      'Glossary of Terms and Abbreviations',
    ]);

    // Nothing from the Orientation template's front matter may appear.
    expect(toc.some((e) => /Instructional Design/i.test(e.text))).toBe(false);

    // The contents must still be a live Word TOC field, not text that looks like
    // one. Rewriting the entries as plain runs removed the field, so there was
    // nothing for w:updateFields to refresh: no page numbers could ever appear,
    // no dot leaders, and what was left rendered as blue underlined link text.
    expect(outXml).toContain('TOC \\o "1-2" \\h \\z \\u');
    expect((outXml.match(/fldCharType="begin"/g) ?? []).length).toBeGreaterThan(toc.length);

    // Every entry carries the three things that make it look like the template's:
    // a hyperlink to a heading bookmark, the dot-leader tab, and a PAGEREF that
    // Word resolves to a page number when the document is opened.
    const anchors = [...outXml.matchAll(/<w:hyperlink w:anchor="(_Toc\d+)"/g)].map((m) => m[1]!);
    expect(anchors.length).toBe(toc.length);
    for (const anchor of anchors) {
      expect(outXml).toMatch(new RegExp(`PAGEREF ${anchor} `));
      expect(outXml).toMatch(new RegExp(`<w:bookmarkStart [^>]*w:name="${anchor}"`));
    }
    // Bookmark names must be unique, or Word treats the file as corrupt.
    const names = [...outXml.matchAll(/<w:bookmarkStart [^>]*w:name="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(names).size).toBe(names.length);

    // The cover ends with a page break, so the contents starts on page two. It
    // lived in the same paragraph as the strapline, and rewriting that paragraph's
    // text used to discard it along with the runs.
    const beforeToc = outXml.slice(0, outXml.indexOf('<w:pStyle w:val="TOC1"/>'));
    expect(beforeToc).toContain('<w:br w:type="page"/>');

    // Part A is the module less the half hour Parts B and C spend, which is the
    // template's own arithmetic: every Part A heading in it reads "(2.5 hours)"
    // under a three-hour module. Handing Part A the whole module made the parts
    // sum to more than the module lasts.
    const partA = toc.filter((e) => e.level === 2 && /^Part A:/.test(e.text)).map((e) => e.text);
    expect(partA).toEqual([
      'Part A: eLMS with Online Faculty Instruction (2.5 hours)',
      'Part A: eLMS with Online Faculty Instruction (5.5 hours)',
      'Part A: eLMS with Online Faculty Instruction (5.5 hours)',
      'Part A: eLMS with Online Faculty Instruction (5.5 hours)',
      'Part A: eLMS with Online Faculty Instruction (5.5 hours)',
      'Part A: eLMS with Online Faculty Instruction (2.5 hours)',
    ]);
    for (const e of toc.filter((x) => x.level === 2 && /^Part [BC]:/.test(x.text))) {
      expect(e.text).toMatch(/\(15 minutes\)$/);
    }
    // Every module's four sub-entries sit under it.
    expect(toc.filter((e) => e.level === 2 && /^Part A:/.test(e.text))).toHaveLength(6);
    expect(toc.filter((e) => e.level === 2 && /^LMS Technical Mapping/.test(e.text))).toHaveLength(6);
  }, 300_000);
});
