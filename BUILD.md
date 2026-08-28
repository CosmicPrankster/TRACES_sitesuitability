# Build log

Honest status of every block. A block is "done" only when it has been proven to
work, not when it has been written.

| # | Block | Status | Proven by |
|---|-------|--------|-----------|
| 1 | Data schemas + files | **done** | `npm test` — schema and integrity tests |
| 2 | Data-source probe | **v1 run, v2 pending** | v1 run on a networked machine; results below |
| 3 | Site + waterbody resolution | not started | blocked on block 2 results |
| 4 | Site research providers | not started | blocked on block 2 results |
| 5 | Screening engine | not started | |
| 6 | UI | not started | |
| 7 | AI conversation layer | not started | |

## Probe v1 results (run 2026-08-28, real network)

Two sites: "Tilford, River Wey" and "Kinness Burn, St Andrews".

| Source | Result | Verdict |
|---|---|---|
| Geocoding (Open-Meteo + Nominatim) | Both work | **Keep** |
| EA real-time level + rainfall | Works in England; empty in Scotland, as expected | **Keep**, slow (10-18 s) |
| BGS service discovery | `BGS_Detailed_Geology`, layers 3 = Superficial, 4 = Bedrock | **Keep** |
| BGS identify at a point | Responded, **returned nothing** | **Must fix** — this is the main differentiator |
| EA Water Quality Archive | HTTP 404 | Wrong URL; retrying other forms |
| EA Catchment Data Explorer | HTTP 404 | Wrong URL; retrying other forms |
| SEPA river levels | `fetch failed` (DNS/TLS) | Retrying other hosts |

Two findings that matter more than the pass/fail list:

**The probe itself was misleading.** It reported "ok" for a response that
contained no records, which hid the BGS failure and made an empty Scottish EA
result look like a success. v2 distinguishes *responded* from *responded with
data*, and only the latter counts.

**Geocoding silently changed the question.** "Tilford, River Wey" matched
nothing, so it fell back to "River Wey" and returned a generic point in Surrey
about 4 km from Tilford. The screening would have been for the wrong place, with
no indication. Block 3 must confirm the waterbody with the user rather than
quietly accepting a fallback match.

## What v2 tests

- **BGS identify, six ways** — explicit layer ids (scale-dependent visibility is
  the prime suspect, since `layers=all` means "all *visible*"), wider extents,
  larger tolerance, British National Grid coordinates, and WMS GetFeatureInfo as
  a different protocol. Plus the `GeologyOfBritain` and `GeoIndex_Onshore`
  service folders.
- **NRFA** (National River Flow Archive) — new, and **UK-wide**, so it covers
  Kinness Burn where the EA cannot. Holds catchment area, river name and
  catchment properties.
- **EA water quality and catchment** — five URL forms each.
- **SEPA** — three alternative hosts.

`scripts/lib/bng.mjs` converts WGS84 to British National Grid (Helmert plus
transverse Mercator), verified against St Andrews and OS HQ Southampton.

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
