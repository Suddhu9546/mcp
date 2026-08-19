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

`solar-pv-structure.json` is the extracted input for Solar Photovoltaic
Entrepreneur, kept so its timing.pdf can be regenerated rather than only edited.
