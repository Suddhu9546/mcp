# Building a Timing Allocation Document

The Timing Allocation Document is the only place durations enter this system
(INVARIANT 3). The parser reads them and never computes them, so where a course
has no such document one has to be authored. These two scripts do that.

    node scripts/timing/extract-structure.mjs <topics.docx> <course>-structure.json
    node scripts/timing/build-timing-pdf.mjs  <course>-structure.json courses/<dir>/timing.pdf

`extract-structure.mjs` reads a reviewed "Topics and Subtopics" .docx into
modules, units and subtopics. That document is the right input rather than the
handbook PDF because it has already reconciled the cover pages against the body
headings; the raw handbook has not, and its numbering is internally inconsistent.

`build-timing-pdf.mjs` writes the PDF in the shape `src/timing/timing-parser.ts`
reads. It decides each unit's minutes -- the only thing in the pipeline permitted
to -- by splitting the module's duration across its units in 15-minute blocks,
weighted by subtopic count with a floor, so the units always sum exactly to the
module. Course constants (name, QP code, NSQF level, hours per module) are at the
top of that file.

Check the result with `npx tsx scripts/parse-timing.ts <course_id>`, which prints
every module and unit and reports whether the arithmetic is exact.

Course constants live in the structure file, not the script: `course_name`,
`qp_code`, `nsqf_level`, and either a course-wide `module_hours` or a per-module
`hours`. A course whose modules differ in length states each module's `hours`,
which is where the reviewed module timings for Green Hydrogen and Agri-Residue
come from. Nothing is inferred -- a module with no stated hours falls back to the
course-wide constant, and Solar Photovoltaic Entrepreneur's original values
remain the defaults so its document regenerates unchanged.

The extracted inputs are kept so each timing.pdf can be regenerated rather than
only edited:

    solar-pv-structure.json               Solar Photovoltaic Entrepreneur
    green-hydrogen-structure.json         Green Hydrogen Plant Entrepreneur
    agri-residue-aggregator-structure.json  Agri-Residue Aggregator

Solar's came from a reviewed "Topics and Subtopics" .docx via
`extract-structure.mjs`. The other two have no such document, so their modules,
units and subtopics were read from the Participant Handbook -- unit titles from
the table of contents, which prints them unwrapped, and subtopics from the
printed body headings. Units are renumbered by position and subtopics
sequentially within their unit, because both handbooks number them
inconsistently: Green Hydrogen prints two headings as 2.1.1, skips 4.2.2, and
labels one 2.2.6.4; Agri-Residue prints 5.1.1 as 5-1-1 and repeats 6.1.5. Where a
unit is written as continuous narrative with no numbered headings -- Green
Hydrogen Unit 6.2 -- it carries a single subtopic repeating the unit title, as
Solar's Units 6.2 and 9.2 do.

Agri-Residue's Module 7 is Employability Skills, which its handbook covers only
by a link to the common workbook. Its three units are the same ones the Biofuels
timing document states for that module.
