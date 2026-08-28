# Build log

Honest status of every block. A block is "done" only when it has been proven to
work, not when it has been written.

| # | Block | Status | Proven by |
|---|-------|--------|-----------|
| 1 | Data schemas + files | **done** | `npm test` — schema and integrity tests |
| 2 | Data-source probe | **done, unrun** | Written; must be run on a networked machine |
| 3 | Site + waterbody resolution | not started | blocked on block 2 results |
| 4 | Site research providers | not started | blocked on block 2 results |
| 5 | Screening engine | not started | |
| 6 | UI | not started | |
| 7 | AI conversation layer | not started | |

## Block 2 is the gate

Blocks 3 and 4 are deliberately **not started**. Building providers against
unverified API shapes is precisely what produced the previous useless version.

`scripts/probe.mjs` calls every candidate source and records exactly what comes
back. It must be run on a machine with internet access — the development
sandbox has none. Its output determines what gets built next, and what gets
dropped.

## Decisions taken, and why

**Everything guessed is labelled `"guessed"` in the data itself**, not in a
comment. The screening cannot silently promote a guess to a fact, because the
label travels with the value.

**Hydrocyclone parameters carry a `revisions` array.** Adjusting a parameter
from field data appends to it, so the provenance of every number is readable
from the file itself.

**The query log is keyed on `siteId` + `waterbodyId`.** Not on the text the user
typed. Two spellings of the same burn are the same site, and must not produce
two log entries.
