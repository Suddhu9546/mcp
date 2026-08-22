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

It does three separate things. They share no state and no numbering, and mixing them
produces wrong output.

  1. STORYBOARD        A course storyboard and assessment blueprint, as a .docx.
  2. VIDEO SCRIPT      A video script and slide deck for one handbook module.
  3. HANDBOOK READING  One unit of a handbook, word for word.

HOW TO USE THIS SERVER
----------------------
Every result carries a "next_call" object naming the exact tool and arguments for the
following step. Follow it. You do not need to plan a sequence, remember where you are,
or work out when a job is finished -- the server tracks all of that and tells you. When
a result carries next_call, calling anything else is a mistake.

Call start_flow whenever the user has not clearly named one of the three -- including
openers like "hi", "hello", "start", "lets start", "can we start", "i want to generate
a storyboard", "how can you help me", "what can you do" -- and again whenever they
finish one thing and want another. Print the three options exactly as returned and
wait. Add no preamble, no explanation of the options, no recommendation and no question
of your own, and begin no work until the user picks one.

Then answer each step with flow_choose, passing what the user said. Each step asks one
question and shows its own options; show them as given and add nothing. "back" changes
the last answer, "restart" returns to the menu. A step that reports done has asked
everything it needs: follow its next_action and generate, with no confirmation question.

1. STORYBOARD
-------------
Three answers -- menu, programme, subject -- then generate.

  flow_choose "1"              -> which programme: Entrepreneur, Orientation, CDR
  flow_choose the programme    -> which subject of it
  flow_choose the subject      -> done; the storyboard begins

The three programmes produce the same kind of document under the same rules, and each
has its own template, applied automatically from the subject that was chosen. They
differ only in where each module's sources come from. Never carry a subject from one
programme into another.

Then one loop, which you run without the user:

  create_storyboard_draft      -> artifact_id
  storyboard_next_module       -> status WRITE_THIS and one whole module
  repeat:
    write every slot the module lists, from the text in module.sources,
    citing chunk_ids from module.sources,
    storyboard_submit_module   -> commits and returns the NEXT module
  until status is READY_TO_RENDER
  validate_storyboard -> render_storyboard_docx -> give the user the .docx

The loop needs no planning from you. Each module arrives with its rows, segments,
slides, question count and glossary quota enumerated, and its source material attached
once -- so you never choose a module, a row, a search query or a citation, and an
out-of-scope citation is not reachable by following the loop.

Each module also contributes a few glossary_terms: the technical, financial,
regulatory and operational terms and abbreviations that module's own sources use.
They are merged into one alphabetical Glossary of Terms and Abbreviations at the end
of the document, so define a term once and do not repeat one an earlier module
already defined.

One call per module. A course is 5 to 10 of them, so write the whole module in one
reply and submit it in one call: that is what keeps a storyboard to minutes rather
than an hour. Do not call storyboard_next_module again before submitting, do not split
a module across several submissions unless a reply was cut short, and do not search
for extra sources -- everything citable is already in module.sources.

If a reply is truncated, submit what you have. Partial submissions are committed, and
the next call returns only the slots still blank, so nothing is lost and nothing is
rewritten.

Do not stop between modules to summarise, do not ask the user whether to continue, and
do not render before READY_TO_RENDER. create_storyboard_draft returns an EMPTY
skeleton: showing the user that draft, or a list of these steps, does not answer the
request. The request is answered when render_storyboard_docx returns a .docx and you
have given it to them.

Rules:
  - Content may come only from module.sources. Retrieval is scoped per course;
    another course's documents cannot be reached.
  - Timing is read-only, and comes only from the course's own timing authority.
    Parts B and C are 15 minutes each and are spent out of the module's own time, so
    Part A is the module total less half an hour. That is the template's arithmetic;
    do not restate or recompute a duration.
  - Where the approved documents cannot support content, the correct outcome is
    INSUFFICIENT_SOURCE_CONTENT, not invented material. An Employability Skills module
    that its handbook defers to an external DGT workbook has no source content; the
    task queue skips such a module rather than offering it as work.
  - Never specify fonts, colours, text size, table structure or layout. The template is
    reproduced exactly and formatting is preserved by construction, so anything you say
    about it is at best ignored.
  - The three wrong options of a question are authored, not sourced. They must be
    plausible and must not assert any fact the sources do not state.

2. VIDEO SCRIPT
---------------
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
  - Write to each word budget. Ten seconds holds about 23 words and one idea;
    narration that overruns is cut off by the generator.
  - Every unit must be covered by the video AND by the deck, in handbook order.
  - The 18 segments are one film: each continues the last and hands to the next.
  - Never describe colours, backgrounds or fonts; the deck's design is applied.
  - The script never mentions its source. No handbook, page, figure, table, unit or
    module number, and no QR code, in any title, visual, on-screen text or narration.
  - Deliver both: the script text inline, and the files.

  Outside the flow, plan_video_transcript writes a single-unit script of a custom
  length, for a user who asks for exactly that.

3. HANDBOOK READING
-------------------
Three answers -- subject, module, unit -- then read_ph_unit and return its text
unchanged.

This is not a generation task. Do not summarise, rewrite, shorten, re-order, correct,
comment on or add to it, and do not offer to. If the user then wants a video, that is
feature 2 on a fresh flow, not a rewrite of this text.

NUMBERING WARNING
-----------------
"Module" means the Participant Handbook's chapter number in features 2 and 3, because
that is what the user is shown and picks. In feature 1 it means the timing document's
module number, and for some courses the two disagree. Never carry a module number from
one feature into another; get_ph_outline reports the timing number separately as
timing_module.
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
