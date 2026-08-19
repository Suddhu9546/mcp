# Manual run: generating a storyboard by hand

A step-by-step walkthrough for driving the MCP yourself, to test it.

The server is a tool layer with no AI in it, so **you** (or the model you are
chatting with) do the thinking: retrieve sources, read them, write the content,
submit it. The server supplies sources, timing, validation and the DOCX.

---

## Step 0 — Get connected

**One-time setup**

```bash
cd C:\cvc-mcp
npm install
npm run ingest -- biofuels
```

`ingest` should report roughly:

```
QP      50 pages -> 81 chunks
PH      311 pages -> 559 chunks
FG      123 pages -> 159 chunks
TIMING  6 pages -> 38 chunks
Total chunks indexed: 837
```

**Connect a client.** `.mcp.json` is already in the repo.

- *Claude Code*: MCP servers load at startup, so **restart** `claude` inside
  `C:\cvc-mcp` and approve the `storyboard` server. Check with `/mcp`.
- *Antigravity*: point its MCP config at the same command:
  `npx tsx src/mcp/server.ts`, cwd `C:\cvc-mcp`.

You should see **21 tools**.

---

## Step 1 — Sanity checks

Confirm the server sees the documents and that timing is trustworthy before
generating anything.

| Call | Expect |
|---|---|
| `list_courses` | `biofuels`, QP code `SGJ/Q4102`, 8 modules, all 4 docs `present: true, indexed: true` |
| `validate_timing_allocation` `{course_id:"biofuels"}` | `course_total_ok: true`, `all_modules_ok: true`, `computed_total_minutes: 1800`, `discrepancies: []` |

If `indexed` is false, re-run `npm run ingest -- biofuels --force`.

---

## Step 2 — Learn the shape before writing anything

Four read-only calls. Do these once; they tell you everything you need.

**2a. `get_course_manifest` `{course_id:"biofuels"}`**

Read the `crosswalk`. This is the single most important thing in the project —
the documents disagree about module numbering:

| Timing module | Handbook chapter | NOS |
|---|---|---|
| 5 Pellet Manufacturing | **7** | SGJ/N4105 |
| 6 Small Biogas Plant | **8** | SGJ/N4106 |
| 7 HSE | **5** | SGJ/N4050 |

You never have to apply this by hand — pass `module_number` to
`search_course_content` and it resolves for you.

**2b. `get_timing_allocation` `{course_id:"biofuels", module_number:1}`**

Gives the authoritative durations and the sub-topics of each unit. **Use the
sub-topic titles as your search queries** — they are the most precise description
of what each unit must cover.

**2c. `analyze_storyboard_template`**

The shapes your content must fit. Note: Part B is always **5 three-minute
segments**, Part C always **7 slides**.

**2d. `get_storyboard_field_spec`**

Which fields you write, which are read-only, and which require citations.

---

## Step 3 — Create a draft

**Start with one module.** Do not draft all 8 on your first run — validation will
report an `empty_field` error for every unfilled cell and the noise will bury the
useful findings.

```
create_storyboard_draft
{ "course_id": "biofuels", "modules": [1], "note": "manual test" }
```

Returns an `artifact_id` like `SB-2026-00004`. Note it down.

What you get back already populated, with no work from you: module title, the
authoritative 180 minutes, 4 Part A rows with unit codes/titles/durations, 5 empty
Part B segments, 7 empty slides.

---

## Step 4 — Read the sources for the module

```
get_storyboard
{ "artifact_id": "SB-2026-00004", "module_number": 1 }
```

**Copy the `row_id` / `slide_id` values.** You address everything by these ids,
never by position. They look like:

| Section | Id format | Example |
|---|---|---|
| Part A row | `m<NN>-a-<unit>` | `m01-a-1.1` |
| Part B row | `m<NN>-b-<n>` | `m01-b-1` |
| Part C slide | `m<NN>-c-s<n>` | `m01-c-s1` |

Now retrieve, once per unit:

```
search_course_content
{
  "course_id": "biofuels",
  "query": "<the unit title + its sub-topic titles from step 2b>",
  "module_number": 1,
  "document_types": ["PH"],
  "limit": 4
}
```

Repeat with `["FG"]` for teaching method and `["QP"]` for the performance
criteria. Check the response's `scope` block shows the resolved chapter you
expect.

**Read the `content` of each hit.** Keep the `chunk_id`, `pdf_page`,
`printed_page` and `section` of the ones you actually use — those become your
citations.

---

## Step 5 — Write the content

One `set_storyboard_content` call per module. Anything you omit is left untouched,
so you can also do it in several smaller calls.

```json
{
  "artifact_id": "SB-2026-00004",
  "base_version": 1,
  "module_number": 1,

  "module_description": "One paragraph introducing the module...",
  "module_description_sources": [
    { "document_type": "PH", "pdf_page": 12, "printed_page": 2,
      "section": "UNIT 1.4: Biomass Resource Management and Procurement",
      "chunk_id": "biofuels:PH:p12:12" }
  ],

  "part_a_rows": [
    {
      "row_id": "m01-a-1.1",
      "activity_name": "Biofuel State Sorter",
      "interactive_description": "Learners classify biofuels by physical state...",
      "correlation": "SGJ/N4102 / PC1, PC2, PC8",
      "performance_criteria": ["PC1", "PC2", "PC8"],
      "sources": [ { "document_type": "PH", "pdf_page": 15, "printed_page": 5,
                     "section": "UNIT 1.1: Fundamentals of Biofuels and Biomass Energy",
                     "chunk_id": "biofuels:PH:p15:19" } ]
    }
  ],

  "lms_rows": [
    {
      "unit_range": "1.1",
      "activity_type": "Biofuel State Sorter",
      "recommended_standard": "xAPI",
      "tracking": "xAPI Verbs: classified, identified / Data: ...",
      "completion_criteria": "All solid, liquid and gaseous biofuels correctly classified...",
      "sources": [ /* ... */ ]
    }
  ],

  "part_b_rows": [
    {
      "row_id": "m01-b-1",
      "visual": "Wide establishing shots of agricultural residue...",
      "gfx": "Bio-Energy Micro Entrepreneur - Module 1",
      "audio": "Host (On-Camera): \"The world is experiencing a rapid shift...\"",
      "sources": [ /* ... */ ]
    }
  ],

  "part_c_subtitle": "Biofuel Fundamentals, the Entrepreneurial Process and Residue Procurement",
  "slides": [
    {
      "slide_id": "m01-c-s1",
      "title": "Title Slide",
      "visual_cues": "SCGJ branding. Image of agricultural residue...",
      "instructor_script": "Welcome to the first live session...",
      "sources": [ /* ... */ ]
    }
  ],

  "note": "Module 1 authored from PH ch.1, FG ch.1, QP SGJ/N4102"
}
```

### Rules that will bite you

1. **`base_version` must be the current version.** It increments on every write.
   Re-read with `get_storyboard` if you get a version conflict.
2. **Citations are required on 5 fields**: `module_description` (via
   `module_description_sources`), `interactive_description`,
   `completion_criteria`, Part B `audio`, and slide `instructor_script`.
3. **`activity_type` in `lms_rows` must exactly match an `activity_name` you set
   in Part A** for the same module, or you get a warning.
4. **`lms_rows` replaces all rows** for the module — send the complete set.
5. **Fill all 5 Part B rows and all 7 slides.** Counts are fixed by the template.
6. **Durations, unit codes and unit titles are not writable.** They come from the
   Timing Allocation Document.
7. **A partial failure commits nothing.** Bad `row_id` → the whole call is
   rejected, so fix the id and resend against the same `base_version`.

---

## Step 5b — Write the question bank

The template runs **10 questions per module**, grouped under a per-module heading.

```
set_assessment_content
{
  "artifact_id": "SB-2026-00004",
  "base_version": 2,
  "minimum_aggregate_pass_pct": 70,
  "remarks": "Total 30 hours (1,800 minutes) across 8 modules.",
  "weightage_compulsory": [
    { "nos_code": "SGJ/N4102", "nos_title": "Introduce to Entrepreneurship...",
      "theory_marks": 23, "practical_marks": 27, "total_marks": 50, "weightage": 14 }
  ],
  "questions": [
    {
      "module_number": 1,
      "stem": "By which process is charcoal derived from wood?",
      "options": { "a": "Anaerobic digestion", "b": "Slow pyrolysis",
                   "c": "Transesterification", "d": "Steam reforming" },
      "correct_option": "b",
      "explanation": "Charcoal is derived from wood through a slow pyrolysis process...",
      "sources": [ { "document_type": "PH", "pdf_page": 15, "printed_page": 5,
                     "section": "UNIT 1.1: Fundamentals of Biofuels and Biomass Energy",
                     "chunk_id": "biofuels:PH:p15:19" } ]
    }
  ]
}
```

### How the question bank works

- **Questions accumulate across calls.** Submit one module at a time; pass
  `replace: true` to start over. Re-submitting a module replaces that module's
  questions.
- **Numbering is automatic.** `question_id` and `number` are assigned by the
  server in module order, so the bank reads continuously (1, 2, 3 …) no matter
  what order you submitted modules in.
- **Citations are required** on every question — they support the stem, the
  correct answer and the explanation.
- **The three wrong options are authored by you**, because a source document has
  no answer key. The server sets `distractors_authored: true` and prints a
  disclosure note in the document saying so. Distractors must be plausible but
  must not state any fact that isn't in the sources.
- **`strategy_points` defaults** to the standard seven SCGJ assessment guidelines
  if you omit it.
- Grounding overlap is measured on stem + correct answer + explanation only, so
  authored distractors don't drag the score down.

Question-bank findings you may see from `validate_storyboard`:

| Code | Severity | Meaning |
|---|---|---|
| `question_count` | error if 0, else warning | Module doesn't have 10 questions |
| `duplicate_question_number` | error | Two questions share a number |
| `duplicate_option` | error | Two options are identical, so there's no single right answer |
| `invalid_correct_option` | error | `correct_option` isn't a/b/c/d |
| `question_unknown_module` | error | Filed under a module not in this storyboard |
| `distractors_not_declared` | warning | `distractors_authored` wasn't set |

---

## Step 6 — Validate

```
validate_storyboard
{ "artifact_id": "SB-2026-00004" }
```

Aim for `errors: 0`. Findings you may see:

| Code | Severity | Meaning |
|---|---|---|
| `empty_field` | error | A field is still blank. |
| `missing_citation` | error | Content with no `sources`. |
| `unresolvable_citation` | error | `chunk_id` doesn't exist — you invented or mistyped it. |
| `wrong_chapter_citation` | error | You cited the wrong handbook chapter for this module. |
| `part_a_duration_mismatch` | error | Timing arithmetic broken. |
| `low_grounding_overlap` | warning | Your wording barely overlaps the chunk you cited. Either cite the right chunk or stay closer to the source. Lexical only — fine to accept on logistics text like a welcome slide. |
| `unit_not_mapped` | warning | A unit has no LMS mapping row. |
| `activity_not_in_part_a` | warning | LMS `activity_type` doesn't match a Part A activity. |

Fix by calling `set_storyboard_content` again with the corrected fields only.

---

## Step 7 — Render

```
render_storyboard_docx
{ "artifact_id": "SB-2026-00004" }
```

Returns `docx_path`, e.g.
`C:\cvc-mcp\artifacts\SB-2026-00004\SB-2026-00004-v2.docx`.

It **refuses if validation has errors** — that is deliberate. To see partial
output anyway, add `"allow_invalid": true`.

**In Word: `Ctrl+A` then `F9`** to refresh the table of contents page numbers.
Page numbers can't be computed without a layout engine, so the TOC is left as a
Word field for Word to recalculate.

---

## Step 8 — Test incremental editing and versioning

This is the part worth testing hardest, because it's the spec's key requirement.

```
set_storyboard_content
{ "artifact_id": "...", "base_version": 2, "module_number": 1,
  "slides": [ { "slide_id": "m01-c-s4",
                "instructor_script": "<simpler wording>",
                "sources": [ /* same chunk */ ] } ],
  "note": "Simplified the poll debrief" }
```

Then confirm with `get_storyboard` that **only that slide changed** and Part A is
untouched.

```
get_storyboard_history   { "artifact_id": "..." }
rollback_storyboard      { "artifact_id": "...", "to_version": 2, "reason": "test" }
```

Rollback creates a *new* version — the versions in between survive. Check with
`get_storyboard_history` again.

---

## Step 9 — Test the guard rails

Worth doing, so you trust the thing. All four should be refused or reported:

| Test | Call | Expected |
|---|---|---|
| Cross-course access | `search_course_content {course_id:"solar-pv", query:"anything"}` | error, unknown course |
| Timing override | `modify_storyboard_timing {module_number:1, requested_minutes:240}` | refused; document says 180 |
| Fabricated citation | submit `chunk_id:"biofuels:PH:p999:9999"` | `unresolvable_citation` |
| Wrong chapter | cite a chapter-5 chunk in module 5 | `wrong_chapter_citation` |
| No source content | `get_storyboard` on a draft including module 8 | `INSUFFICIENT_SOURCE_CONTENT` |

---

## Scaling up to the full course

Once one module works, draft the rest:

```
create_storyboard_draft { "course_id": "biofuels" }
```

Then repeat steps 4–6 per module, 1 through 7. Module 8 (Employability Skills)
cannot be generated — no source content exists in the supplied documents.

Remember the crosswalk when sanity-checking your retrieval: module 5 must draw
from handbook chapter 7, module 6 from chapter 8, module 7 from chapter 5. If a
module's content reads like the wrong subject, that's the first thing to check.

---

## Not yet possible

- **Front-matter xAPI/SCORM guideline bullets.** No tool populates these yet, so
  the two "Instructional Design and Behavioral Analytics" bullet lists render
  empty.
- **Module 8.** Needs the DGT/VSQ/N0102 Employability Skills workbook added as a
  fifth approved source document.

---

## Shortcut: let the model do it

If you would rather watch it work than type the calls, paste this into Antigravity
or Claude Code:

> Using the storyboard MCP: generate Module 1 of the Biofuels storyboard. First
> read `get_storyboard_field_spec` and `get_course_manifest`, then
> `create_storyboard_draft` for module 1 only. For each unit, call
> `search_course_content` with `module_number: 1` across PH, FG and QP, read the
> chunks, and write the Part A row, LMS row, and its share of the Part B script
> and Part C slides — citing the `chunk_id` of every chunk you actually used.
> Then write 10 questions for the module with `set_assessment_content`, citing the
> chunk each one tests. Then `validate_storyboard`, fix any errors, and
> `render_storyboard_docx`. Do not invent any fact that is not in the retrieved
> chunks.
