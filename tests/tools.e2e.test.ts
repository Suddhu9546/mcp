/**
 * End-to-end exercise of the tool surface, with no AI anywhere in the loop.
 *
 * This test acts as the client would: discover the course, ingest, read the
 * crosswalk and timing, create a draft, retrieve scoped source material, write
 * content citing real chunk_ids, validate, and render. It asserts the invariants
 * the spec calls non-negotiable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A dedicated database per run, so tests never disturb the working index.
process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'sbmcp-')), 'test.db');
process.env.ARTIFACT_DIR = mkdtempSync(path.join(tmpdir(), 'sbmcp-art-'));

const { TOOLS, runTool } = await import('../src/mcp/tools/index.js');

/** Calls a tool exactly as the MCP server does, including error conversion. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await runTool(name, args);
  const text = result.content[0]?.text ?? '{}';
  return { ...JSON.parse(text), __isError: result.isError ?? false };
}

const COURSE = 'biofuels';

describe('tool surface', () => {
  beforeAll(async () => {
    const ingested = await call('ingest_course_documents', { course_id: COURSE, force: true });
    expect(ingested.total_chunks).toBeGreaterThan(500);
  }, 180_000);

  it('exposes no AI-related tool and requires no API key', () => {
    const names = TOOLS.map((t) => t.name).join(' ');
    expect(names).not.toMatch(/gemini|llm|generate_content|embed|complete/i);
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
  });

  it('lists the course with all four approved documents indexed', async () => {
    const res = await call('list_courses');
    const course = res.courses.find((c: any) => c.course_id === COURSE);
    expect(course.qp_code).toBe('SGJ/Q4102');
    expect(course.module_count).toBe(8);
    for (const doc of course.documents) {
      expect(doc.present, `${doc.document_type} present`).toBe(true);
      expect(doc.indexed, `${doc.document_type} indexed`).toBe(true);
    }
  });

  it('reports the crosswalk that reconciles disagreeing module numbering', async () => {
    const res = await call('get_module_crosswalk', { course_id: COURSE });
    const byModule = new Map<number, any>(res.crosswalk.map((c: any) => [c.timing_module, c]));
    // The three modules the timing document renumbers relative to the handbook.
    expect(byModule.get(5)!.source_chapter).toBe(7);
    expect(byModule.get(6)!.source_chapter).toBe(8);
    expect(byModule.get(7)!.source_chapter).toBe(5);
    expect(byModule.get(5)!.nos_code).toBe('SGJ/N4105');
    // Module 8 has no source content and must say so.
    expect(byModule.get(8)!.no_source_content).toBeTruthy();
  });

  it('timing arithmetic closes exactly against the timing document', async () => {
    const res = await call('validate_timing_allocation', { course_id: COURSE });
    expect(res.course_total_ok).toBe(true);
    expect(res.all_modules_ok).toBe(true);
    expect(res.computed_total_minutes).toBe(1800);
    expect(res.module_count).toBe(8);
    expect(res.unit_count).toBe(33);
    expect(res.discrepancies).toHaveLength(0);
  });

  it('scopes retrieval to the mapped chapter, never another course or chapter', async () => {
    const res = await call('search_course_content', {
      course_id: COURSE,
      query: 'pellet die moisture extrusion',
      module_number: 5,
      document_types: ['PH'],
      limit: 6,
    });
    expect(res.scope.resolved_chapter).toBe(7);
    expect(res.results.length).toBeGreaterThan(0);
    for (const hit of res.results) {
      expect(hit.course_id).toBe(COURSE);
      expect(hit.document_type).toBe('PH');
      expect(hit.chapter).toBe(7);
    }
  });

  it('scopes QP retrieval by NOS code rather than chapter', async () => {
    const res = await call('search_course_content', {
      course_id: COURSE,
      query: 'biogas plant installation operation',
      module_number: 6,
      document_types: ['QP'],
      limit: 5,
    });
    expect(res.scope.resolved_nos_code).toBe('SGJ/N4106');
    for (const hit of res.results) expect(hit.nos_code).toBe('SGJ/N4106');
  });

  it('refuses to search an unregistered course', async () => {
    // "solar-pv" used to serve as the unregistered example; it is now a
    // registered course awaiting its documents, so this needs an id that is
    // genuinely absent from the registry.
    const res = await call('search_course_content', { course_id: 'wind-power', query: 'anything' });
    expect(res.__isError).toBe(true);
    expect(res.message).toMatch(/Unknown course_id/);
  });

  it('derives the template structure from the real file', async () => {
    const res = await call('analyze_storyboard_template');
    expect(res.modules).toHaveLength(10); // the Solar reference has ten
    expect(res.modules[0].part_a.table.header_cells).toEqual([
      'Topic / Unit',
      'Time',
      'Interactive Learning Descriptions',
      'Correlation (PC/Units from QP, PH, FG)',
    ]);
    expect(res.modules[0].part_c.slide_count).toBe(7);
    expect(res.assessment.question_count).toBe(100);
  });

  describe('storyboard lifecycle', () => {
    let artifactId: string;

    it('creates a draft carrying authoritative durations', async () => {
      const res = await call('create_storyboard_draft', { course_id: COURSE, note: 'e2e test' });
      expect(res.__isError).toBe(false);
      artifactId = res.artifact_id;
      expect(res.version).toBe(1);
      expect(res.module_count).toBe(8);

      const m5 = res.modules.find((m: any) => m.number === 5);
      expect(m5.source_chapter).toBe(7);
      expect(m5.duration_minutes).toBe(180);
      expect(m5.part_a_rows).toBe(4);

      const m2 = res.modules.find((m: any) => m.number === 2);
      expect(m2.duration_minutes).toBe(360); // the 6-hour module

      const m8 = res.modules.find((m: any) => m.number === 8);
      expect(m8.insufficient_source).toBe(true);
    }, 60_000);

    it('reports the draft as unfinished work rather than as a result', async () => {
      // A client that reads "call validate_storyboard, then render" after creating an
      // empty skeleton stops and reports the draft, which is what this prevents.
      const draft = await call('create_storyboard_draft', { course_id: COURSE });
      expect(draft.work.complete).toBe(false);
      expect(draft.work.empty_fields_remaining).toBeGreaterThan(100);
      // Module 8 has no source content, so it is not work anyone can do.
      expect(draft.work.modules_remaining).toBe(7);
      expect(draft.work.next_module).toBe(1);
      // The draft must point into the build loop, not read as a finished result.
      expect(draft.next_call.tool).toBe('storyboard_next_task');
      expect(draft.next_call.args.artifact_id).toBe(draft.artifact_id);
      expect(draft.next_step).toMatch(/empty skeleton/);
      expect(draft.next_step).not.toMatch(/^Call validate_storyboard/);

      const search = await call('search_course_content', {
        course_id: COURSE,
        query: 'biomass energy fundamentals',
        module_number: 1,
        limit: 1,
      });
      const written = await call('set_storyboard_content', {
        artifact_id: draft.artifact_id,
        base_version: draft.version,
        module_number: 1,
        part_a_rows: [
          {
            row_id: 'm01-a-1.1',
            activity_name: 'Guided reading',
            interactive_description: 'Learners work through the fundamentals of biomass energy.',
            sources: [{ chunk_id: search.results[0].chunk_id }],
          },
        ],
      });

      // One module filled is not the whole storyboard, and the tool must say so.
      expect(written.work.complete).toBe(false);
      expect(written.work.empty_fields_remaining).toBe(draft.work.empty_fields_remaining - 2);
      expect(written.next_step).toMatch(/NOT FINISHED/);
      expect(written.next_step).toMatch(/Continue now with module 1/);
    }, 120_000);

    it('writes content with real citations and versions the change', async () => {
      const search = await call('search_course_content', {
        course_id: COURSE,
        query: 'biomass preparation crushing moisture die',
        module_number: 5,
        document_types: ['PH'],
        limit: 3,
      });
      const chunk = search.results[0];
      expect(chunk).toBeTruthy();

      const before = await call('get_storyboard', { artifact_id: artifactId, module_number: 5 });
      const rowId = before.module.part_a.rows[0].row_id;

      const res = await call('set_storyboard_content', {
        artifact_id: artifactId,
        base_version: 1,
        module_number: 5,
        module_description: 'This module covers the manufacture of biomass pellets.',
        part_a_rows: [
          {
            row_id: rowId,
            activity_name: 'Pellet Preparation Sequencer',
            interactive_description:
              'Learners order the biomass preparation steps and set crushing size and moisture content.',
            correlation: 'SGJ/N4105 / PC1, PC2',
            sources: [
              {
                document_type: chunk.document_type,
                pdf_page: chunk.pdf_page,
                section: chunk.section,
                chunk_id: chunk.chunk_id,
              },
            ],
          },
        ],
        note: 'Module 5 unit 1 content',
      });

      expect(res.__isError).toBe(false);
      expect(res.version).toBe(2);
      expect(res.changes_applied).toBeGreaterThan(0);
    });

    it('rejects a stale base_version instead of overwriting', async () => {
      const res = await call('set_storyboard_content', {
        artifact_id: artifactId,
        base_version: 1, // now stale
        module_number: 5,
        module_description: 'Should not apply.',
      });
      expect(res.__isError).toBe(true);
      expect(res.message).toMatch(/Version conflict/);
    });

    it('rejects an unknown row_id without committing anything', async () => {
      const artifactBefore = await call('get_storyboard', { artifact_id: artifactId });
      const res = await call('set_storyboard_content', {
        artifact_id: artifactId,
        base_version: artifactBefore.version,
        module_number: 5,
        part_a_rows: [{ row_id: 'does-not-exist', interactive_description: 'x' }],
      });
      expect(res.__isError).toBe(true);
      const after = await call('get_storyboard', { artifact_id: artifactId });
      expect(after.version).toBe(artifactBefore.version);
    });

    it('flags an unresolvable citation and a wrong-chapter citation', async () => {
      const state = await call('get_storyboard', { artifact_id: artifactId });

      // A chunk that genuinely exists but belongs to another module's chapter.
      const wrong = await call('search_course_content', {
        course_id: COURSE,
        query: 'first aid burns electric shock',
        module_number: 7, // chapter 5
        document_types: ['PH'],
        limit: 1,
      });
      const wrongChunk = wrong.results[0];
      expect(wrongChunk.chapter).toBe(5);

      const rows = state.modules.find((m: any) => m.number === 5).part_a.rows;

      await call('set_storyboard_content', {
        artifact_id: artifactId,
        base_version: state.version,
        module_number: 5,
        part_a_rows: [
          {
            row_id: rows[1].row_id,
            activity_name: 'Bad Citation Probe',
            interactive_description: 'Content citing a chunk from the wrong chapter.',
            sources: [
              {
                document_type: wrongChunk.document_type,
                pdf_page: wrongChunk.pdf_page,
                section: wrongChunk.section,
                chunk_id: wrongChunk.chunk_id,
              },
            ],
          },
          {
            row_id: rows[2].row_id,
            activity_name: 'Missing Chunk Probe',
            interactive_description: 'Content citing a chunk that does not exist.',
            sources: [
              {
                document_type: 'PH',
                pdf_page: 1,
                section: 'fabricated',
                chunk_id: 'biofuels:PH:p999:9999',
              },
            ],
          },
        ],
      });

      const report = await call('validate_storyboard', { artifact_id: artifactId });
      const codes = report.levels.content.findings.map((f: any) => f.code);
      expect(codes).toContain('wrong_chapter_citation');
      expect(codes).toContain('unresolvable_citation');
      expect(report.passed).toBe(false);
    });

    it('reports module 8 as insufficient source rather than inventing content', async () => {
      const report = await call('validate_storyboard', { artifact_id: artifactId, skip_content: true });
      expect(report.insufficient_source_modules).toContain(8);
    });

    it('refuses to change a duration that conflicts with the timing document', async () => {
      const state = await call('get_storyboard', { artifact_id: artifactId });
      const res = await call('modify_storyboard_timing', {
        artifact_id: artifactId,
        base_version: state.version,
        module_number: 5,
        requested_minutes: 240, // the document says 180
      });
      expect(res.__isError).toBe(true);
      expect(res.message).toMatch(/conflicts with the Timing Allocation Document/);
      expect(res.detail.authoritative).toBe(180);
    });

    it('refuses to render while validation has errors', async () => {
      const res = await call('render_storyboard_docx', { artifact_id: artifactId });
      expect(res.__isError).toBe(true);
      expect(res.message).toMatch(/rendering was refused/);
    });

    it('renders a draft on request and preserves the template package', async () => {
      const res = await call('render_storyboard_docx', { artifact_id: artifactId, allow_invalid: true });
      expect(res.__isError).toBe(false);
      expect(res.docx_path).toMatch(/\.docx$/);
      expect(res.bytes).toBeGreaterThan(10_000);

      const JSZip = (await import('jszip')).default;
      const { readFileSync } = await import('node:fs');
      const zip = await JSZip.loadAsync(readFileSync(res.docx_path));

      // Formatting lives in these parts; they must survive untouched.
      const template = await JSZip.loadAsync(
        readFileSync(path.join(process.cwd(), 'templates', 'storyboard-template-v1.docx')),
      );
      for (const part of ['word/styles.xml', 'word/theme/theme1.xml', 'word/numbering.xml', 'word/header1.xml', 'word/footer1.xml']) {
        const a = await zip.file(part)!.async('uint8array');
        const b = await template.file(part)!.async('uint8array');
        expect(Buffer.compare(Buffer.from(a), Buffer.from(b)), `${part} unchanged`).toBe(0);
      }

      const docXml = await zip.file('word/document.xml')!.async('string');

      // Duplicate bookmark names make Word treat the file as corrupt.
      const names = [...docXml.matchAll(/<w:bookmarkStart[^>]*w:name="([^"]+)"/g)].map((m) => m[1]!);
      expect(new Set(names).size).toBe(names.length);

      // No content from the Solar reference document may survive.
      expect(docXml).not.toMatch(/Solar Photovoltaic Entrepreneur/);
      expect(docXml).not.toMatch(/IREDA/);
    }, 60_000);

    it('writes a question bank and renumbers it in module order', async () => {
      const search = await call('search_course_content', {
        course_id: COURSE,
        query: 'pellet die moisture crushing',
        module_number: 5,
        document_types: ['PH'],
        limit: 1,
      });
      const chunk = search.results[0];
      const ref = {
        document_type: chunk.document_type,
        pdf_page: chunk.pdf_page,
        section: chunk.section,
        chunk_id: chunk.chunk_id,
      };

      const state = await call('get_storyboard', { artifact_id: artifactId });
      const question = (n: number) => ({
        module_number: 5,
        stem: `Test question ${n} about biomass pellet preparation and moisture control?`,
        options: { a: `Option A${n}`, b: `Option B${n}`, c: `Option C${n}`, d: `Option D${n}` },
        correct_option: 'a',
        explanation: `Explanation ${n} drawn from the pellet preparation content in the handbook.`,
        sources: [ref],
      });

      const res = await call('set_assessment_content', {
        artifact_id: artifactId,
        base_version: state.version,
        questions: Array.from({ length: 10 }, (_, i) => question(i + 1)),
        minimum_aggregate_pass_pct: 70,
        remarks: 'Total 30 hours.',
      });

      expect(res.__isError).toBe(false);
      expect(res.total_questions).toBe(10);
      expect(res.expected_per_module).toBe(10);
      expect(res.per_module.find((m: any) => m.module === 5).questions).toBe(10);

      const after = await call('get_storyboard', { artifact_id: artifactId });
      const questions = after.assessment.questions;
      // Numbers and ids are assigned by the server, continuously from 1.
      expect(questions.map((q: any) => q.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(questions[0].question_id).toBe('q-001');
      // The policy exception must be recorded on every question.
      expect(questions.every((q: any) => q.distractors_authored === true)).toBe(true);
      expect(after.assessment.disclosure_note).toMatch(/do not contain an answer key/);
      expect(after.assessment.minimum_aggregate_pass_pct).toBe(70);
    });

    it('rejects a question with no citation, and one for an unknown module', async () => {
      const state = await call('get_storyboard', { artifact_id: artifactId });
      const base = {
        module_number: 5,
        stem: 'A question',
        options: { a: 'a', b: 'b', c: 'c', d: 'd' },
        correct_option: 'a',
        explanation: 'because',
      };

      const noCitation = await call('set_assessment_content', {
        artifact_id: artifactId,
        base_version: state.version,
        questions: [{ ...base, sources: [] }],
      });
      expect(noCitation.__isError).toBe(true);
      expect(JSON.stringify(noCitation.detail)).toMatch(/no sources/);

      const badModule = await call('set_assessment_content', {
        artifact_id: artifactId,
        base_version: state.version,
        questions: [{ ...base, module_number: 99, sources: [{ document_type: 'PH', pdf_page: 1, section: 's', chunk_id: 'x' }] }],
      });
      expect(badModule.__isError).toBe(true);

      // Neither rejection may have advanced the version.
      const after = await call('get_storyboard', { artifact_id: artifactId });
      expect(after.version).toBe(state.version);
    });

    it('flags a short question bank and renders the bank into the DOCX', async () => {
      const report = await call('validate_storyboard', { artifact_id: artifactId });
      const codes = report.levels.content.findings.map((f: any) => f.code);
      // Module 5 has its ten; the other content modules have none.
      expect(codes).toContain('question_count');

      const render = await call('render_storyboard_docx', { artifact_id: artifactId, allow_invalid: true });
      expect(render.__isError).toBe(false);

      const JSZip = (await import('jszip')).default;
      const { readFileSync } = await import('node:fs');
      const zip = await JSZip.loadAsync(readFileSync(render.docx_path));
      const xml = await zip.file('word/document.xml')!.async('string');
      const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]!).join('');

      expect(text).toMatch(/10-Question Bank \(Full Student Version\)/);
      expect(text).toMatch(/Correct Answer: a\) Option A1/);
      expect(text).toMatch(/Minimum Aggregate Passing % at QP Level: 70/);
      // The Solar reference's own bank must not survive.
      expect(text).not.toMatch(/voltage generating capacity of a single photovoltaic cell/);
    }, 60_000);

    it('keeps history append-only and supports rollback', async () => {
      const history = await call('get_storyboard_history', { artifact_id: artifactId });
      const versions = history.versions.map((v: any) => v.version);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
      expect(versions.length).toBeGreaterThanOrEqual(3);

      const current = history.artifact.current_version;
      const res = await call('rollback_storyboard', {
        artifact_id: artifactId,
        to_version: 2,
        reason: 'e2e rollback',
      });
      expect(res.new_version).toBe(current + 1);

      // Rollback must not destroy the versions it skipped over.
      const after = await call('get_storyboard_history', { artifact_id: artifactId });
      expect(after.versions.length).toBe(versions.length + 1);
      const v2 = await call('get_storyboard', { artifact_id: artifactId, version: 2 });
      expect(v2.version).toBe(2);
    });
  });
});
