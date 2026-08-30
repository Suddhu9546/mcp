# CVC Storyboard MCP

A deterministic **tool layer** for SCGJ educational content: course storyboards as
DOCX, 2.5-3 minute AI info video scripts per module, and exact Participant Handbook
readings.

This server contains **no AI model and no AI API key**. It executes operations and
returns structured results. All reasoning, orchestration and content generation
happen in the connected client.

```
Antigravity IDE / Gemini CLI / Claude Code
        │   reasoning, orchestration, content generation
        ▼   MCP (stdio)
Storyboard MCP
        │
        ▼
Deterministic tools
  source retrieval (BM25)      timing parsing + validation
  template analysis            module crosswalk
  storyboard state + versions  DOCX clone + insert + export
  handbook outline + reading   video profile + character lock
  scene planning + word budgets  script validation + prompt composition
```

| | Client (Gemini / Antigravity) | This server |
|---|---|---|
| Which tools to call | ✔ | |
| In what order | ✔ | |
| What content to write | ✔ | |
| How to fix validation errors | ✔ | |
| Scoped source retrieval | | ✔ |
| Authoritative durations | | ✔ |
| Template fidelity | | ✔ |
| Validation findings | | ✔ |
| DOCX generation | | ✔ |
| Scene budgets, self-containment and presenter consistency | | ✔ |

## The three flows

They are kept strictly apart. A session records which flow it is in, and the tools
of one flow cannot produce the output of another.

```
                start_flow   ← "hi", "start", "can we start", "let's get started"
                     │
     ┌───────────────┼───────────────────────────┐
     ▼               ▼                           ▼
1 Storyboard   2 Video Script          3 Handbook Reading
     │               │                           │
     ▼               ▼                           ▼
  programme       course                      subject
Entrepreneur   Entrepreneur                      │
Orientation    Orientation                       ▼
    CDR            │                          module
     │             ▼                             │
     ▼          subject                          ▼
  subject          │                            unit
     │             ▼                             │
     │          module                           ▼
     │             │                     reading_complete
     │             ▼
     │        video type
     │             │
     │             ▼
     │      presenter ×5 in one answer
     │             │
     │             ▼
     │        background
     │             │
     ▼             ▼
storyboard_ready  video_script_ready
generation begins  generation begins
```

The menu is three lines and nothing else: what each option produces is answered by
the step that follows it, and explaining them up front made the first thing a user
saw a wall of text about choices they had not made yet.

Only the storyboard asks which programme, and it asks first, because the three
tracks are genuinely different documents — a different template, different sources,
different module routing — and everything after that answer depends on it. The
video flow asks its own course question over a different list — two options, not
three, because CDR has no Participant Handbook and a video is built from one. The
reading flow does not ask at all: a subject carries its own track.

The subject is the storyboard's last question. Nothing is asked about length,
modules, format or confirmation, because none of it is open: the course's module
count comes from its timing document, the shape from its template, and the loop
that fills it runs without the user.

The flow asks only what it cannot work out. There is no "would you like to type or
browse" question and no course-type question: a topic typed at any step is resolved
to the unit that holds it, and course type is a label on each subject.

The video flow stops at the background question. Everything below it is settled:
150-180 seconds, 15-18 scenes of ten seconds, and which slice of which unit each
scene introduces. No duration question is asked because there is nothing to choose
— the four hard rules fix it. A scene shorter than ten seconds cannot hold
twenty-two words, so every scene is ten; 150-180 seconds of those is 15-18 scenes.

Reading goes one level deeper than the module, to the unit, and returns its verbatim
text. No generation step exists on that path.

**What a video is.** One 150-180 second introduction covering the whole module, as
15-18 scenes, each a separate generation:

| | |
|---|---|
| Structure | opening → what the topic is (×2) → turn to learning → 9-12 learning-area scenes → consolidation → hand-over |
| Scene seconds | every scene exactly 10s. 15 scenes = 150s, 18 = 180s |
| Narration | 22-25 words per scene, ~150 wpm, at most 3 sentences |
| Breathing | 0.3-0.5s between sentences, 0.5s of silence before the cut |
| Self-contained | every sentence begins **and** ends inside its own scene |
| Unit coverage | each learning area gets 2-3 consecutive scenes, each with its own slice of that area's text |
| Each scene carries | purpose, location, visual, presenter action, camera framing and movement, teaching visuals, narration, citations |
| The server adds | the presenter, attire, voice, pace, pauses and speak-once directives — identically, every scene |
| Output | the script inline **and** a `.txt` file, plus one ready-to-paste generation prompt per scene |

The presenter comes from a saved **video profile** — gender, age, skin tone,
demographic appearance, attire, background — asked once and reused, so a learner
taking several modules of a course meets the same instructor.

Say **`restart`** at any step, finished ones included, to clear the session and go
back to the menu. **`back`** changes the previous answer. `start_flow` opens an
independent session whenever you want one.

**Shortcut.** A user who names a topic skips the menus: `read_ph_unit` takes a
heading, and `plan_video_script` takes a subject and a module directly.

**Subjects.** Nine across three programmes. Each reports exactly what it is
waiting for, and the flow offers only the ones it can serve.

| Entrepreneur | Orientation | CDR |
|---|---|---|
| Solar Photovoltaic ✅ | ESG — Environmental, Social and Governance | CDR Biochar |
| Bio-Energy (Biofuels) ✅ | GHG — Greenhouse Gas | |
| Green Hydrogen ✅ | GL — Green Logistics | |
| Agri-Residue Aggregator ✅ | BG — Biogas | |

✅ means a storyboard builds today: four approved documents on disk and a reviewed
crosswalk. All four Entrepreneur subjects qualify. The Orientation subjects have
their documents but no reviewed crosswalk yet; CDR's is blocked on its rewritten
master file (see Known gaps).

**Adding a subject: drop the PDFs in and pick it from the menu.** Put `ph.pdf`
(and `qp.pdf`, `fg.pdf`, `timing.pdf` for storyboards) into
`courses/<track>/<subject>/`, and name that path in the course's `directory` in
[`src/courses/course-config.ts`](src/courses/course-config.ts). A handbook that is
present but not yet indexed shows in the menu as a normal choice and is indexed the
first time it is picked, which takes a few seconds once. Modules and units are
derived from the handbook itself, so nothing about its structure is declared in
code.

The folder need not be named for the `course_id` — Solar's documents arrive in
`courses/entrepreneur/solar` while the course is `solar-pv` — because `directory`
states the path outright. That is preferred to renaming the folder, because the
folder is the thing that keeps arriving.

**Templates are per track.** Each track renders to `templates/<track>/`, and the
template is chosen from the subject rather than passed in, so a course cannot be
built to another track's document. The Entrepreneur and Orientation templates are
not interchangeable: Orientation's carries an Instructional Design and Behavioral
Analytics section that Entrepreneur's does not, and the table of contents is
derived from whichever template is in use rather than assumed.

Module titles come from the handbook's own chapter headings where it prints them.
A handbook that jumps straight to its first unit leaves modules titled `Module 3`;
the menu then lists each module's unit titles, rather than inventing a title the
handbook never gave. Filling in `chapter_titles` for that course replaces them.
(A storyboard additionally needs a reviewed crosswalk.)

## Setup

Requires **Node 22.13+** (for the built-in `node:sqlite`). No native compilation,
no API keys.

```bash
npm install
cp .env.example .env
```

Then index the course documents once:

```bash
npm run ingest -- solar-pv
```

### Add to Antigravity

Add this to your Antigravity MCP configuration:

```json
{
  "mcpServers": {
    "storyboard": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "C:\\cvc-mcp"
    }
  }
}
```

For a compiled server, run `npm run build` and use
`"command": "node", "args": ["dist/src/mcp/server.js"]`.

The same config works for Gemini CLI and Claude Code — all three speak MCP over
stdio.

### Run over HTTP instead

The same server also speaks **Streamable HTTP**, for the case where it is hosted
once and connected to from anywhere rather than spawned per client:

```bash
npm run build
npm run start:http
```

That serves the protocol at `POST/GET/DELETE /mcp` and a `/healthz` endpoint
that reports the listener without touching the database. `npm run dev:http` does
the same from source. Setting `MCP_TRANSPORT=http` is equivalent to the `--http`
flag; `PORT` (or `MCP_PORT`), `MCP_HOST` and `MCP_PATH` control where it listens.

Both transports expose exactly the same 35 tools — `src/mcp/build-server.ts`
builds the server and the entrypoint only picks how it is reached. Sessions hold
protocol state only: flows, drafts and artifacts live in the database, so a
client that reconnects finds its work where it left it and a restart costs
nothing but the open connections.


### Authentication

Under stdio there is nothing to authenticate — the client spawned the process.
Over HTTP the endpoint is public, and behind it are all 35 tools and the whole
indexed corpus, so a bearer token is required:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set it as `MCP_AUTH_TOKEN` (minimum 16 characters). **HTTP mode refuses to
start** with neither that nor `MCP_ALLOW_ANONYMOUS=true` set, so an open
endpoint cannot result from a forgotten variable. `MCP_AUTH_TOKENS` takes a
comma-separated list, which is how a token is rotated without a gap or issued
per client so it can be revoked alone.

Clients send it as a header:

```bash
claude mcp add --transport http storyboard https://YOUR-SERVICE.onrender.com/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

Authentication is checked before the body is read and before a session is
looked up, so a leaked `mcp-session-id` is not on its own usable. `/healthz`
stays unauthenticated — a platform health check cannot carry a token — and
reports only that the process is up; the session count is added for a caller
that has authenticated.

This is a shared secret, not OAuth. OAuth would mean persisting registered
clients and issued tokens, and on a free host with an ephemeral filesystem that
store is erased on every spin-down, which would break every connected client
whenever the service idled. A consequence worth knowing: the **claude.ai custom
connector UI expects OAuth**, so this server connects from header-capable
clients — Claude Code, Antigravity, Gemini CLI — rather than from that UI.

### Getting the generated files

Locally this is a non-question: `render_storyboard_docx` returns `docx_path` and
the file is on the same machine. Hosted, it is on the server's filesystem and
the person who asked is somewhere else, so set `MCP_PUBLIC_URL` to the service's
own address and the file-returning tools add a link beside the path:

```json
{
  "docx_path": "/opt/render/project/src/artifacts/solar-pv/...docx",
  "download_url": "https://YOUR-SERVICE.onrender.com/files/solar-pv/...docx?expires=...&sig=...",
  "download_expires_at": "2026-08-28T13:31:35.000Z"
}
```

The link is signed and expires (`MCP_DOWNLOAD_TTL_SECONDS`, a day by default)
rather than requiring the bearer token, because what finally opens it is a
browser and a link cannot be told to send an `Authorization` header. The
signature covers both the path and the expiry, so neither can be edited, and it
is derived from the auth token rather than being it. A bearer token is also
accepted on the same route, for a caller fetching what it just generated.

Worth being explicit about the trade: a download link is a credential for that
one file while it lives, and it will end up in browser history and in whatever
chat it was pasted into. That is what the expiry is for.

Video scripts need none of this — `submit_video_script` returns the whole
script inline as `script_text`, and its file gets a link only for convenience.

**On free hosting, download the file when it is offered.** Generated files live
on the ephemeral filesystem and are gone after a spin-down or a redeploy; the
route says so rather than returning a bare 404.

## Tools

**Courses and documents**

| Tool | Purpose |
|---|---|
| `list_courses` | Registered courses and the status of their four approved documents |
| `get_course_manifest` | Course metadata plus the module crosswalk |
| `ingest_course_documents` | Extract, chunk and index the PDFs (idempotent) |
| `search_course_content` | BM25 search, scoped by course / document / chapter / NOS |
| `get_source_chunk` | Re-read one chunk verbatim by `chunk_id` |
| `get_document_page` | Every chunk on one PDF page, in reading order |

**Timing and crosswalk**

| Tool | Purpose |
|---|---|
| `get_module_crosswalk` | Map timing module → handbook chapter + NOS code |
| `get_timing_allocation` | Authoritative module and unit durations, with citations |
| `validate_timing_allocation` | Check the timing document's internal arithmetic |

**Template**

| Tool | Purpose |
|---|---|
| `analyze_storyboard_template` | Derived table shapes, headers, slide counts, styles |
| `get_storyboard_field_spec` | Which fields you write, which are read-only, citation rules |

**Storyboard**

| Tool | Purpose |
|---|---|
| `create_storyboard_draft` | Skeleton with structure and timing pre-filled |
| `get_storyboard` / `list_storyboards` | Read state, optionally one module |
| `storyboard_next_module` | One whole module to write, with its sources attached once |
| `storyboard_submit_module` | Write a whole module; commits one version, returns the next |
| `validate_storyboard` | Three-level mechanical validation |
| `render_storyboard_docx` | Populate the template and export |
| `get_storyboard_history` | Versions and change log |
| `rollback_storyboard` | Restore a version as a new version |
| `modify_storyboard_timing` | Refuses changes that conflict with the timing document |

**Guided flow**

| Tool | Purpose |
|---|---|
| `start_flow` | The two-option menu; returns a `session_id` |
| `flow_choose` | Answer the current step; also `back` and `restart` |
| `get_flow` | Re-render the current step (resume after a restart) |

**Handbook navigation**

| Tool | Purpose |
|---|---|
| `list_video_subjects` | Course types, subjects, and what each unavailable one needs |
| `get_ph_outline` | The handbook's own modules and units, derived from the document |
| `find_ph_unit` | Resolve a unit heading the user typed, across subjects |
| `get_ph_unit_source` | A unit's text split into citable blocks, for writing |

**Video script** (two calls from plan to finished script)

| Tool | Purpose |
|---|---|
| `get_video_profile` / `set_video_profile` | The saved presenter and background, or the six questions to ask |
| `plan_video_script` | The scenes, their seconds and word bands, what each must achieve, the handbook text behind them, the locked presenter, and the writing rules — all in one call |
| `submit_video_script` | All the scenes at once: validates, composes each scene's generation prompt, commits a version, writes the file |
| `get_video_script` / `list_video_scripts` / `get_video_script_history` | Read state and versions |

**Exact reading**

| Tool | Purpose |
|---|---|
| `read_ph_unit` | The unit's own text, verbatim. Takes no generation parameters |

## Typical flow

Storyboard — three answers from the user, then a loop the client runs alone:

```
start_flow → flow_choose ×3          (menu → programme → subject; stops there)
  → create_storyboard_draft           → artifact_id
  → storyboard_next_module            → WRITE_THIS + one module, sources attached once
  → loop: storyboard_submit_module    → commits one version, returns the next module
     until READY_TO_RENDER            (one call per module: 6–10 for a course)
  → validate_storyboard → render_storyboard_docx → give the user the .docx
```

The older hand-driven path still works and is what the task loop runs underneath:

```
list_courses → ingest_course_documents → get_course_manifest
  → get_timing_allocation → analyze_storyboard_template
  → get_storyboard_field_spec → create_storyboard_draft
  → per module: search_course_content → storyboard_submit_module
  → validate_storyboard → render_storyboard_docx
```

Video script — five answers from the user, then two calls:

```
start_flow → flow_choose ×5      (menu → course → subject → module → type,
                                  then the presenter and background questions)
  → plan_video_script             scenes, budgets, handbook text, presenter, rules
  → submit_video_script           validates, composes the prompts, writes the file
```

Exact reading:

```
find_ph_unit → read_ph_unit            returned unchanged; nothing else runs
```

## Cost and speed

A storyboard is written by a model over many calls, so what governs how long it
takes and what it costs is **how many times the client is asked**, not how fast the
server answers. Every MCP round trip re-sends the tool list and the whole
conversation so far and buys back one answer, so the number of calls multiplies
everything.

The build loop was originally one call per row, which for a six-module course was
130 calls. Measured on Green Hydrogen:

| | per row (before) | per module (now) |
|---|---|---|
| Round trips for a 6-module course | 132 | **10** |
| Tool-result payload | ~300K tokens | **~110K** |
| Client arguments | ~29K tokens | **~16K** |
| Source text sent | ~178K tokens | **~70K** |
| Chunk sends / distinct chunks | 774 / 228 (**3.4× each**, worst 24×) | 293 / 293 (**1.00×**) |
| Versions written | 130, each rewriting the whole state | **7** |
| Conversation history re-sent | 130 times, growing | 10 times |

Three things were being paid for repeatedly:

**The asking.** Per-row batching bought a few fields per call. A module is the
natural batch — it is what the template repeats, what the crosswalk scopes, and
what one writer can hold in mind at once — so the loop now hands out a whole module
and takes it back in one call.

**The same source text, again and again.** Sources were retrieved per row, so a
chunk was re-sent for every row whose wording happened to match it. A module's
material is now retrieved once, deduplicated, and sent once.

**Re-describing the tools.** 54 tool schemas went out with every one of those 130
calls. The surface is now 44 tools, and the loop that uses them is 10 calls rather
than 130.

Server-side work is not the bottleneck and never was — a complete course builds in
1.3–1.7s of server time — but two things there were genuinely wrong and are fixed:

**Retrieval was scoped after the fact.** The scope was a `WHERE` clause, so SQLite
matched a query's terms against every chunk of every course, ranked all of them
with `bm25()`, and only then discarded the out-of-scope 99% — and because a query
is an OR of its terms, it matched 2494 of 2530 chunks. Cost grew with the whole
corpus, so indexing a second course slowed retrieval for the first. The scope is
now carried as indexed tokens inside the FTS index and ANDed into the MATCH, so
postings lists intersect: **12.4 ms → 1.8 ms**, and independent of how many other
courses exist.

**A module could not see the end of its own chapter.** Scope listings were capped
at the search limit of 50, and handbook and guide chunks interleaved, so a module
whose chapter ran to 145 chunks got the first fifty of a mixed set — the material
its last units are written from was simply absent. Sources are now budgeted **per
unit**: every Part A row is a unit and gets its own slice, so coverage is
guaranteed per row and the total scales with how many units a module has rather
than with how long its chapter happens to be. A test asserts every row has source
material about its own unit.

Tuning, if a course needs it: `MODULE_CHUNKS_PER_UNIT` (default 6) and
`MODULE_CONTEXT_CHUNKS` (default 10) set how much source a module carries.

## What the server enforces

These are structural, not advisory — the client cannot route around them.

**Course isolation.** Every retrieval query carries a mandatory `course_id`
predicate. There is no code path that returns a chunk from another course, and an
unregistered `course_id` throws rather than falling back.

The scope is carried *inside* the full-text index rather than applied to its
output. Each chunk is indexed with opaque tokens naming its course, document,
chapter, unit and NOS (see
[`src/documents/scope-tokens.ts`](src/documents/scope-tokens.ts)), and a query
ANDs the ones it needs into the MATCH expression. As a `WHERE` clause the scope
could only be applied after the fact: SQLite ranked every chunk of every course —
a typical query, being an OR of its terms, matched 98% of the corpus — joined each
one, and then discarded almost all of them. Cost therefore grew with the size of
the whole corpus, so indexing a second course slowed retrieval for the first.
Intersecting postings lists instead made a scoped query roughly seven times
faster, and made it independent of how many other courses are indexed.

**Timing is read-only.** Durations are parsed from the Timing Allocation Document
and carry a page citation. The build loop cannot write a duration.
`modify_storyboard_timing` refuses any value that disagrees with the document and
explains the conflict.

**Parts B and C are spent out of the module's own time.** They are fixed at 15
minutes each, so Part A is the module total less half an hour — a three-hour module
gives Part A 2.5 hours. That is the template's own arithmetic: every Part A heading
in it reads "(2.5 hours)" under the three-hour modules it states. Handing Part A the
whole module made its heading disagree with the template and made the three parts
sum to half an hour more than the module lasts.

**The two tables agree about an activity by construction.** An LMS Technical
Mapping row's Unit and Activity Type are copied from that unit's Part A row rather
than written again, because both tables describe the same activity. They are read
from the state as just written, not from the work order — the work order is computed
before the call, when Part A is still blank, so taking them from it left the Activity
Type column empty in every module.

**The table of contents is rebuilt as a field, from the document produced.** The
template's contents is a live `TOC` field: each entry is a hyperlink to a `_Toc…`
bookmark, a right-aligned tab with a dot leader, and a `PAGEREF`. Rewriting those
entries as plain text destroyed all three -- the output carried zero TOC fields, so
`w:updateFields` had nothing to refresh, no page number or leader could ever appear,
and the bare run left behind still carried the `Hyperlink` character style, so it
rendered as blue underlined text. The renderer now discards the template's entries
and emits one per Heading1 and Heading2 in the finished body, bookmarking each
heading as it goes. Levels come from the heading styles, so a course with a
different module count, and the glossary, are carried without a second list to keep
in step.

The field is written `\o "1-2"`, matching what the template's contents actually
shows. Its own field instruction says `"1-3"`, which disagrees with its cached
entries -- there are ten Heading3 question-group headings and none is listed -- so
refreshing under `"1-3"` would add eleven lines the reference document does not
have.

**The cover keeps its page break.** It ends with one, in the same paragraph as the
strapline, and that is what puts the contents on page two. Replacing a paragraph's
text discarded every run in it, the page break included, so the contents rode up
onto the cover. `setParagraphText` now carries page-break runs across the rewrite.

**The template formats within a paragraph, and so does the output.** A question stem
is a bold green "1. " followed by a bold stem; an explanation is a bold-italic
"Explanation: " followed by italic text; a Part A cell is a bold activity name
followed by a plain description; a script cell is a bold speaker followed by plain
dialogue. Each is one paragraph holding two differently-formatted runs.
`setParagraphText` keeps only the first run's properties, so every one of those came
out uniformly bold -- the label's formatting spread across the whole line.
`setParagraphParts` maps part N onto run N instead, and inside table cells the
split is read off the prototype: a cell whose first run is bold and whose later runs
are not is a label-and-body cell, and its text is divided at the first ": ". The
decision stays in the template rather than being repeated per column.

**Every storyboard closes with a glossary.** Terms and abbreviations are gathered a
module at a time, from the sources that use them, so each carries that module's
citations; the renderer merges them into one alphabetical Glossary of Terms and
Abbreviations, deduplicated by term, and lists it in the contents. It renders as an
Abbreviation / Full Form / Definition table built from the template's own
three-column table, so its header fill, borders, padding, fonts and column widths
are the template's. It is the only thing in the output that the template does not
already contain -- a formatting diff of a generated storyboard against the template
reports the glossary table and nothing else.

**One folder per subject, holding one document.** A render writes
`artifacts/<course_id>/<course_id>-storyboard.docx` and removes any earlier render
beside it. Version history stays in the database, which is where it is queryable;
what is on disk is the deliverable, and there is exactly one of it. Naming the
folder for the artifact and the file for the version meant every draft made a new
directory and every render added a file.

**The module crosswalk.** The source documents disagree about module numbering.
The client-authored timing document renumbers the SCGJ chapters:

| Timing module | PH / FG chapter | NOS |
|---|---|---|
| 1 Entrepreneurship & Biomass Basics (3h) | 1 | SGJ/N4102 |
| 2 Financial Budget & Business Plans (6h) | 2 | SGJ/N4103 |
| 3 Sales, Supply & Marketing (3h) | 3 | SGJ/N4103 |
| 4 Compliance (3h) | 4 | SGJ/N4104 |
| **5** Pellet Manufacturing, Elective 1 (3h) | **7** | SGJ/N4105 |
| **6** Small Biogas Plant, Elective 2 (6h) | **8** | SGJ/N4106 |
| **7** HSE (3h) | **5** | SGJ/N4050 |
| 8 Employability Skills (3h) | — none — | DGT/VSQ/N0102 |

Pass `module_number` to `search_course_content` and the crosswalk is applied for
you. Getting this wrong yields content about the wrong subject under a
correct-looking citation, so `validate_storyboard` also rejects any citation whose
chunk belongs to the wrong chapter.

**Template fidelity.** The DOCX is never built from scratch. `styles.xml` (345 KB),
`theme1.xml`, `numbering.xml`, `header1.xml`, `footer1.xml` and `sectPr` are carried
over as untouched package parts, and every paragraph, row and table in the output
is a clone of a real element from the template with only its `<w:t>` text replaced.
Formatting is preserved by construction; a test asserts those parts are
byte-identical.

**Traceability.** Every generated educational field must cite a `chunk_id`.
Validation confirms each citation resolves to a real chunk, in the right course and
chapter, and measures lexical overlap between the field and the text it cites.

**Insufficient source.** Where the approved documents cannot support content, the
result is `INSUFFICIENT_SOURCE_CONTENT`, never invented material.

**The outline is the handbook's own contents.** Modules and units are read from the
indexed handbook, and unit titles are taken from its table of contents, which is the
one place every title is printed complete. Every module the handbook declares is
listed — including one that has no units, like Biofuels module 6 (Employability
Skills), which the handbook defers to an external DGT workbook. It is shown with its
reason and cannot be selected. A test asserts the outline matches the contents page
unit for unit.

**A video's shape is arithmetic with one answer.** Four rules are fixed — 150-180
seconds, no scene over 10 seconds, 22-25 words a scene, no sentence crossing a scene
boundary — and a scene shorter than ten seconds cannot hold twenty-two words. So every
scene is exactly ten seconds and the video is 15-18 of them. Six are the frame and the
other 9-12 go to the units, two or three apiece, which is what makes it a complete
module introduction rather than a teaser. A scene outside its word band is a validation
**error**: over the band the generator cuts the last words off mid-sentence, which is
not recoverable after rendering.

**Every scene finishes what it starts.** Each scene is a separate generation and may be
watched with a beat between clips, so a sentence spanning two of them does not merely
read awkwardly — it breaks. Validation rejects narration that ends without terminal
punctuation, ends on a word that promises a continuation (`and`, `so`, `which`, `to`,
…), or contains a fragment. At most three sentences a scene, because the breath between
them and the half-second before the cut need somewhere to fit.

**The pace follows from the word count, not the other way round.** Twenty-two to
twenty-five words inside ten seconds, with a breath between sentences and a beat of
silence at the end, is about 150 wpm — not the 120-130 an earlier brief asked for. The
word count and the scene length are the mandatory rules, so the pace is derived from
them and stated in every prompt. Asking a generator for 130 wpm *and* 25 words in one
clip simply produces a clip whose last words are cut off.

**The presenter is the same person by construction, not by discipline.** Each scene is
a separate generation and the generator remembers nothing between calls, so a presenter
described afresh per scene comes back as a different face, in different clothes, with a
different voice. The description is therefore written once from the saved profile and
the identical text is stamped into every scene prompt by the server — along with the
voice, the delivery pace, the 0.5-1 second speech lead-in and the speak-this-line-once
audio directive. The client is told not to write any of them, and validation reports
those checks as guaranteed rather than sampled, because they cannot fail.

**On-screen text is spelled out, enumerated and fenced.** Misspelled burned-in text
is the commonest way a finished clip comes back unusable — the shot looks right, the
audio is right, and a learner sees `CALORIFC VALUE` in a training video. Every scene
prompt therefore carries an **ACCURACY** block that names the exact strings permitted
(the caption, character for character; the teaching visual's labels), forbids all other
text including invented background lettering on walls, packaging and equipment, pins
every number and unit to the value given, and — the escape hatch that matters — tells
the generator that if text cannot be rendered cleanly it should render none, because
missing text is recoverable and misspelled text is not. It appears on every scene,
including scenes with no text at all, since those are exactly where invented signage
slips through. The block adapts to the scene: a scene with a labelled diagram is never
told "no text may appear", because a prompt that contradicts itself is resolved by the
generator however it likes.

**The prompt forecloses the errors rather than hoping.** Each composed prompt is
labelled blocks and a numbered eight-point audio contract, not prose: the spoken line
quoted in full and marked as the entire audio, the pauses given in seconds, and an
explicit `DO NOT` list (no second person, no music, no captions, no slow motion, no
cutting away, no restyling the presenter). A generator does not infer — it fills gaps
with whatever is statistically nearby, and every gap is a defect waiting to be rendered.

**The topic is the hero.** This is an LMS introduction, not a short film. The spec that
ships with the plan rules out backstory, character development, drama, conversation and
cinematic set pieces, and the composed prompt says so to the generator too. The
presenter holds, points at and demonstrates things; that is the whole of their role.

**A video script never mentions its source.** No handbook, page, figure, table, unit
number, module number, QR code or qualification code may appear in narration, on-screen
text, the visual description, the location or the presenter's action — the viewer has
none of those in front of them. It is an error, not a warning, and citations stay in
each scene's `sources`.

**Every teaching scene is grounded in its own allocation.** A roadmap scene must cite
chunk_ids, they must resolve in that subject's handbook, and they must belong to the
units allocated to that scene — a citation borrowed from another part of the module is
an error. The framing scenes cite nothing, because they speak about the module rather
than from a passage of it.

**A duplicated word is caught before it is spoken.** "the the" in a narration line is
what a stuttering generation sounds like, and written into the script it is guaranteed
rather than likely, so it is an error.

**One script per module, not one per request.** The store is keyed on course, module
and video type, so answering the flow twice for the same module continues the script
that exists. The previous feature keyed on nothing and left a hundred empty rows behind.

**The reading mode cannot generate.** `read_ph_unit` takes a subject and a unit and
nothing else — no length, no style, no audience. There is no parameter through which
a summary could be requested, and the result carries a `fidelity_note` stating the
only two mechanical differences from the printed page (removed running headers and
folio numbers, removed indexing overlap).

**Unit resolution refuses to guess.** When a typed heading matches two units closely,
`find_ph_unit` reports `confident: false` and the flow asks which was meant rather
than picking one — reading out the wrong unit answers a question nobody asked.

**Generation is two calls, deliberately.** Every MCP round trip re-sends the tool list
and the whole conversation and buys back one answer, so a feature that fetches a spec,
then the source, then submits, then validates, then renders, then exports costs six
times what a 90-second video needs. Everything the writer needs travels with the plan,
and everything the server does with the result happens inside the submit.

## Known gaps

**Module 8 (Employability Skills, 3 of 30 hours) has no source content.** Neither
the Participant Handbook (p.292) nor the Faculty Guide (p.106) contains it — both
defer to an external DGT workbook, and a keyword sweep of the 311-page handbook for
the DGT/VSQ/N0102 topics returns nothing. The module renders as a flagged stub.
Supply the **DGT/VSQ/N0102 Employability Skills workbook** as a fifth approved
document and it will generate like any other module.

**Validation grounding is lexical, not semantic.** Without a model, the server can
confirm a citation resolves, is correctly scoped, and shares wording with the field
citing it. It cannot judge whether a sentence is a fair paraphrase — that
assessment belongs to the client, and `low_grounding_overlap` is reported as a
warning rather than an error to reflect that.

**Page numbers need Word, and are resolved at generation time.** The contents is a
real `TOC` field with a `PAGEREF` per entry, and both are computed from where text
falls on the page -- a layout pass this server cannot do. So the renderer emits the
fields with an empty cached result and then hands the finished file to Word once,
via COM, to update them and save. The numbers are in the file from that point, so a
viewer that shows cached field results rather than resolving them displays them too.

That step is the one place the pipeline reaches outside itself, and it is
deliberately last and soft: the byte-faithful document is already on disk before it
runs, and a machine without Word gets a warning and a document whose page numbers
fill in the first time it is opened in Word. Set `REFRESH_FIELDS=false` to skip it.
Word rewrites the package when it saves, so the byte-identity check against the
template applies to what the renderer wrote, before this runs -- which is what the
suite asserts, with the refresh switched off.

**Orientation has documents but no crosswalk.** All four Orientation subjects have
their PDFs on disk, so the reading flow serves them today. A storyboard
additionally needs a reviewed crosswalk and chapter-title map in
[`src/courses/course-config.ts`](src/courses/course-config.ts), which is left empty
for them rather than guessed at: an inferred crosswalk produces a storyboard about
the wrong chapter under citations that look valid. The storyboard menu lists them
and says so.

**CDR's master file has been rewritten.** `courses/cdr-biochar/master.docx` now
declares five modules rather than seven, states each duration on the line after the
module heading rather than on it, and names its reference documents by their
on-disk filenames. `src/cdr/master-file.ts` still expects the previous shape and
finds no module headings at all, so the CDR track cannot build and its generation
tests are skipped with that reason. Nothing else depends on it.

## Development

```bash
npm run typecheck
npm test                       # 155 tests
npm run flow                   # walk the guided flow by hand in the terminal
npm run flow -- "<heading>"    # the shortcut flow, from a unit heading
npm run parse-timing -- biofuels
npm run analyze-template
npx tsx scripts/render-skeleton.ts biofuels
```

`npm test` covers timing parsing and arithmetic, chapter attribution, FTS query
escaping, run-preserving paragraph replacement, course isolation, crosswalk
scoping, citation validation, question-bank numbering and rejection rules, version
conflicts, rollback, and byte-identical preservation of the template's formatting
parts. The handbook suite covers overlap-free unit reassembly, heading resolution
and its refusal to guess, and the guided flow's step machine. The video suite covers
the scene arithmetic (every scene ten seconds, seconds summing exactly, contiguous
timecodes, the fixed 22-25 word band, every unit given two or three consecutive
scenes with a distinct slice each), each validation rule against a script written to
break it — including narration left open, ending on a dangling word, holding a
fragment, or holding more sentences than the breaths fit — the identity of the
presenter block across every composed prompt, and the flow's five questions
including the five-in-one presenter answer.

## Layout

```
src/
  mcp/server.ts          stdio MCP server
  mcp/tools/index.ts     the registry: assembles the lists below and dispatches
  mcp/tools/flow.ts      start_flow, flow_choose, get_flow -- the entry point
  mcp/tools/storyboard.ts  feature 1, the storyboard's course, timing and render tools
  mcp/tools/storyboard-build.ts  feature 1's build loop: one module out, one back
  mcp/tools/video-script.ts  feature 2, the 2.5-3 minute info video: plan and submit
  mcp/tools/reading.ts   feature 3, read_ph_unit
  mcp/tools/catalog.ts   handbook navigation
  catalog/               course types, subjects, and their readiness
  courses/               course registry, crosswalk, chapter titles
  documents/             PDF extraction, chunking, ingestion, BM25 retrieval
  documents/ph-outline   handbook structure, verbatim reading, heading resolution
  flow/                  the guided step machine, persisted per session
  timing/                timing parser and arithmetic validator
  docx/                  OOXML helpers, template analyzer, renderer
  storyboard/            skeleton builder, module work order, three-level validator
  videoscript/           profile and character lock, scene planning, prompt
                         composition, validation, rendering, store
  reading/               plain-text rendering of a handbook unit
  storage/               SQLite schema, artifact and version store
courses/<track>/<subject>/   qp.pdf ph.pdf fg.pdf timing.pdf
templates/<track>/           that track's storyboard template
scripts/timing/              author a Timing Allocation Document for a new course
scripts/cdr/                 regenerate the CDR course definitions from a master file
artifacts/<course_id>/       the finished storyboard, one document per subject
artifacts/video-scripts/<script_id>/   the finished video script, one file per version
```
