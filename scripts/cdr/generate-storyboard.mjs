/**
 * End-to-end CDR Biochar storyboard generation.
 *
 * Drives the entire flow programmatically:
 *   start_flow → cdr_storyboard → cdr-biochar
 *   → create_storyboard_draft
 *   → storyboard_next_task / storyboard_submit_task loop
 *   → validate_storyboard
 *   → render_storyboard_docx
 *
 * Content is synthesized from the source text each task provides. This is the
 * same loop an MCP client would run, with deterministic content generation
 * standing in for the reasoning model.
 */

const { runTool } = await import('../../src/mcp/tools/index.ts');

function parse(result) {
  const last = result.content[result.content.length - 1]?.text ?? '{}';
  return {
    json: last.trimStart().startsWith('{') ? JSON.parse(last) : {},
    body: result.content[0]?.text ?? '',
    isError: result.isError ?? false,
  };
}

async function call(name, args = {}) {
  const result = parse(await runTool(name, args));
  if (result.isError) {
    console.error(`\n!! ERROR calling ${name}:`, JSON.stringify(result.json, null, 2));
  }
  return result;
}

const bar = (ch = '-') => console.log(ch.repeat(72));

// ---------------------------------------------------------------------------
// Content generators: one per task section
// ---------------------------------------------------------------------------

/**
 * Generates content for a task's fields from its source text.
 *
 * The strategy: extract the first meaningful sentences from the sources and
 * compose them into field-appropriate content. This is what a reasoning model
 * would do with more sophistication.
 */
function extractSentences(sources, maxSentences = 5) {
  const allText = sources.map((s) => s.text).join(' ');
  const sentences = allText
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 20 && s.length < 500)
    .slice(0, maxSentences);
  return sentences.length > 0 ? sentences.join(' ') : allText.slice(0, 300);
}

function pickChunkIds(sources, count = 1) {
  return sources.slice(0, Math.min(count, sources.length)).map((s) => s.chunk_id);
}

function generatePartAContent(task) {
  const entries = [];
  for (const field of task.fields) {
    const fid = field.field_id;
    let text;

    if (fid.endsWith('activity_name')) {
      // Name an interactive activity based on the unit topic
      const topicWords = task.module_title.split(/\s+/).slice(0, 4).join(' ');
      text = `Interactive ${topicWords} Explorer`;
    } else if (fid.endsWith('interactive_description')) {
      // Build a description from the source material
      const extract = extractSentences(task.sources, 6);
      text =
        `Learners explore key concepts through an interactive activity. ${extract} ` +
        'The activity reinforces understanding through guided practice and real-world application scenarios.';
    } else if (fid.endsWith('correlation')) {
      text = 'SGJ/N4102 / PC1, PC2';
    } else {
      text = extractSentences(task.sources, 3);
    }

    entries.push({
      field_id: fid,
      text,
      ...(field.requires_citation ? { chunk_ids: pickChunkIds(task.sources, 2) } : {}),
    });
  }
  return { entries };
}

function generateLmsContent(task) {
  const expectedRows = task.expected_rows ?? [];
  const rows = expectedRows.map((r) => ({
    unit_range: r.unit_range,
    activity_type: r.activity_type,
    recommended_standard: 'xAPI',
    tracking: `Completion status, score, time spent on ${r.activity_type}`,
    completion_criteria: `Learner must complete all interactive elements of ${r.activity_type} and achieve minimum 70% score`,
    chunk_ids: pickChunkIds(task.sources, 1),
  }));
  return { lms_rows: rows };
}

function generatePartBContent(task) {
  const entries = [];
  for (const field of task.fields) {
    const fid = field.field_id;
    let text;

    if (fid.endsWith('visual')) {
      text =
        'Wide shot of presenter at podium with animated infographic overlay showing key concepts. ' +
        'Transition to split-screen with relevant diagrams and data visualizations.';
    } else if (fid.endsWith('gfx')) {
      text =
        'Animated title card with module branding. Key term callouts appear as floating labels. ' +
        'Process flow diagram builds progressively as narrator explains each step.';
    } else if (fid.endsWith('audio')) {
      const extract = extractSentences(task.sources, 4);
      text = `[PRESENTER] ${extract}`;
    } else {
      text = extractSentences(task.sources, 3);
    }

    entries.push({
      field_id: fid,
      text,
      ...(field.requires_citation ? { chunk_ids: pickChunkIds(task.sources, 2) } : {}),
    });
  }
  return { entries };
}

function generatePartCContent(task) {
  const entries = [];
  for (const field of task.fields) {
    const fid = field.field_id;
    let text;

    if (fid.endsWith('title')) {
      text = task.title.replace(/^Module \d+, Part C, /, '');
    } else if (fid.endsWith('visual_cues')) {
      text =
        'Slide displays key concepts with supporting diagrams. Bullet points appear sequentially. ' +
        'Relevant images and charts illustrate the main themes.';
    } else if (fid.endsWith('instructor_script')) {
      const extract = extractSentences(task.sources, 5);
      text =
        `[INSTRUCTOR] Let us examine the key concepts. ${extract} ` +
        'Please refer to the visual on screen and note the critical points highlighted.';
    } else {
      text = extractSentences(task.sources, 3);
    }

    entries.push({
      field_id: fid,
      text,
      ...(field.requires_citation ? { chunk_ids: pickChunkIds(task.sources, 2) } : {}),
    });
  }
  return { entries };
}

function generateAssessmentContent(task) {
  const questionCount = 5; // config.assessment.questionsPerModule
  const questions = [];
  for (let i = 0; i < questionCount; i++) {
    const srcIdx = i % task.sources.length;
    const src = task.sources[srcIdx];
    const text = src?.text ?? '';
    const firstSentence = text.split(/[.!?]/)[0]?.trim() ?? 'The key concept';

    questions.push({
      stem: `Which of the following best describes ${firstSentence.toLowerCase().slice(0, 80)}?`,
      options: {
        a: `${firstSentence.slice(0, 100)}`,
        b: 'An alternative interpretation that does not align with the source material',
        c: 'A common misconception about this topic that learners may hold',
        d: 'None of the above descriptions are accurate',
      },
      correct_option: 'a',
      explanation:
        `The correct answer is derived from the source material which states: "${firstSentence.slice(0, 120)}". ` +
        'The other options represent common misconceptions or incomplete understanding.',
      chunk_ids: pickChunkIds(task.sources.slice(srcIdx, srcIdx + 2), 1),
    });
  }
  return { questions };
}

function generateContent(task) {
  switch (task.section) {
    case 'part_a':
      return generatePartAContent(task);
    case 'lms_mapping':
      return generateLmsContent(task);
    case 'part_b':
      return generatePartBContent(task);
    case 'part_c':
      return generatePartCContent(task);
    case 'assessment':
      return generateAssessmentContent(task);
    default:
      console.warn(`Unknown section: ${task.section}, using Part A generator`);
      return generatePartAContent(task);
  }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n🚀 CDR Biochar Storyboard — Full Generation\n');
  bar('=');

  // Step 1: Start the flow
  console.log('\n📋 Step 1: Starting flow...');
  const { json: startStep } = await call('start_flow');
  console.log(`   Session: ${startStep.session_id}`);
  console.log(`   Options: ${startStep.options?.map((o) => o.value).join(', ')}`);

  // Step 2: Choose CDR storyboard
  console.log('\n📋 Step 2: Choosing CDR storyboard...');
  const { json: cdrStep } = await call('flow_choose', {
    session_id: startStep.session_id,
    choice: 'cdr_storyboard',
  });
  console.log(`   Step: ${cdrStep.step}`);
  console.log(`   Options: ${cdrStep.options?.map((o) => o.value).join(', ') ?? '(direct to course list)'}`);

  // Step 3: Choose cdr-biochar
  console.log('\n📋 Step 3: Choosing cdr-biochar...');
  const { json: readyStep, isError: readyErr } = await call('flow_choose', {
    session_id: startStep.session_id,
    choice: 'cdr-biochar',
  });

  if (readyErr) {
    console.error('❌ Failed to select cdr-biochar. The course may not be ready.');
    console.error('   Check that all 9 reference PDFs are in courses/cdr-biochar/');
    process.exit(1);
  }

  console.log(`   Flow: ${readyStep.flow}, Step: ${readyStep.step}, Done: ${readyStep.done}`);
  if (readyStep.data?.routing) {
    console.log(`   Routing: ${readyStep.data.routing.length} module-document mappings`);
  }

  // Step 4: Create storyboard draft
  console.log('\n📋 Step 4: Creating storyboard draft...');
  bar();
  const { json: draft, isError: draftErr } = await call('create_storyboard_draft', {
    course_id: 'cdr-biochar',
  });

  if (draftErr) {
    console.error('❌ Failed to create draft:', draft.message ?? JSON.stringify(draft));
    process.exit(1);
  }

  const artifactId = draft.artifact_id;
  console.log(`   Artifact: ${artifactId}`);
  console.log(`   Version: ${draft.version}`);
  console.log(`   Modules: ${draft.module_count}`);
  console.log(`   Strategy: ${draft.timing_strategy}`);

  // Step 5: Task loop
  console.log('\n📋 Step 5: Building storyboard — task loop...');
  bar('=');

  let taskCount = 0;
  let currentResult = await call('storyboard_next_task', { artifact_id: artifactId });
  let envelope = currentResult.json;

  while (envelope.status === 'WRITE_THIS') {
    taskCount++;
    const task = envelope.task;
    const progress = envelope.progress;

    console.log(
      `\n  [${taskCount}/${progress.tasks_total}] ${task.title}  (${task.section})  ` +
        `${progress.percent_complete}%`,
    );

    // Generate content based on the task section
    const content = generateContent(task);

    // Submit the task
    const submitResult = await call('storyboard_submit_task', {
      artifact_id: artifactId,
      task_id: task.task_id,
      ...content,
    });

    if (submitResult.isError) {
      console.error(`  ❌ Task ${task.task_id} failed:`, submitResult.json.message ?? '');
      // Try to see what went wrong and skip
      const detail = submitResult.json.detail ?? submitResult.json.errors ?? submitResult.json;
      console.error('     Detail:', JSON.stringify(detail, null, 2).slice(0, 500));

      // Get the next task to continue
      currentResult = await call('storyboard_next_task', { artifact_id: artifactId });
      envelope = currentResult.json;
      continue;
    }

    console.log(`  ✅ Committed: ${submitResult.json.committed}`);
    envelope = submitResult.json;
  }

  console.log(`\n\n✅ Task loop complete — ${taskCount} tasks processed`);
  bar('=');

  // Step 6: Validate
  console.log('\n📋 Step 6: Validating storyboard...');
  const { json: validation } = await call('validate_storyboard', {
    artifact_id: artifactId,
  });
  console.log(`   Passed: ${validation.passed}`);
  console.log(`   Errors: ${validation.summary?.errors ?? 0}`);
  console.log(`   Warnings: ${validation.summary?.warnings ?? 0}`);

  if (validation.findings?.length > 0) {
    console.log('\n   Findings:');
    for (const f of validation.findings.slice(0, 10)) {
      console.log(`     ${f.severity}: ${f.message}`);
    }
    if (validation.findings.length > 10) {
      console.log(`     ... and ${validation.findings.length - 10} more`);
    }
  }

  // Step 7: Render .docx
  console.log('\n📋 Step 7: Rendering storyboard .docx...');
  const { json: rendered, isError: renderErr } = await call('render_storyboard_docx', {
    artifact_id: artifactId,
    allow_invalid: true, // Render even with validation warnings
  });

  if (renderErr) {
    console.error('❌ Render failed:', rendered.message ?? JSON.stringify(rendered));
    process.exit(1);
  }

  console.log(`\n   📄 DOCX generated!`);
  console.log(`   Path: ${rendered.docx_path}`);
  console.log(`   Size: ${(rendered.bytes / 1024).toFixed(1)} KB`);
  console.log(`   Version: ${rendered.version}`);
  console.log(`   Validation passed: ${rendered.validation_passed}`);

  bar('=');
  console.log('\n🎉 CDR Biochar storyboard generation complete!\n');
  console.log(`   Artifact ID: ${artifactId}`);
  console.log(`   Output: ${rendered.docx_path}`);
  console.log(`   Tasks completed: ${taskCount}`);
  bar('=');
}

main().catch((err) => {
  console.error('\n💥 Fatal error:', err);
  process.exit(1);
});
