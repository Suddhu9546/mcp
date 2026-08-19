# CVC Storyboard MCP

A deterministic **tool layer** for SCGJ educational content: per-module video
scripts and slide decks, course storyboards as DOCX, and exact Participant Handbook
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
  handbook outline + reading   learning-outcome extraction
  three-part video planning    deck sizing + coverage validation
  10-second segment budgets    PPTX: CVC design + drawn diagrams
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
| DOCX and PPTX generation | | ✔ |
| Segment/slide budgets and unit coverage | | ✔ |

## The three flows

They are kept strictly apart. A session records which flow it is in, and the tools
of one flow cannot produce the output of another.

```
                     start_flow   ← "can we start", "show me what you have"
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    1 Module Content  2 Exact PH     3 Storyboard
                        Reading
          │               │               │
          ▼               ▼               ▼
       subject         subject         subject
          │               │               │
          ▼               ▼               ▼
       module          module        storyboard_ready
          │               │          (whole course; hands
          ▼               ▼           over with course_id)
    module_ready         unit
    generation begins     │
                          ▼
                 reading_complete
```

The flow asks only what it cannot work out. There is no "would you like to type or
browse" question, no course-type question, and no duration question: a topic typed
at any step is resolved to the unit that holds it, course type is a label on each
subject, and a module's output length is fixed.

Module content stops at the module. 12 minutes is settled: a 3-minute video as
18 × 10s segments (60s intro / 90s units / 30s conclusion) plus a 9-minute deck
sized to the module, no slide over 30s, covering every unit. No unit list is shown
and nothing further is asked.

Reading goes one level deeper to the unit and returns its verbatim text. No
generation step exists on that path.

**What a module produces.** One package, planned as a whole so the two halves cover
the module between them:

| | Video | Slides |
|---|---|---|
| Length | 3:00 | 9:00 |
| Pieces | 18 segments × 10s, in 3 parts (60s / 90s / 30s) | as many slides as the module needs, none over 30s |
| Why that shape | the generator produces 10s per generation | a slide holding more than half a minute stops being readable |
| Each piece carries | story beat, continues-from, narration, scene, visual direction, character/location/object continuity, ends-with, next-starts-with, transition | title, 3–5 bullets, speaker notes, key takeaway, a drawn right-hand visual |
| Output | text inline **and** a `.txt` file, plus `.srt` subtitles | `.pptx` with notes attached, and a `.txt` |

Every segment and slide is told which unit it covers and which portion of it, so no
unit is skipped — validation reports a unit missing from either half as an error.

Say **`restart`** at any step, finished ones included, to clear the session and go
back to the menu — that is the answer to "we're done with this module, now another
one". **`back`** changes the previous answer; going back from a package releases it,
so choosing again plans afresh rather than re-showing the old one. `start_flow` opens
an independent session whenever you want one.

| | Module Content | Exact PH Reading |
|---|---|---|
| Scope | A handbook module, all its units | One unit |
| Source of truth | The module's units | The unit |
| AI transformation | Presentation only — narration, visuals, structure | **None** |
| New facts | Never | Never |
| Output | Video script text + `.pptx` deck | The unit's own text |

**Shortcut.** A user who names a topic skips the menus: `plan_module_content` takes
a `topic` and builds the module that holds it; `read_ph_unit` takes a heading.

**Ad-hoc single-unit script.** `plan_video_transcript` still produces a
scene-by-scene script for one unit at any duration you ask for. It sits outside the
guided flow, for when someone wants exactly that rather than a module package.

**Subjects.** Eight across two course types. Each reports exactly what it is
waiting for, and the flow offers only the ones it can serve.

| Orientation | Entrepreneur |
|---|---|
| ESG — Environmental, Social and Governance | Solar PV ✅ |
| GHG — Greenhouse Gas | Biofuels ✅ |
| GL — Green Logistics | Agri-Residue Aggregator |
| BG — Biogas | Green Hydrogen |

**Adding a subject: drop the PDFs in and pick it from the menu.** Put
`ph.pdf` (and `qp.pdf`, `fg.pdf`, `timing.pdf` for storyboards) into
`courses/<course_id>/`. Nothing else is required — a handbook that is present but
not yet indexed shows in the menu as a normal choice and is indexed the first time
it is picked, which takes a few seconds once. Modules and units are derived from
the handbook itself, so nothing about its structure is declared in code.

If the documents arrive in a folder named differently from the `course_id` — as
Solar's did, in `courses/solar` rather than `courses/solar-pv` — add that name to
the course's `directory_aliases` in `src/courses/course-config.ts`. Renaming the
folder works too, but the folder is the thing that keeps arriving.

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
npm run ingest -- biofuels
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
| `set_storyboard_content` | Write content; commits a new version |
| `set_assessment_content` | Write the assessment blueprint and question bank |
| `validate_storyboard` | Three-level mechanical validation |
| `render_storyboard_docx` | Populate the template and export |
| `get_storyboard_history` | Versions and change log |
| `rollback_storyboard` | Restore a version as a new version |
| `modify_storyboard_timing` | Refuses changes that conflict with the timing document |

**Guided flow**

| Tool | Purpose |
|---|---|
| `start_flow` | The three-option menu; returns a `session_id` |
| `flow_choose` | Answer the current step; also `back` and `restart` |
| `get_flow` | Re-render the current step (resume after a restart) |

**Handbook navigation**

| Tool | Purpose |
|---|---|
| `list_video_subjects` | Course types, subjects, and what each unavailable one needs |
| `get_ph_outline` | The handbook's own modules and units, derived from the document |
| `find_ph_unit` | Resolve a unit heading the user typed, across subjects |
| `get_ph_unit_source` | A unit's text split into citable blocks, for writing |

**Module content package** (the main flow)

| Tool | Purpose |
|---|---|
| `plan_module_content` | The three parts, the deck size, the handbook's learning outcomes, and per-item beats and allocations |
| `set_module_story` | The film's constants: protagonist, locations, look, narrator, acts |
| `get_module_content_spec` | What to write into a segment and into a slide |
| `get_module_source` | The handbook text behind the package, or behind one slot |
| `submit_module_video` | The 18 segments |
| `submit_module_slides` | The 14 slides |
| `validate_module_package` | Fit, unit coverage, citations, source leaks |
| `get_module_video_script` | Copy-ready segments, one per generation, with the story bible |
| `get_module_subtitles` | Progressive typewriter subtitle track, SRT or cues |
| `get_module_slides` | The deck as text |
| `render_module_pptx` | The deck as `.pptx`: CVC design, drawn diagrams, speaker notes |
| `export_module_package` | Every deliverable written as a file, with paths to attach |
| `get_module_package` / `list_module_packages` / `get_module_package_history` | Read state and versions |
| `get_module_units` | The units behind a module — for your orientation, not a user menu |

**Single-unit transcript** (ad-hoc, outside the flow)

| Tool | Purpose |
|---|---|
| `plan_video_transcript` | Scene plan: timings, word budgets, per-scene source text |
| `get_video_transcript_spec` | What to write per scene, and the grounding rules |
| `submit_video_transcript` | Write the scenes; commits a new version |
| `validate_video_transcript` | Structure, duration fit, citation scope, grounding |
| `get_video_transcript` | The copy-ready script text (or `production` / `json` formats) |
| `list_video_transcripts` / `get_video_transcript_history` | Read back drafts and versions |

**Exact reading**

| Tool | Purpose |
|---|---|
| `read_ph_unit` | The unit's own text, verbatim. Takes no generation parameters |

## Typical flow

```
list_courses → ingest_course_documents → get_course_manifest
  → get_timing_allocation → analyze_storyboard_template
  → get_storyboard_field_spec → create_storyboard_draft
  → per module: search_course_content → set_storyboard_content
  → validate_storyboard → render_storyboard_docx
```

Module content:

```
start_flow → flow_choose ×3            (feature → subject → module; stops there)
  → plan_module_content                 18 segments + 14 slides, unit by unit
  → get_module_content_spec → get_module_source
  → set_module_story                    the film's constants, before any segment
  → submit_module_video + submit_module_slides
  → validate_module_package
  → export_module_package               script .txt + subtitles .srt + deck .pptx/.txt
  → get_module_video_script             the same script inline, to read or copy
  → render_module_pptx                  the deck, as a .pptx file
```

Exact reading:

```
find_ph_unit → read_ph_unit            returned unchanged; nothing else runs
```

## What the server enforces

These are structural, not advisory — the client cannot route around them.

**Course isolation.** Every retrieval query carries a mandatory `course_id`
predicate. There is no code path that returns a chunk from another course, and an
unregistered `course_id` throws rather than falling back.

**Timing is read-only.** Durations are parsed from the Timing Allocation Document
and carry a page citation. `set_storyboard_content` cannot write a duration.
`modify_storyboard_timing` refuses any value that disagrees with the document and
explains the conflict.

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

**Video duration is arithmetic, not judgement.** A model asked for "about two
minutes" reliably writes three. So the duration is divided into scenes here, each
scene gets a word budget at a stated speaking rate, and validation reports the
script's actual read time. Scene seconds always sum to exactly what was requested.

**The outline is the handbook's own contents.** Modules and units are read from the
indexed handbook, and unit titles are taken from its table of contents, which is the
one place every title is printed complete. Every module the handbook declares is
listed — including one that has no units, like Biofuels module 6 (Employability
Skills), which the handbook defers to an external DGT workbook. It is shown with its
reason and cannot be selected. A test asserts the outline matches the contents page
unit for unit.

**The script never mentions its source.** The rendered script is what a user copies,
so it carries no page numbers, citations or word-count annotations — and the content
may not either. A handbook name, page or figure number, unit or module number, QR
code or qualification code appearing in a title, visual, on-screen text or narration
is a validation **error**: the viewer has none of those in front of them. Citations
stay in `scenes[].sources`, and `format: "production"` renders them back for a
reviewer.

**A module package covers every unit.** The plan allocates all 18 segments and all
14 slides across the module's units in handbook order, proportional to length with a
floor of one item per unit, and the parts always sum to exactly 18 and 14. A unit
that neither the video nor the deck cites is a validation error, not a warning — a
well-written script gives no hint that a unit was skipped.

**The video is one film in three parts.** Part 1 (segments 1–6, 60s) orients the
learner to the whole module, built from the learning outcomes the handbook itself
states — extracted from its "Key Learning Outcomes" page, or from the units' own
objectives where a module states none. Part 2 (7–15, 90s) teaches every unit in
handbook order, and the plan flags the segment that opens each unit so it names the
unit rather than announcing it. Part 3 (16–18, 30s) consolidates. Each segment is
assigned its beat before anything is written. A story bible (`set_module_story`) fixes the protagonist, three to six
locations, the light, the camera language and the narrator, because each clip is
generated blind to the others and continuity survives only where it is written down.
Segments then carry `continues_from` / `ends_with` / `next_segment_starts_with`, and
validation checks the chain: a segment whose opening shares nothing with the previous
segment's ending is a **continuity break** error. It also checks the protagonist is
named in every segment, that locations come from the bible, that graphics stay under
a fifth of the film, and that the last shot returns to the first.

**The deck has its own design, and it is not the video's.** A warm cream page, deep
green type, one green accent, hairline borders, generous space — defined once in
[`src/pptx/design.ts`](src/pptx/design.ts) and applied to every slide. The
composition is fixed: unit label, title under an accent rule, teaching cues left,
visual right.

**The right-hand visual is drawn, not decorated.** A slide's visual is specified as
a type plus ordered labels, and the labelled types (process, workflow, lifecycle,
comparison, components, relationship, cause/effect, measurement) are rendered as
real editable PowerPoint shapes — rounded cards with arrows between them — rather
than a stock image. Half the slide teaches instead of filling space.

**The presenter is locked per subject.** The first module to choose a character
fixes it; later modules of the same subject reuse them, and changing them needs an
explicit flag. A learner taking two modules of one subject meets the same person.

**The .pptx is validated before it is written.** PowerPoint's only complaint about
an invalid package is "the file or directory is corrupted and unreadable", naming no
part — so [`src/pptx/validate.ts`](src/pptx/validate.ts) checks the finished bytes on
every render and throws rather than writing a file that will not open. It checks:
every part well-formed and free of control characters, an explicit content-type
Override of the right type for every PresentationML part, every relationship
resolving, presentation r:ids declared, slide count matching slide parts, unique
shape ids, no zip directory entries, and **one theme part per master** — the defect
that was making PowerPoint refuse the deck.

Only PowerPoint can prove a file opens without a repair prompt, so there is a
command for that:

```bash
npm run verify-pptx -- artifacts/MP-2026-00001/module-1-deck-v4.pptx
```

It opens the file read-only over COM, reports slide count, page size and how many
slides carry notes, and exits non-zero if PowerPoint refuses it. Add `-Preview` to
export the first three slides as PNGs.

**Every generation produces files, not just text.** `export_module_package` writes
the video script (`.txt`), the subtitle track (`.srt`) and the deck (`.pptx` and
`.txt`) under `artifacts/<package_id>/`, named `module-1-video-script-v4.txt` so two
downloads are distinguishable in a folder, and returns the paths for the client to
attach to the conversation. The text still comes back inline as well — an
eighteen-segment script runs past 20KB, which is more than anyone should have to
select out of a chat window.

**Subtitles are generated, not written.** `get_module_subtitles` builds a
progressive word-by-word typewriter reveal from the narration, timed across each
segment's ten seconds, as SRT or cues. Word timing is estimated from word length —
there's no audio to align against — so it's a starting point an editor nudges.

**Ten seconds is a hard limit.** The generator produces ten seconds per generation,
so narration that overruns is cut off rather than compressed. Segment narration
longer than its band is an error; shorter is a warning about dead air.

**A video is grounded in one unit.** Every scene must cite chunks that resolve, come
from the Participant Handbook, and belong to *that unit*. A citation from another
unit is a validation error, not a warning.

**The reading mode cannot generate.** `read_ph_unit` takes a subject and a unit and
nothing else — no length, no style, no audience. There is no parameter through which
a summary could be requested, and the result carries a `fidelity_note` stating the
only two mechanical differences from the printed page (removed running headers and
folio numbers, removed indexing overlap).

**Unit resolution refuses to guess.** When a typed heading matches two units closely,
`find_ph_unit` reports `confident: false` and the generation tools refuse rather than
picking one — generating from the wrong unit produces a correct-looking script about
the wrong topic.

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

**Table of contents page numbers.** The template's TOC is a Word field. Entry text
is regenerated and `w:updateFields` is set, so Word refreshes page numbers when the
document is opened. Page numbers cannot be computed without a layout engine.

**One course has documents.** All eight subjects are registered; only `biofuels`
has PDFs. The video and reading flows need only that subject's `ph.pdf`; a
storyboard needs all four documents plus a reviewed crosswalk and chapter-title map
in [`src/courses/course-config.ts`](src/courses/course-config.ts), which is left
empty for the seven pending subjects rather than guessed at.

**Video pace is one number.** Read time is estimated at a single words-per-minute
figure (140 by default, overridable per plan). It does not model pauses, B-roll,
on-screen reading time or a narrator who speeds up. Treat the estimate as a budget,
not a stopwatch.

## Development

```bash
npm run typecheck
npm test                       # 93 tests
npm run flow                   # walk the guided flow by hand in the terminal
npm run verify-pptx -- <file>   # open a generated deck in the real PowerPoint
npm run flow -- "<heading>"    # the shortcut flow, from a unit heading
npm run parse-timing -- biofuels
npm run analyze-template
npx tsx scripts/render-skeleton.ts biofuels
```

`npm test` covers timing parsing and arithmetic, chapter attribution, FTS query
escaping, run-preserving paragraph replacement, course isolation, crosswalk
scoping, citation validation, question-bank numbering and rejection rules, version
conflicts, rollback, and byte-identical preservation of the template's formatting
parts. The video suite covers duration parsing, scene-plan arithmetic (seconds and
word budgets summing exactly, contiguous timecodes, full unit coverage in document
order), overlap-free unit reassembly, heading resolution and its refusal to guess,
the guided flow's step machine, and rejection of citations from the wrong unit.

## Layout

```
src/
  mcp/server.ts          stdio MCP server
  mcp/tools/index.ts     the registry: assembles the lists below and dispatches
  mcp/tools/flow.ts      start_flow, flow_choose, get_flow -- the entry point
  mcp/tools/module.ts    feature 1, the 13 module content package tools
  mcp/tools/storyboard.ts  feature 2, the 21 storyboard tools
  mcp/tools/reading.ts   feature 3, read_ph_unit
  mcp/tools/catalog.ts   handbook navigation shared by features 1 and 3
  mcp/tools/transcript.ts  the single-unit script, outside the guided flow
  catalog/               course types, subjects, and their readiness
  courses/               course registry, crosswalk, chapter titles
  documents/             PDF extraction, chunking, ingestion, BM25 retrieval
  documents/ph-outline   handbook structure, verbatim reading, heading resolution
  documents/learning-outcomes  the outcomes the handbook states, per module and unit
  flow/                  the guided step machine, persisted per session
  timing/                timing parser and arithmetic validator
  docx/                  OOXML helpers, template analyzer, renderer
  storyboard/            skeleton builder, three-level validator
  video/                 module + scene planning, story beats, continuity, stores
  pptx/                  PowerPoint writer, design system, diagrams, package validator
  storage/               SQLite schema, artifact and version store
courses/biofuels/        qp.pdf ph.pdf fg.pdf timing.pdf
templates/               storyboard-template-v1.docx
artifacts/               generated .docx by artifact and version
```
