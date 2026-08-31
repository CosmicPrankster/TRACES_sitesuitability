import type { Hydrocyclone, ValueStatus } from "./data";

/**
 * BLOCK 5b - how well a hydrocyclone removes a given sediment.
 *
 * FIRST INCREMENT ONLY: fit a grade-efficiency curve to the guessed d20/d50/
 * d90 cut sizes in data/hydrocyclones.json. This deliberately does not yet
 * read data/trials.json - that override, and the "never report a guessed
 * curve as measured" status logic that comes with it, is the next increment,
 * built once this one is confirmed to behave correctly on its own.
 *
 * A hydrocyclone does not have one performance curve; it has a different one
 * for every feed material. Nothing here should be read as "the" curve for a
 * hydrocyclone - it is the curve implied by the guessed cut sizes alone.
 *
 * Reduced grade-efficiency form (Plitt-style), which passes through 50 % at
 * d50 by construction:
 *
 *   G(d) = (d / d50)^m / (1 + (d / d50)^m)
 *
 * A single m cannot make this pass through three arbitrary points, so m is
 * fitted separately against d20 and d90 and the two estimates are averaged.
 * That is a modelling choice, not a measurement, and the curve's status is
 * carried through from `hydrocyclone.status.cut` accordingly.
 */

export interface GradeEfficiencyCurve {
  hydrocycloneId: string;
  d50Um: number;
  /** Sharpness of cut. Higher = closer to an ideal step at d50. */
  sharpness: number;
  status: ValueStatus;
  source: "fitted-curve";
}

/**
 * Sharpness (m) implied by the three cut sizes, fitted against d20 and d90
 * and averaged. Exported so the fit itself is directly testable.
 */
export function fitSharpness(cut: { d20Um: number; d50Um: number; d90Um: number }): number {
  const { d20Um, d50Um, d90Um } = cut;
  // At G=0.2: (d20/d50)^m = 0.2 / (1 - 0.2) = 0.25
  const m20 = Math.log(0.25) / Math.log(d20Um / d50Um);
  // At G=0.9: (d90/d50)^m = 0.9 / (1 - 0.9) = 9
  const m90 = Math.log(9) / Math.log(d90Um / d50Um);
  return (m20 + m90) / 2;
}

/** Builds the fitted curve for one hydrocyclone from its catalogue cut sizes. */
export function gradeEfficiencyCurve(hydrocyclone: Hydrocyclone): GradeEfficiencyCurve {
  return {
    hydrocycloneId: hydrocyclone.id,
    d50Um: hydrocyclone.cut.d50Um,
    sharpness: fitSharpness(hydrocyclone.cut),
    status: hydrocyclone.status.cut,
    source: "fitted-curve",
  };
}

/**
 * Mass fraction (0..1) of particles of `sizeUm` that report to the
 * underflow - i.e. that the hydrocyclone removes - according to the curve.
 */
export function gradeEfficiency(curve: GradeEfficiencyCurve, sizeUm: number): number {
  if (!(sizeUm > 0)) return 0;
  const ratio = (sizeUm / curve.d50Um) ** curve.sharpness;
  if (!Number.isFinite(ratio)) return 1;
  return clamp(ratio / (1 + ratio), 0, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : lo;
}

/* ==================================================================== */
/* NOT YET BUILT - the rest of block 5b                                 */
/* ==================================================================== */
/*
 * - Read data/trials.json for real before/after evidence. Where a trial
 *   exists for this hydrocyclone AND a comparable feed material, it must
 *   supersede the fitted curve above, and the returned status must become
 *   whatever the trial's own status is (never silently "guessed" once real
 *   data exists, never silently "measured" if the trial is still
 *   awaiting-data).
 * - Decide what "a comparable feed material" means well enough to code it -
 *   this is a judgement call the user should confirm before it is built,
 *   because getting it wrong would let a bench trial masquerade as evidence
 *   for a natural feed it was never run on.
 */
