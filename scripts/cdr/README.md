# CDR courses

A CDR course is not shaped like a qualification course. Biofuels and Solar PV each
have one Qualification Pack, one Participant Handbook, one Facilitator Guide and a
Timing Allocation Document, and every module is a chapter of the handbook. A CDR
course has none of those. It has a **master file** and a set of **reference
documents**, and the master file states which reference document each module is
built from and how long that module runs.

The master file is therefore both the routing table and the timing document. It is
never indexed: it states structure, not subject matter, and chunking it would put
routing instructions into the retrievable corpus where they could be cited as
though they were content.

## Onboarding a course

    1. mkdir courses/<course-id>
    2. put the master file at courses/<course-id>/master.docx
    3. node scripts/cdr/register-courses.mjs
    4. drop the reference PDFs into courses/<course-id>/, named as the script printed

Step 3 rewrites `src/courses/cdr-generated.ts`, which the course registry imports.
It is checked in so the routing the server will use is visible in a diff rather
than discovered at run time. Step 4's filenames are derived from the document
titles the master file uses, and the script prints which are present and which are
still missing.

Nothing else is required. The course appears in the menu as soon as it is
registered, and is offered for building as soon as every document is on disk; the
first time it is picked, the documents are indexed automatically.

Run `node scripts/cdr/register-courses.mjs --check` to verify the generated file is
current, e.g. in CI.

## What the master file must say

One line per module, naming its duration and its source:

    Module 3: Carbon removals through Pyrolysis - 3 Hours.
      Refer from **Carbon removals through Pyrolysis** document

A module split into units states each unit's own source and hours:

    Module 1: INTRODUCTION - 2 Hours
    1.1: Introduction to Climate Challenge refers to Module 1 of **GHG Accounting** - 1 hour
    1.2: Circular Carbon Economy refers to **Circular Carbon Economy & VCM** document - 1 hour

A module may name several documents, joined with `+`. "Module N of <document>"
scopes the reference to part of that document and is recorded as such.

Durations are read, never computed. If a module states no hours, or its units do
not sum to it, the parser refuses rather than distributing time by judgement.
