#!/usr/bin/env node
/**
 * Storyboard MCP server -- stdio transport.
 *
 * This process contains no AI model and holds no AI credentials. It exposes
 * deterministic tools over MCP; the connected client (Antigravity, Gemini CLI,
 * Claude Code) provides all reasoning, orchestration and generated content.
 *
 * stdout is the MCP wire protocol, so nothing may be written to it. All logging
 * goes to stderr via the shared logger.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS, runTool } from './tools/index.js';
import { ensureAllCoursesRegistered } from '../courses/course-manager.js';
import { closeDb } from '../storage/db.js';
import { logger } from '../util/logger.js';

const SERVER_INSTRUCTIONS = `
Deterministic tool layer for SCGJ educational content. This server holds no AI model
and no credentials: you supply the words, it supplies scoped source material,
authoritative timing, template handling, validation and files.

It does four separate things. They share no state and no numbering, and mixing them
produces wrong output.

  1. MODULE CONTENT     A video script and a slide deck for one handbook module.
  2. STORYBOARD         A qualification course storyboard, as a .docx.
  3. EXACT PH READING   One unit of a handbook, word for word.
  4. CDR STORYBOARD     A Carbon Dioxide Removal course storyboard, as a .docx.

Features 2 and 4 produce the same document to the same template under the same
rules. They differ only in where the content comes from, and they are separate menu
items because the courses are separate: Biofuels and Solar PV are qualification
courses, CDR Biochar is not, and offering one where the other belongs would build a
storyboard from the wrong documents.

HOW TO USE THIS SERVER
----------------------
Every result carries a "next_call" object naming the exact tool and arguments for the
following step. Follow it. You do not need to plan a sequence, remember where you are,
or work out when a job is finished -- the server tracks all of that and tells you. When
a result carries next_call, calling anything else is a mistake.

Call start_flow whenever the user has not clearly named one of the three -- including
openers like "can we start", "let's start", "show me what you have", "what can you do",
"hi" -- and again whenever they finish one thing and want another. Show the user the
three options and wait. Ask no question of your own, and begin no work, until they pick.

Then answer each step with flow_choose, passing what the user said. The flow asks only
what it cannot work out: after the menu, the subject, and for features 1 and 3 the
module. It never asks how the user wants to choose, which course type, or how long the
output should be -- do not ask those either. A step that reports done has asked
everything it needs: follow its next_action and generate, with no confirmation
question. "back" changes the last answer, "restart" returns to the menu.

A user who names their topic up front can skip the menu: plan_module_content takes a
topic, read_ph_unit takes a heading, and a topic typed at any flow step resolves to
the unit that holds it.

1. MODULE CONTENT
-----------------
Two answers from the user -- subject, then module -- then generate.

12 minutes for one module: a 3-minute video in eighteen 10-second segments, plus a
9-minute deck of as many slides as the module needs, none over 30 seconds. Part 1
(segments 1-6) orients to the whole module from its stated learning outcomes, Part 2
(7-15) teaches every unit in handbook order, Part 3 (16-18) consolidates.

  plan_module_content       the parts, the deck size, and per item its story beat,
                            its unit and its word budget
  get_module_content_spec   what to write into a segment and into a slide
  get_module_source         the handbook text behind each slot
  set_module_story          the film's constants -- BEFORE any segment
  submit_module_video       all 18 segments together
  submit_module_slides      every slide the plan asked for
  validate_module_package   fit, unit coverage, citations, source leaks
  export_module_package     writes the .txt script, .srt subtitles, .pptx and .txt
                            deck and returns the paths. GIVE THEM to the user

Rules:
  - Only the Participant Handbook grounds the content. Add no statistic, standard,
    price, date, brand or regulation the units do not state.
  - Presentation is yours: hooks, analogies, transitions, visual direction, pacing.
    That is what makes it a video and a deck rather than a reading.
  - Write to each word budget. Ten seconds holds about 23 words and one idea;
    narration that overruns is cut off by the generator.
  - Every unit must be covered by the video AND by the deck, in handbook order, as
    the plan allocates. A segment or slide opening a unit must say what the unit is
    about, not merely announce it.
  - The 18 segments are one film: each continues the last and hands to the next. The
    deck is not the video written down -- it teaches where the video motivates.
  - Never describe colours, backgrounds or fonts; the deck's design is applied.
  - The script never mentions its source. No handbook, page, figure, table, unit or
    module number, and no QR code, in any title, visual, on-screen text or narration.
    Citations live in scenes[].sources and are omitted from the rendered script.
  - Deliver both: the script text inline, and the files.

  Outside the flow, plan_video_transcript writes a single-unit script of a custom
  length, for a user who asks for exactly that.

2. STORYBOARD
-------------
One answer from the user -- the subject -- then a loop you run without them.

  create_storyboard_draft      -> artifact_id
  storyboard_next_task         -> status WRITE_THIS and one task
  repeat:
    write the fields listed in task.fields, from the text in task.sources,
    citing chunk_ids from task.sources,
    storyboard_submit_task     -> commits and returns the NEXT task
  until status is READY_TO_RENDER
  validate_storyboard -> render_storyboard_docx -> give the user the .docx

The loop needs no planning from you. Each task names the module, the section and the
exact fields, and carries the handbook text to write them from, already scoped to the
right chapter -- so you never choose a module, a row, a search query or a citation,
and a wrong-chapter citation is not reachable by following the queue.

A course is 100-130 tasks. That is expected and each is small. Do not stop between
them to summarise, do not ask the user whether to continue, and do not render before
READY_TO_RENDER. create_storyboard_draft returns an EMPTY skeleton: showing the user
that draft, or a list of these steps, does not answer the request. The request is
answered when render_storyboard_docx returns a .docx and you have given it to them.

set_storyboard_content and set_assessment_content still take hand-built patches and
remain available, but the task loop is the path to prefer.

Rules:
  - Content may come only from the course's QP, PH and FG. Retrieval is scoped per
    course; another course's documents cannot be reached.
  - Timing comes only from the Timing Allocation Document and is read-only.
  - Where the approved documents cannot support content, the correct outcome is
    INSUFFICIENT_SOURCE_CONTENT, not invented material. Biofuels module 8
    (Employability Skills) has no source content in the supplied documents; the task
    queue skips such a module rather than offering it as work.
  - Never specify fonts, colours, table structure or layout; formatting is preserved.
  - The three wrong options of a question are authored, not sourced. They must be
    plausible and must not assert any fact the sources do not state.

4. CDR STORYBOARD
-----------------
One answer from the user -- which CDR course -- then the same loop as feature 2:

  create_storyboard_draft -> storyboard_next_task -> [write, storyboard_submit_task]*
  -> validate_storyboard -> render_storyboard_docx -> give the user the .docx

Every storyboard rule holds unchanged: the same SCGJ template, the same colours,
fonts, layout and structure, the same citation requirements, the same refusal to
invent content the sources do not carry. Do not treat a CDR storyboard as a
different kind of document.

What differs is the sources. A qualification course draws every module from one
Participant Handbook, scoped by chapter. A CDR course has no handbook: it has nine
unrelated reference documents and a master file that states, per module, which of
them that module is built from and how long it runs. The master file is also the
timing authority -- there is no separate Timing Allocation Document.

You do not apply that routing yourself. The task loop already scopes each task to
the documents its module is assigned, so every chunk a task offers is from the right
document and citing any of them is correct. Do not search across the other reference
documents for a module, and never cite one module's document in another module.

The master file is not retrievable content. It states routing and duration, not
subject matter, and is deliberately not indexed: nothing in it may be cited as
though it were teaching material.

A CDR course is only offered once every document its master file names is on disk.
Where one is missing the flow names the exact filenames it is waiting for -- pass
those on verbatim, because they are what the user has to supply.

3. EXACT PH READING
-------------------
Three answers -- subject, module, unit -- then read_ph_unit and return its text
unchanged.

This is not a generation task. Do not summarise, rewrite, shorten, re-order, correct,
comment on or add to it, and do not offer to. If the user then wants a video, that is
feature 1 on a fresh flow, not a rewrite of this text.

NUMBERING WARNING
-----------------
"Module" means the Participant Handbook's chapter number in features 1 and 3, because
that is what the user is shown and picks. In feature 2 it means the Timing Allocation
Document's module number, and for some courses the two disagree. Never carry a module
number from one feature into another; get_ph_outline reports the timing number
separately as timing_module.
`.trim();

async function main(): Promise<void> {
  const server = new McpServer(
    { name: 'cvc-storyboard-mcp', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: Record<string, unknown>) => {
        const started = Date.now();
        // runTool converts thrown errors into error results, so the client always
        // receives a readable explanation rather than a protocol failure.
        const result = await runTool(tool.name, args ?? {});
        logger
          .child({ tool_name: tool.name })
          .info({ duration_ms: Date.now() - started, is_error: result.isError ?? false }, 'tool completed');
        return result;
      },
    );
  }

  // Registering configured courses up front means list_courses works on a fresh
  // database, before anything has been ingested.
  ensureAllCoursesRegistered();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ tools: TOOLS.length }, 'storyboard MCP server ready on stdio');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    closeDb();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'server failed to start');
  process.exit(1);
});
