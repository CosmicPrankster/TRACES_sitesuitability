import type { Trial } from "./data";

/**
 * BLOCK 5b, continued - the first, unambiguous slice of "read data/trials.json
 * for real before/after evidence."
 *
 * The roadmap in lib/psd.ts asks for a trial to supersede the fitted curve
 * when it exists "for this hydrocyclone AND a comparable feed material" -
 * but deciding what counts as comparable in general (is a trial from one
 * clay river's site usable at another?) is a judgement call that risks
 * letting a bench trial masquerade as evidence it was never run to support.
 * That is left for a later, deliberate step.
 *
 * What needs no judgement call at all: a trial run at the EXACT site and
 * waterbody being screened. That is not "comparable" evidence, it is direct
 * evidence, and "measured beats modelled, always" applies without caveat.
 * This module covers only that case.
 */

/**
 * The measured volume ratio from a recorded trial - the quantity the whole
 * tool is trying to estimate, measured directly instead of inferred.
 * Returns null for a trial that is not usable: still awaiting data, or
 * missing one of the two volumes.
 */
export function measuredVolumeRatio(trial: Trial): number | null {
  if (trial.status !== "recorded") return null;
  if (!(trial.volumeBeforeMl! > 0) || !(trial.volumeAfterMl! > 0)) return null;
  return trial.volumeAfterMl! / trial.volumeBeforeMl!;
}

/**
 * A recorded trial for this exact hydrocyclone, at this exact site and
 * waterbody. Returns undefined if none exists yet - that is "insufficient
 * data", never treated as a negative result.
 */
export function findSiteTrial(
  trials: Trial[],
  hydrocycloneId: string,
  siteId: string,
  waterbodyId: string,
): Trial | undefined {
  return trials.find(
    (t) =>
      t.status === "recorded" &&
      t.hydrocycloneId === hydrocycloneId &&
      t.siteId === siteId &&
      t.waterbodyId === waterbodyId,
  );
}
