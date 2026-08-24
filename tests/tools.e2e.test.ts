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
// Imported after DB_PATH is set, like the tool layer itself.
const { moduleSubmission } = await import('./helpers/build-storyboard.js');

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
      const res = await call('create_storyboard_draft', { course_id: COURSE, note: 'e2e test', regenerate: true });
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
      // A client that reads "call validate_storyboard, then render" after creating
      // an empty skeleton stops and reports the draft, which is what this prevents.
      const draft = await call('create_storyboard_draft', { course_id: COURSE, regenerate: true });
      expect(draft.work.complete).toBe(false);
      expect(draft.work.empty_fields_remaining).toBeGreaterThan(100);
      // Module 8 has no source content, so it is not work anyone can do.
      expect(draft.work.modules_remaining).toBe(7);
      expect(draft.work.next_module).toBe(1);
      // The draft must point into the build loop, not read as a finished result.
      expect(draft.next_call.tool).toBe('storyboard_next_module');
      expect(draft.next_call.args.artifact_id).toBe(draft.artifact_id);
      expect(draft.next_step).toMatch(/empty skeleton/);
      expect(draft.next_step).not.toMatch(/^Call validate_storyboard/);
    }, 120_000);

    it('hands out one module at a time, with its chapter attached exactly once', async () => {
      const first = await call('storyboard_next_module', { artifact_id: artifactId });
      expect(first.status).toBe('WRITE_THIS');
      expect(first.module.number).toBe(1);
      expect(first.progress.modules_total).toBe(7); // module 8 is not work

      // Every slot the module needs is enumerated, so nothing is left to infer.
      expect(first.module.part_a.length).toBeGreaterThan(0);
      expect(first.module.part_b.length).toBeGreaterThan(0);
      expect(first.module.part_c.length).toBeGreaterThan(0);
      expect(first.module.lms_rows.length).toBe(first.module.part_a.length);
      expect(first.module.questions_needed).toBe(10);

      // The sources are the module's own chapter, deduplicated. Sending a chunk
      // more than once is the specific waste this loop exists to remove.
      const ids = first.module.sources.map((s: any) => s.chunk_id);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      // Scoped to the module's chapter: module 1 maps to PH/FG chapter 1.
      for (const source of first.module.sources) {
        if (source.document_type === 'PH' || source.document_type === 'FG') {
          expect(source.chunk_id, `${source.chunk_id} is out of module 1's scope`).toMatch(/:/);
        }
      }

      // And the reply carries the submission's shape, so the client writes rather
      // than works out an argument structure.
      expect(first.next_call.tool).toBe('storyboard_submit_module');
      expect(first.next_call.args.module).toBe(1);
    }, 120_000);

    it('writes a whole module in one call and versions it once', async () => {
      const before = await call('get_storyboard', { artifact_id: artifactId });
      const work = await call('storyboard_next_module', { artifact_id: artifactId });

      const res = await call(
        'storyboard_submit_module',
        moduleSubmission(artifactId, work.module),
      );
      expect(res.__isError, res.message).toBe(false);

      // One module, one version. Per-row writing produced a version per field and
      // rewrote the whole state each time.
      expect(res.version).toBe(before.version + 1);
      expect(res.committed_module).toBe(work.module.number);

      // The module is done and the loop has moved on.
      expect(res.status).toBe('WRITE_THIS');
      expect(res.module.number).toBeGreaterThan(work.module.number);
      expect(res.progress.modules_done).toBe(1);
    }, 120_000);

    it('refuses a citation the module was not given, and commits nothing', async () => {
      const before = await call('get_storyboard', { artifact_id: artifactId });
      const work = await call('storyboard_next_module', { artifact_id: artifactId });

      // A chunk that genuinely exists but belongs to another module's chapter.
      const other = await call('search_course_content', {
        course_id: COURSE,
        query: 'first aid burns electric shock',
        module_number: 7, // chapter 5
        document_types: ['PH'],
        limit: 1,
      });
      const foreign = other.results[0].chunk_id;
      expect(work.module.sources.map((s: any) => s.chunk_id)).not.toContain(foreign);

      const res = await call('storyboard_submit_module', {
        artifact_id: artifactId,
        module: work.module.number,
        part_a: [
          {
            row_id: work.module.part_a[0].row_id,
            activity_name: 'Wrong Chapter Probe',
            interactive_description: 'Content citing a chunk from another chapter.',
            chunk_ids: [foreign],
          },
        ],
      });

      // Out-of-scope citation is refused at write time, so a wrong-chapter
      // citation is not reachable by following the loop at all -- the validator's
      // check for it is now a backstop rather than the only guard.
      expect(res.__isError).toBe(true);
      expect(JSON.stringify(res.detail)).toMatch(/not in module\.sources/);

      const after = await call('get_storyboard', { artifact_id: artifactId });
      expect(after.version).toBe(before.version);
    }, 120_000);

    it('rejects an unknown row_id without committing anything', async () => {
      const before = await call('get_storyboard', { artifact_id: artifactId });
      const work = await call('storyboard_next_module', { artifact_id: artifactId });

      const res = await call('storyboard_submit_module', {
        artifact_id: artifactId,
        module: work.module.number,
        part_a: [
          {
            row_id: 'does-not-exist',
            interactive_description: 'x',
            chunk_ids: [work.module.sources[0].chunk_id],
          },
        ],
      });
      expect(res.__isError).toBe(true);

      const after = await call('get_storyboard', { artifact_id: artifactId });
      expect(after.version).toBe(before.version);
    }, 120_000);

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
      // The course's own track template: each track has its own document, and
      // rendering to another's would change the structure, not just the wording.
      const { templateFile } = await import('../src/util/config.js');
      const { getCourseConfig } = await import('../src/courses/course-config.js');
      const template = await JSZip.loadAsync(
        readFileSync(templateFile(getCourseConfig(COURSE).track)),
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

    it('numbers the question bank continuously across modules', async () => {
      // Questions arrive one module at a time but the bank reads as one document,
      // so numbering is assigned in module order rather than arrival order.
      const state = await call('get_storyboard', { artifact_id: artifactId });
      const bank = state.assessment?.questions ?? [];
      expect(bank.length).toBeGreaterThan(0);

      expect(bank.map((q: any) => q.number)).toEqual(bank.map((_: any, i: number) => i + 1));
      const modules = bank.map((q: any) => q.module_number);
      expect(modules).toEqual([...modules].sort((a: number, b: number) => a - b));
      for (const q of bank) {
        expect(q.distractors_authored).toBe(true);
        expect(q.sources.length).toBeGreaterThan(0);
      }
    }, 120_000);

    it('flags a short question bank and renders the bank into the DOCX', async () => {
      const report = await call('validate_storyboard', { artifact_id: artifactId });
      const codes = report.levels.content.findings.map((f: any) => f.code);
      // One module has its ten; the other content modules have none yet.
      expect(codes).toContain('question_count');

      const render = await call('render_storyboard_docx', { artifact_id: artifactId, allow_invalid: true });
      expect(render.__isError).toBe(false);

      const JSZip = (await import('jszip')).default;
      const { readFileSync } = await import('node:fs');
      const zip = await JSZip.loadAsync(readFileSync(render.docx_path));
      const xml = await zip.file('word/document.xml')!.async('string');
      const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]!).join('');

      expect(text).toMatch(/\d+-Question Bank \(Full Student Version\)/);
      expect(text).toMatch(/Correct Answer: a\)/);
      expect(text).toMatch(/Minimum Aggregate Passing % at QP Level: 70/);
      // The Solar reference's own bank must not survive.
      expect(text).not.toMatch(/voltage generating capacity of a single photovoltaic cell/);
    }, 60_000);

    it('keeps history append-only and supports rollback', async () => {
      // One version per module, so a course produces a handful rather than the
      // hundred-plus a per-field loop wrote. Two more modules give rollback
      // something to roll back to.
      for (let i = 0; i < 2; i++) {
        const work = await call('storyboard_next_module', { artifact_id: artifactId });
        if (work.status !== 'WRITE_THIS') break;
        const res = await call('storyboard_submit_module', moduleSubmission(artifactId, work.module));
        expect(res.__isError, res.message).toBe(false);
      }

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
