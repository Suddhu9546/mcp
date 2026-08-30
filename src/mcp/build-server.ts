/**
 * Server construction -- shared by every transport.
 *
 * The MCP server object, its instructions and its tool registrations live here
 * rather than in an entrypoint, because stdio and Streamable HTTP need the same
 * server built the same way. An entrypoint chooses a transport; it does not
 * decide what the server is.
 *
 * This process contains no AI model and holds no AI credentials. It exposes
 * deterministic tools over MCP; the connected client (Antigravity, Gemini CLI,
 * Claude Code) provides all reasoning, orchestration and generated content.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOLS, runTool } from './tools/index.js';
import { logger } from '../util/logger.js';

const SERVER_INSTRUCTIONS = `
Deterministic tool layer for SCGJ educational content. This server holds no AI model
and no credentials: you supply the words, it supplies scoped source material,
authoritative timing, template handling, validation and files.

It does three separate things. They share no state and no numbering, and mixing
them produces wrong output.

  1. STORYBOARD        A course storyboard and assessment blueprint, as a .docx.
  2. VIDEO SCRIPT      A 2.5-3 minute AI info video for one handbook module.
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
A 150-180 second educational introduction to one Participant Handbook module, for an
LMS. Long enough to introduce the WHOLE module: every learning area is named and
given something concrete. Five answers from the user, then generate.

  flow_choose "2"            -> which course: Entrepreneur or Orientation
  flow_choose the course     -> which subject of it
  flow_choose the subject    -> which module, read from that subject's handbook
  flow_choose the module     -> which video type
  flow_choose the type       -> the presenter, then the background
                                (or "use saved profile?" when one exists)

The presenter questions are five and are asked in ONE message: gender, age, skin
tone, demographic appearance, attire, in that order, comma separated. Show all five
with their numbered options together, show both attire lists and say which gender
each is for, and pass the user's whole reply through unchanged. Then one more
question for the background environment. All six are saved as the video profile and
reused, so later modules are only offered "use saved profile?".

Generation is TWO calls, and no more:

  plan_video_script       15-18 scenes of 10 seconds, their 22-25 word band, what
                          each must achieve, the slice of handbook text behind it,
                          the locked presenter, and the rules -- all at once
  submit_video_script     all the scenes together. It validates them, composes each
                          scene's AI generation prompt, writes the file and returns
                          the finished script

Nothing else needs calling. The flow's final step already carries the plan, so a
client that followed the flow submits straight from it.

FOUR HARD RULES, all checked and all rejected if broken:
  1. Every scene is exactly 10 seconds. None may run longer.
  2. Every scene's narration is 22-25 words. Not fewer, not more.
  3. Every sentence begins AND ends inside one scene. Never leave a clause or a
     thought for the next scene to finish, and never open a scene by completing the
     previous one -- each scene is generated as its own clip, so a sentence that
     spans two of them breaks. End on a full stop, never on "and", "so", "to" or a
     comma, and never on a fragment.
  4. At most 3 sentences a scene, so the breath between them and the half-second
     before the cut have somewhere to fit.

Rules:
  - The chosen module of the Participant Handbook is the only source of what is
    taught. Add no statistic, price, date, standard, regulation or brand it does
    not state, and take nothing from another module or subject.
  - It is an educational video, not a film. The topic is the hero; the presenter is
    a teacher. No backstory, no drama, no conversation, no cinematic set pieces.
  - Each learning area gets two or three consecutive scenes and each of those gets
    its own slice of the area's text. Write each scene from its own slice: the
    second scene of an area continues it, it does not re-introduce it.
  - Scene 1 opens with a spoken "Namastey".
  - Do NOT write the presenter's appearance, clothing, voice, accent, pace, the
    pause timings or the audio-accuracy instructions into any field. The server
    stamps them into every scene prompt identically, which is what keeps the
    presenter one person and every clip's delivery the same.
  - On-screen spelling is the commonest defect in the finished video. Every scene
    prompt carries an ACCURACY block naming exactly which text may appear -- the
    caption and the visual's labels, and nothing else -- and forbidding invented
    background lettering. That block is built from on_screen_text and
    educational_visual_elements, so write those as the exact words that should
    appear. Name a diagram's labels explicitly: "a labelled chart" leaves the
    generator to invent them, which is where nonsense words come from.
  - Show what is being explained. A scene that could show the equipment, the
    diagram or the reading and shows a generic background has wasted itself.
  - Never mention the handbook, a page, a figure, a unit or module number or a QR
    code in anything a viewer sees or hears. Citations go in "sources".
  - Give the user the file and the per-scene prompts: each one is one generation.

  Only the 2.5-3 minute info video is built. The 15-minute unit video is offered in
  the menu and refused, so the user is told rather than left wondering.

3. HANDBOOK READING
-------------------
Three answers -- subject, module, unit -- then read_ph_unit and return its text
unchanged.

This is not a generation task. Do not summarise, rewrite, shorten, re-order, correct,
comment on or add to it, and do not offer to.

NUMBERING WARNING
-----------------
"Module" means the Participant Handbook's chapter number in features 2 and 3, because
that is what the user is shown and picks. In feature 1 it means the timing document's
module number, and for some courses the two disagree. Never carry a module number from one
feature into another; get_ph_outline reports the timing number separately as
timing_module.
`.trim();

/**
 * Builds a fully-registered MCP server.
 *
 * One of these is created per client session. The tool layer itself is
 * stateless -- every tool reads and writes the shared database -- so several
 * concurrent servers are safe and hold nothing between them.
 */
export function createStoryboardServer(): McpServer {
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

  return server;
}

/** Tool count, for a transport that wants to report readiness. */
export const TOOL_COUNT = TOOLS.length;
