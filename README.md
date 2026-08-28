# Hydrocyclone + membrane site screening

Enter a site and waterbody. Get a screening of which hydrocyclone and membrane
combinations are worth investigating, and why.

**Status: rebuilding, block by block.** See `BUILD.md` for what exists and what
does not. Nothing here claims to work until it has been proven to work.

## The rule this project is built on

> A number that has not been verified is labelled as a guess, every time it is
> shown. A data source that has not been proven to respond is not built on.

The previous version looked finished and was useless: it produced a confident
screening for every site from placeholder values, because the data lookups it
depended on had never actually been run. This rebuild inverts the order —
sources are proven first, then built on.

## Where things are

```
data/
  hydrocyclones.json        equipment: diameter, cut sizes, operating envelope
  membranes.json            filtration ratings, populated from product pages
  field-observations.json   what you saw at a site
  query-log.json            every screening run, keyed by site + waterbody
scripts/
  probe.mjs                 tests every candidate data source, live
```

## Quick start

```bash
npm install
node scripts/probe.mjs "Kinness Burn, St Andrews"
```
