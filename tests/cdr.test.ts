/**
 * The CDR storyboard flow.
 *
 * Two things distinguish a CDR course from a qualification course, and both are
 * tested here: its timing and its routing come from a master file rather than
 * from a timing PDF and a chapter crosswalk, and each module draws from its own
 * reference document rather than from one shared handbook. Everything after that
 * -- the skeleton, the task loop, validation, the template and the .docx -- is
 * the same code path, and the point of the design is that it stays that way.
 *
 * The nine real reference documents are not supplied yet. Rather than leave the
 * flow unproven until they arrive, the tests that need documents generate
 * stand-ins: real PDFs, ingested by the real pipeline, whose text is distinct per
 * document so a citation landing in the wrong one is detectable. Any real
 * document already on disk is used as-is and never overwritten.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { runTool } from '../src/mcp/tools/index.js';
import { courseDir } from '../src/courses/course-config.js';
import { CDR_COURSES } from '../src/courses/cdr-generated.js';
import { cdrCourseStatus } from '../src/cdr/catalog.js';
import { moduleScope } from '../src/courses/module-scope.js';
import { parseMasterFile, masterAsTimingAllocation } from '../src/cdr/master-file.js';
import { writeSimplePdf } from './helpers/simple-pdf.js';

const COURSE = 'cdr-biochar';

function json(result: Awaited<ReturnType<typeof runTool>>): any {
  return { ...JSON.parse(result.content[0]!.text), __isError: result.isError === true };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return json(await runTool(name, args));
}

/** Fixture PDFs this run created, so only those are removed afterwards. */
const created: string[] = [];

function ensureReferenceDocuments(): void {
  const definition = CDR_COURSES.find((c) => c.course_id === COURSE)!;
  for (const doc of definition.documents) {
    const file = path.join(courseDir(COURSE), doc.file);
    if (existsSync(file)) continue; // a real document was supplied; leave it alone
    // Text unique to this document, so a citation from the wrong one is visible.
    writeSimplePdf(file, [
      doc.title,
      '',
      `This reference document is ${doc.title}.`,
      '',
      `Section 1. Scope of ${doc.title}`,
      `The subject matter of ${doc.title} covers its own distinct material, described here at`,
      `sufficient length that a retrieval query about ${doc.title} returns this passage rather`,
      'than a passage from any of the other reference documents in this course.',
      '',
      `Section 2. Practice within ${doc.title}`,
      `Practical guidance belonging to ${doc.title} appears in this section, including the`,
      'steps, considerations and criteria that a learner is expected to be able to describe',
      'after studying it. Every sentence here belongs to this document alone.',
      '',
      `Section 3. Assessment of ${doc.title}`,
      `Assessment material for ${doc.title} is set out here so that questions filed under a`,
      'module routed to this document have something in scope to cite.',
    ]);
    created.push(file);
  }
}

describe('CDR master file', () => {
  it('reads modules, durations and per-module document routing', async () => {
    const master = await parseMasterFile(path.join(courseDir(COURSE), 'master.docx'));

    expect(master.stated_total_hours).toBe(20);
    expect(master.stated_module_count).toBe(7);
    expect(master.modules).toHaveLength(7);

    // Durations are read, never divided out: the modules sum to the stated total.
    const total = master.modules.reduce((a, m) => a + m.minutes, 0);
    expect(total).toBe(20 * 60);

    // Module 1 is the one split into units, each with its own document and hour.
    const m1 = master.modules.find((m) => m.number === 1)!;
    expect(m1.minutes).toBe(120);
    expect(m1.units).toHaveLength(2);
    expect(m1.units[0]!.minutes).toBe(60);
    expect(m1.units[0]!.references[0]!.within).toBe('Module 1');

    // Module 7 draws on three documents at once.
    const m7 = master.modules.find((m) => m.number === 7)!;
    expect(m7.references).toHaveLength(3);

    expect(master.documents).toHaveLength(9);
  }, 60_000);

  it('presents the master file as a timing allocation the skeleton can consume', async () => {
    const master = await parseMasterFile(path.join(courseDir(COURSE), 'master.docx'));
    const timing = masterAsTimingAllocation(COURSE, master, 'master.docx');

    expect(timing.modules).toHaveLength(7);
    expect(timing.stated_total_minutes).toBe(1200);
    expect(timing.arithmetic.course_total_ok).toBe(true);

    // Every module has at least one unit: Part A is a per-unit table, and a
    // module with no rows would render as an empty section.
    for (const module of timing.modules) {
      expect(module.units.length).toBeGreaterThan(0);
      expect(module.units.reduce((a, u) => a + u.minutes, 0)).toBe(module.minutes);
    }
  }, 60_000);

  it('routes each module to the documents the master file names', () => {
    const expected: Record<number, number> = { 1: 2, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 3 };
    for (const [moduleNumber, count] of Object.entries(expected)) {
      const scope = moduleScope(COURSE, Number(moduleNumber));
      expect(scope.kind).toBe('documents');
      if (scope.kind !== 'documents') throw new Error('unreachable');
      expect(scope.doc_keys, `module ${moduleNumber}`).toHaveLength(count);
    }
  });

  it('keeps a qualification course on chapter scoping', () => {
    const scope = moduleScope('biofuels', 5);
    expect(scope.kind).toBe('chapter');
    if (scope.kind !== 'chapter') throw new Error('unreachable');
    expect(scope.chapter).toBe(7); // the crosswalk, unchanged
  });
});

describe('CDR flow', () => {
  it('offers four options, with CDR distinct from the qualification storyboard', async () => {
    const menu = await call('start_flow');
    expect(menu.options.map((o: any) => o.value)).toEqual([
      'module_content',
      'ph_reading',
      'storyboard',
      'cdr_storyboard',
    ]);

    const chosen = await call('flow_choose', { session_id: menu.session_id, choice: '4' });
    expect(chosen.flow).toBe('cdr_storyboard');
    expect(chosen.step).toBe('choose_subject');
    // The CDR list holds CDR courses only; Biofuels is not one of them.
    expect(chosen.options.map((o: any) => o.value)).toEqual([COURSE]);
  }, 60_000);

  it('names the exact files a course is waiting for rather than a bare "not ready"', () => {
    const definition = CDR_COURSES.find((c) => c.course_id === COURSE)!;
    const anyMissing = definition.documents.some(
      (d) => !existsSync(path.join(courseDir(COURSE), d.file)),
    );
    if (!anyMissing) return; // all nine supplied; nothing to report

    const status = cdrCourseStatus(COURSE);
    expect(status.ready).toBe(false);
    expect(status.blocker).toMatch(/named exactly/);
    // The message must name a file, and say which modules the gap blocks.
    expect(status.blocker).toMatch(/\.pdf/);
    expect(status.blocked_modules.length).toBeGreaterThan(0);
  });
});

describe('CDR storyboard generation', () => {
  beforeAll(async () => {
    ensureReferenceDocuments();
    const ingested = await call('ingest_course_documents', { course_id: COURSE, force: true });
    expect(ingested.__isError, JSON.stringify(ingested).slice(0, 300)).toBe(false);
  }, 300_000);

  afterAll(() => {
    for (const file of created) rmSync(file, { force: true });
  });

  it('ingests the nine reference documents and not the master file', async () => {
    const status = cdrCourseStatus(COURSE);
    expect(status.document_count).toBe(9);
    expect(status.ready).toBe(true);
    for (const doc of status.documents) expect(doc.indexed, doc.file).toBe(true);

    // The master file states routing and duration, not teachable content. If it
    // were chunked, a module could cite its own instructions as source material.
    const manifest = await call('get_course_manifest', { course_id: COURSE });
    const master = manifest.documents.find((d: any) => d.document_type === 'MASTER');
    expect(master?.indexed ?? false).toBe(false);
  }, 120_000);

  it('builds a complete, valid storyboard through the same loop and template', async () => {
    const menu = await call('start_flow');
    await call('flow_choose', { session_id: menu.session_id, choice: 'cdr_storyboard' });
    const ready = await call('flow_choose', { session_id: menu.session_id, choice: COURSE });
    expect(ready.step).toBe('storyboard_ready');
    expect(ready.done).toBe(true);
    expect(ready.data.module_count).toBe(7);
    expect(ready.data.total_hours).toBe(20);

    const draft = await call('create_storyboard_draft', { course_id: ready.data.course_id });
    expect(draft.__isError, JSON.stringify(draft).slice(0, 300)).toBe(false);
    expect(draft.module_count).toBe(7);
    expect(draft.next_call.tool).toBe('storyboard_next_task');

    // Durations come from the master file, unchanged.
    const m1 = draft.modules.find((m: any) => m.number === 1);
    expect(m1.duration_minutes).toBe(120);
    const m2 = draft.modules.find((m: any) => m.number === 2);
    expect(m2.duration_minutes).toBe(180);

    // Drive it with a client that only follows next_call, as for the other courses.
    let res = await call(draft.next_call.tool, draft.next_call.args);
    let submits = 0;
    const citedByModule = new Map<number, Set<string>>();

    while (res.status === 'WRITE_THIS') {
      const task = res.task;
      expect(task.sources.length, `task ${task.task_id} has no sources`).toBeGreaterThan(0);

      // Every chunk offered must belong to a document this module is routed to.
      const scope = moduleScope(COURSE, task.module);
      if (scope.kind !== 'documents') throw new Error('CDR module must be document-scoped');
      for (const source of task.sources) {
        expect(scope.doc_keys, `module ${task.module} was offered ${source.doc_key}`).toContain(
          source.doc_key,
        );
      }

      const source = task.sources[0];
      citedByModule.set(
        task.module,
        (citedByModule.get(task.module) ?? new Set()).add(source.doc_key),
      );
      const sentence = source.text.replace(/\s+/g, ' ').slice(0, 200);
      const args: Record<string, unknown> = { artifact_id: draft.artifact_id, task_id: task.task_id };

      if (task.section === 'lms_mapping') {
        args.lms_rows = task.expected_rows.map((r: any) => ({
          unit_range: r.unit_range,
          activity_type: r.activity_type,
          recommended_standard: 'xAPI',
          tracking: `Verbs for ${r.unit_range}.`,
          completion_criteria: sentence,
          chunk_ids: [source.chunk_id],
        }));
      } else if (task.section === 'assessment') {
        args.questions = Array.from({ length: 10 }, (_, i) => ({
          stem: `Question ${i + 1} on ${task.module_title}?`,
          options: { a: 'First', b: 'Second', c: 'Third', d: 'Fourth' },
          correct_option: 'a',
          explanation: sentence,
          chunk_ids: [source.chunk_id],
        }));
      } else {
        args.entries = task.fields.map((f: any) => ({
          field_id: f.field_id,
          text: `${f.label}: ${sentence}`,
          ...(f.requires_citation ? { chunk_ids: [source.chunk_id] } : {}),
        }));
      }

      const before = res.progress.tasks_done;
      res = await call('storyboard_submit_task', args);
      expect(res.__isError, `submit failed on ${task.task_id}: ${res.message}`).toBe(false);
      expect(res.progress.tasks_done, `no progress after ${task.task_id}`).toBeGreaterThan(before);
      expect(++submits).toBeLessThan(400);
    }

    expect(res.status).toBe('READY_TO_RENDER');
    expect(res.progress.fields_remaining).toBe(0);

    // Module 1 is routed to two documents and module 7 to three; the rest to one.
    expect(citedByModule.get(2)!.size).toBe(1);

    const report = await call('validate_storyboard', { artifact_id: draft.artifact_id });
    expect(report.summary.errors, JSON.stringify(report.levels.content.findings.slice(0, 3))).toBe(0);
    expect(report.passed).toBe(true);

    // Same template, same renderer as every other storyboard.
    const rendered = await call('render_storyboard_docx', { artifact_id: draft.artifact_id });
    expect(rendered.__isError).toBe(false);
    expect(rendered.validation_passed).toBe(true);
    expect(rendered.docx_path).toMatch(/\.docx$/);
    expect(rendered.bytes).toBeGreaterThan(20_000);
  }, 600_000);

  it('refuses a citation from a document the module is not routed to', async () => {
    const draft = await call('create_storyboard_draft', { course_id: COURSE });
    const first = await call('storyboard_next_task', { artifact_id: draft.artifact_id });
    const task = first.task;

    // A chunk from a document belonging to a different module.
    const other = moduleScope(COURSE, task.module === 3 ? 4 : 3);
    if (other.kind !== 'documents') throw new Error('unreachable');
    const foreign = await call('search_course_content', {
      course_id: COURSE,
      query: 'reference document',
      limit: 20,
    });
    const outsider = foreign.results.find((r: any) => other.doc_keys.includes(r.doc_key));
    expect(outsider, 'expected a chunk from another module\'s document').toBeTruthy();

    const rejected = await call('storyboard_submit_task', {
      artifact_id: draft.artifact_id,
      task_id: task.task_id,
      entries: task.fields.map((f: any) => ({
        field_id: f.field_id,
        text: 'Some text.',
        ...(f.requires_citation ? { chunk_ids: [outsider.chunk_id] } : {}),
      })),
    });
    expect(rejected.__isError).toBe(true);
    expect(rejected.message).toMatch(/Nothing was committed/);
  }, 120_000);
});
