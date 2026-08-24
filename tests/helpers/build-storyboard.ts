/**
 * Shared test helper: drive the storyboard build loop to completion.
 *
 * Three suites build a storyboard, and each needs the same thing -- a client that
 * follows the loop honestly. Keeping it in one place means the loop's contract is
 * asserted once and any change to it breaks compilation everywhere rather than
 * silently passing in a stale copy.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Call = (name: string, args?: Record<string, unknown>) => Promise<any>;

/**
 * Fills one module's work order with placeholder text, as a client would.
 *
 * Mirrors the real loop exactly -- same tools, same shape, citations only from
 * module.sources -- so what it proves is that the loop converges and enforces its
 * rules, not that the wording is any good.
 */
export function moduleSubmission(artifactId: string, module: any): Record<string, unknown> {
  const source = module.sources[0];
  const text = String(source.text).replace(/\s+/g, ' ').slice(0, 200);
  const args: Record<string, unknown> = { artifact_id: artifactId, module: module.number };

  if (module.needs_description) {
    args.description = text;
    args.description_chunk_ids = [source.chunk_id];
  }
  if (module.part_a.length > 0) {
    args.part_a = module.part_a.map((s: any) => ({
      row_id: s.row_id,
      activity_name: 'Guided Simulation',
      interactive_description: text,
      correlation: `${module.nos_code} / PC1, PC3`,
      chunk_ids: [source.chunk_id],
    }));
  }
  if (module.lms_rows.length > 0) {
    args.lms_rows = module.lms_rows.map(() => ({
      recommended_standard: 'xAPI',
      tracking: 'xAPI Verbs: explored, identified\nData: activity opened; steps completed',
      completion_criteria: text,
      chunk_ids: [source.chunk_id],
    }));
  }
  if (module.part_b.length > 0) {
    args.part_b = module.part_b.map((s: any) => ({
      row_id: s.row_id,
      visual: 'Wide establishing shot: the plant floor and its main equipment.',
      audio: `Host (On-Camera): "${text}"`,
      chunk_ids: [source.chunk_id],
    }));
  }
  if (module.part_c.length > 0) {
    args.part_c = module.part_c.map((s: any) => ({
      slide_id: s.slide_id,
      visual_cues: 'Heading and three bullets.',
      instructor_script: text,
      chunk_ids: [source.chunk_id],
    }));
  }
  if (module.glossary_terms_needed > 0) {
    args.glossary_terms = Array.from({ length: module.glossary_terms_needed }, (_, i) => ({
      term: `TRM${module.number}${i + 1}`,
      full_form: `Term ${module.number}-${i + 1} Full Form`,
      definition: text.slice(0, 80),
      chunk_ids: [source.chunk_id],
    }));
  }
  if (module.questions_needed > 0) {
    args.questions = Array.from({ length: module.questions_needed }, (_, i) => ({
      stem: `Question ${i + 1} on ${module.title}?`,
      options: { a: 'First', b: 'Second', c: 'Third', d: 'Fourth' },
      correct_option: 'a',
      explanation: text,
      chunk_ids: [source.chunk_id],
    }));
  }
  return args;
}


export interface BuildResult {
  artifactId: string;
  calls: number;
  modules: number;
  final: any;
}

/**
 * Runs create_storyboard_draft through to READY_TO_RENDER.
 *
 * Counts its own calls, because the point of the module loop is how few there
 * are: a regression that reverts to per-row batching would still produce a valid
 * document, just slowly and expensively, and only a call count catches that.
 */
export async function buildStoryboard(call: Call, courseId: string): Promise<BuildResult> {
  // regenerate: true because a test that builds a storyboard wants a new one,
  // every time. Without it the second build of a course returns the first one --
  // which is the tool doing its job, since rebuilding a subject that already has
  // a finished document is exactly what it now refuses to do by default.
  const draft = await call('create_storyboard_draft', { course_id: courseId, regenerate: true });
  if (draft.__isError) throw new Error(`create_storyboard_draft failed: ${draft.message}`);
  if (!draft.artifact_id) {
    throw new Error(`create_storyboard_draft returned no artifact: ${draft.status ?? JSON.stringify(draft)}`);
  }

  let res = await call('storyboard_next_module', { artifact_id: draft.artifact_id });
  let calls = 1;
  let modules = 0;
  const seen = new Set<number>();

  while (res.status === 'WRITE_THIS') {
    const module = res.module;
    if (module.sources.length === 0) {
      throw new Error(`module ${module.number} arrived with no sources`);
    }
    res = await call('storyboard_submit_module', moduleSubmission(draft.artifact_id, module));
    calls += 1;
    if (res.__isError) {
      throw new Error(`submit failed on module ${module.number}: ${res.message}`);
    }
    // A module handed out twice means the loop is not converging.
    if (seen.has(module.number) && res.status === 'WRITE_THIS' && res.module.number === module.number) {
      throw new Error(`module ${module.number} did not progress`);
    }
    seen.add(module.number);
    modules += 1;
    if (calls > 40) throw new Error('the loop did not terminate');
  }

  return { artifactId: draft.artifact_id, calls, modules, final: res };
}

/**
 * Answers the storyboard flow's questions and returns its terminal step.
 *
 * There are three questions when a subject has never been storyboarded and four
 * when it has: the extra one offers the saved storyboard back instead of paying to
 * write it again. Tests that care about what happens *after* the flow should not
 * each have to know which case they are in, so this answers the reuse question
 * with `reuseChoice` -- 'generate' for a test that wants fresh authoring -- and
 * leaves everything else alone.
 */
export async function answerStoryboardFlow(
  call: Call,
  track: string,
  subject: string,
  reuseChoice: 'reuse' | 'generate' = 'generate',
): Promise<{ step: any; askedAboutReuse: boolean }> {
  const menu = await call('start_flow');
  const session = menu.session_id;
  await call('flow_choose', { session_id: session, choice: 'storyboard' });
  await call('flow_choose', { session_id: session, choice: track });
  let step = await call('flow_choose', { session_id: session, choice: subject });

  const askedAboutReuse = step.step === 'choose_storyboard_source';
  if (askedAboutReuse) {
    step = await call('flow_choose', { session_id: session, choice: reuseChoice });
  }
  return { step, askedAboutReuse };
}
