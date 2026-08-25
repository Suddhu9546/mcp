/**
 * Interactive walkthrough of the guided flow, for driving it by hand.
 *
 * This is a thin terminal front-end over the same tools an MCP client calls --
 * start_flow, flow_choose, read_ph_unit. It adds no logic of its own, so what you
 * see here is exactly what a client sees.
 *
 * Usage:
 *   npm run flow
 *   npm run flow -- "quality control and testing of pellets"   (heading shortcut)
 *   echo "ph_reading
 *   biofuels
 *   7
 *   7.3" | npm run flow                                        (scripted run)
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
  const reading = await call('read_ph_unit', {
    subject: top.subject_id,
    unit_code: top.unit.unit_code,
  });
  console.log(`\n${reading.body}`);
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
