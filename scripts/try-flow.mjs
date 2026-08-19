/**
 * Interactive walkthrough of the guided flow, for driving it by hand.
 *
 * This is a thin terminal front-end over the same tools an MCP client calls --
 * start_flow, flow_choose, read_ph_unit, plan_video_transcript. It adds no logic of
 * its own, so what you see here is exactly what a client sees.
 *
 * It cannot write the video narration: that is the client's reasoning job and this
 * server holds no model. What it gives you at the end of the video branch is the
 * scene plan with each scene's handbook text, which is the input generation works
 * from.
 *
 * Usage:
 *   npm run flow
 *   npm run flow -- "quality control and testing of pellets"   (heading shortcut)
 *   echo "video_transcript
 *   entrepreneur
 *   biofuels
 *   7
 *   7.3
 *   2 min" | npm run flow                                      (scripted run)
 */

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const { runTool } = await import('../src/mcp/tools/index.ts');

/**
 * Answers come from a terminal when there is one, and from piped stdin otherwise.
 *
 * They are read differently rather than through one path because readline drops
 * buffered lines when stdin is a pipe: a scripted run would silently answer the
 * first question and then hang on the second.
 */
const interactive = Boolean(stdin.isTTY);
const rl = interactive ? readline.createInterface({ input: stdin, output: stdout }) : null;
const queued = [];

if (!interactive) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  queued.push(
    ...chunks
      .join('')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
}

async function ask(prompt) {
  if (rl) return rl.question(prompt);
  const next = queued.shift() ?? 'quit';
  console.log(`${prompt}${next}`);
  return next;
}

/** Tool results are JSON in the last content block; text output is in the first. */
function parse(result) {
  const last = result.content[result.content.length - 1]?.text ?? '{}';
  return {
    json: last.trimStart().startsWith('{') ? JSON.parse(last) : {},
    body: result.content[0]?.text ?? '',
    isError: result.isError ?? false,
  };
}

async function call(name, args = {}) {
  return parse(await runTool(name, args));
}

const bar = (ch = '-') => console.log(ch.repeat(72));

function renderStep(step) {
  console.log();
  bar('=');
  console.log(`STEP: ${step.step}${step.flow ? `   FLOW: ${step.flow}` : ''}`);
  bar('=');
  if (step.error) console.log(`\n!! ${step.error}\n`);
  console.log(step.prompt);
  if (step.options?.length) {
    console.log();
    for (const option of step.options) {
      const mark = option.disabled ? ' [unavailable]' : '';
      console.log(`  ${option.value.padEnd(24)} ${option.label}${mark}`);
      if (option.detail) console.log(`  ${' '.repeat(24)} ${option.detail}`);
      if (option.blocker) console.log(`  ${' '.repeat(24)} -> ${option.blocker}`);
    }
  }
  if (step.next_action) console.log(`\n(${step.next_action})`);
}

/** The video branch ends with a module package plan: 18 segments and 14 slides. */
function renderModulePlan(plan) {
  console.log();
  bar('=');
  console.log(`MODULE PACKAGE  |  Module ${plan.module_number} - ${plan.module_title}`);
  console.log(
    `3:00 video in ${plan.video.segment_count} x ${plan.video.segment_seconds}s segments  |  ` +
      `9:00 deck of ${plan.slides.slide_count} slides (max ${plan.slides.max_slide_seconds}s each)  |  ` +
      `${plan.units.length} units covered`,
  );
  bar('=');
  if (plan.coverage_note) console.log(`\nNOTE: ${plan.coverage_note}\n`);

  if (plan.content_map.module_outcomes.length > 0) {
    console.log(`LEARNING OUTCOMES (${plan.content_map.module_outcomes.length}, from the handbook)`);
    bar();
    for (const o of plan.content_map.module_outcomes.slice(0, 6)) console.log(`  - ${o.slice(0, 88)}`);
    if (plan.content_map.module_outcomes.length > 6) console.log(`  ... and ${plan.content_map.module_outcomes.length - 6} more`);
    console.log();
  }
  console.log('UNIT COVERAGE');
  bar();
  for (const unit of plan.units) {
    console.log(
      `  ${unit.unit_code.padEnd(5)} ${unit.unit_title.slice(0, 44).padEnd(46)} ` +
        `segments ${unit.video_segments.join(',') || '-'}  slides ${unit.slides.join(',') || '-'}`,
    );
  }

  console.log('\nVIDEO SEGMENTS  (story beat + the handbook material it dramatises)');
  bar();
  let part;
  for (const s of plan.video.segments) {
    if (s.part !== part) {
      part = s.part;
      const spec = plan.video.parts.find((p) => p.part === part);
      console.log(`  -- PART ${part}: ${spec.name.toUpperCase()} (${spec.seconds}s) --`);
    }
    console.log(
      `  ${String(s.segment_number).padStart(2)}  ${s.start_timecode}-${s.end_timecode}  ` +
        `${s.story.beat.slice(0, 30).padEnd(32)} ${String(s.min_words + '-' + s.max_words + 'w').padEnd(9)} ` +
        `${s.part === 2 ? `unit ${s.allocation.unit_code}` : 'whole module'}` +
        `${s.introduces_unit ? '  [OPENS UNIT]' : ''}`,
    );
  }

  console.log('\nSLIDES');
  bar();
  for (const s of plan.slides.slides) {
    console.log(
      `  ${String(s.slide_number).padStart(2)}  ${String(s.seconds + 's').padEnd(5)} ` +
        `${s.role.padEnd(7)} ${String(s.min_notes_words + '-' + s.max_notes_words + 'w notes').padEnd(16)} ` +
        `${s.role === 'body' ? `unit ${s.allocation.unit_code}` : 'whole module'}` +
        `${s.introduces_unit ? '  [OPENS UNIT]' : ''}`,
    );
  }
}

/** The per-unit transcript plan, still available through the direct tools. */
function renderPlan(plan) {
  console.log();
  bar('=');
  console.log(`SCENE PLAN  |  Unit ${plan.unit_code} - ${plan.unit_title}`);
  console.log(
    `${plan.requested_duration} target  |  ${plan.scene_count} scenes  |  ` +
      `${plan.total_target_words} words @ ${plan.words_per_minute} wpm`,
  );
  console.log(
    `Source: Participant Handbook pp. ${plan.source.pdf_page_start}-${plan.source.pdf_page_end} ` +
      `(${plan.source.word_count} words)`,
  );
  bar('=');
  if (plan.coverage_note) console.log(`\nNOTE: ${plan.coverage_note}`);

  for (const scene of plan.scenes) {
    console.log();
    console.log(
      `SCENE ${scene.scene_number} | ${scene.role.toUpperCase()} | ` +
        `${scene.start_timecode}-${scene.end_timecode} (${scene.seconds}s) | ` +
        `${scene.min_words}-${scene.max_words} words`,
    );
    bar();
    console.log(`PURPOSE: ${scene.purpose}`);
    console.log(`CITE   : ${scene.source_chunk_ids.join(', ') || '(none)'}`);
    console.log('HANDBOOK TEXT FOR THIS SCENE:');
    console.log(scene.source_text.replace(/^/gm, '  '));
  }
}

async function walk(sessionId) {
  for (;;) {
    const answer = (await ask('\n> ')).trim();
    if (!answer) continue;
    if (['quit', 'exit', 'q'].includes(answer.toLowerCase())) return;

    const { json: step, isError } = await call('flow_choose', {
      session_id: sessionId,
      choice: answer,
    });
    if (isError) {
      console.log(`\n!! ${step.message}`);
      continue;
    }

    renderStep(step);

    if (step.step === 'reading_complete') {
      console.log();
      console.log(step.data.rendered);
      return;
    }
    if (step.step === 'module_ready') {
      renderModulePlan(step.data.plan);
      console.log();
      bar('=');
      console.log(
        `Package ${step.data.package_id} is at version ${step.data.base_version}.\n` +
          'Write it with submit_module_video (18 segments) and submit_module_slides (14 slides),\n' +
          'then validate_module_package, get_module_video_script and render_module_pptx.\n' +
          'This runner writes no content -- the server holds no model.',
      );
      bar('=');
      return;
    }
    if (step.done) return;
  }
}

/** `npm run flow -- "<heading>"` skips the menus, as the shortcut flow does. */
async function shortcut(heading) {
  const found = await call('find_ph_unit', { heading });
  if (found.isError || !found.json.candidates?.length) {
    console.log(found.json.message ?? `No unit matches "${heading}".`);
    return;
  }
  console.log(`\nCandidates for "${heading}" (confident: ${found.json.confident}):\n`);
  for (const candidate of found.json.candidates) {
    console.log(
      `  ${String(candidate.score).padEnd(6)} ${candidate.subject_code} ` +
        `Unit ${candidate.unit.unit_code} - ${candidate.unit.title}`,
    );
  }
  if (!found.json.confident) {
    console.log('\nToo close to call. Re-run with the exact unit title.');
    return;
  }

  const top = found.json.candidates[0];
  const what = (await ask('\nRead the exact handbook text, or plan a video? [read/video] '))
    .trim()
    .toLowerCase();

  if (what.startsWith('r')) {
    const reading = await call('read_ph_unit', {
      subject: top.subject_id,
      unit_code: top.unit.unit_code,
    });
    console.log(`\n${reading.body}`);
    return;
  }

  const duration = (await ask('Video duration (e.g. "2 min"): ')).trim();
  const planned = await call('plan_video_transcript', {
    subject: top.subject_id,
    unit_code: top.unit.unit_code,
    duration,
  });
  if (planned.isError) {
    console.log(`\n!! ${planned.json.message}`);
    return;
  }
  renderPlan(planned.json.plan);
  console.log(
    `\nTranscript ${planned.json.transcript_id}, base_version ${planned.json.base_version}.`,
  );
}

const heading = process.argv.slice(2).join(' ').trim();
try {
  if (heading) {
    await shortcut(heading);
  } else {
    const { json: start } = await call('start_flow');
    renderStep(start);
    console.log('\nType an option value, or "back", "restart", "quit".');
    await walk(start.session_id);
  }
} finally {
  rl?.close();
}
