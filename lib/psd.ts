import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParticleCharacter } from "./character";

/**
 * BLOCK 5a - particle size distribution for a SITE.
 *
 * This describes the suspended sediment in the water, not anything about the
 * hydrocyclone. It is used only where no site-specific measurement exists; a
 * measured PSD or a filtration trial in data/field-observations.json or
 * data/trials.json always supersedes it.
 *
 * A log-normal curve is fitted through the d10/d50/d90 in
 * data/particle-sizes.json - a different spread below the median than above
 * it, so all three points land exactly where labelled (see the note on
 * sigmaLower/sigmaUpper below). Log-normal is the standard working
 * assumption for sediment: it is a modelling choice, and it is reported as
 * one.
 */

export interface Psd {
  d10Um: number;
  d50Um: number;
  d90Um: number;
  /** Where these numbers came from. "guessed" until a site measurement exists. */
  status: "guessed" | "measured";
  /** What this distribution is, in words, for the report. */
  label: string;
  note?: string;
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

/** Abramowitz & Stegun 7.1.26. |error| < 1.5e-7. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Acklam's inverse normal CDF. Accurate to ~1.15e-9 on (0,1). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q) /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

/** z-score of the 90th percentile. */
const Z90 = 1.2815515655446004;

/* ------------------------------------------------------------------ */
/* The distribution                                                    */
/* ------------------------------------------------------------------ */

/**
 * A single log-normal has two degrees of freedom (median, spread) but three
 * input points (d10, d50, d90), which are only mutually consistent with one
 * log-normal when d50 happens to equal sqrt(d10 * d90) - true for none of
 * the current guessed profiles except clay. Fitting one sigma from the
 * outer d90/d10 ratio alone (the previous approach) silently missed d10 and
 * d90 themselves by up to 35% on the current data: it honoured the median
 * and the overall spread, not the two endpoints the numbers are named after.
 *
 * Fixed by using a two-piece (split) log-normal instead: a different sigma
 * below the median than above it, each solved so its own endpoint lands
 * exactly on target. The two pieces are both valid log-normal CDFs anchored
 * at the same median, so they join continuously at exactly 0.5 - this is a
 * standard technique for building a distribution from three quantiles, not
 * an ad hoc patch.
 */

/** Log-space standard deviation for sizes at or below the median, fit to d10. */
export function sigmaLower(psd: Psd): number {
  return Math.log(Math.max(psd.d50Um / psd.d10Um, 1.0001)) / Z90;
}

/** Log-space standard deviation for sizes above the median, fit to d90. */
export function sigmaUpper(psd: Psd): number {
  return Math.log(Math.max(psd.d90Um / psd.d50Um, 1.0001)) / Z90;
}

/**
 * Geometric standard deviation implied by d10 and d90.
 * ln(d90) - ln(d10) spans 2 x 1.2816 standard deviations in log space.
 *
 * A SUMMARY statistic only - "how spread out is this, overall" - for
 * reporting and sanity-checking. It is exactly the average of
 * sigmaLower/sigmaUpper (the two telescope: half of ln(d90/d10) either way),
 * so it stays meaningful, but percentile calculations use the two-piece
 * sigmas above, not this one, because this one alone cannot reproduce d10
 * and d90 individually - see the note above.
 */
export function geometricStdDev(psd: Psd): number {
  return Math.exp(Math.log(psd.d90Um / psd.d10Um) / (2 * Z90));
}

/** Mass fraction (0..1) of solids finer than `sizeUm`. */
export function fractionFinerThan(psd: Psd, sizeUm: number): number {
  if (!(sizeUm > 0)) return 0;
  const sigma = sizeUm <= psd.d50Um ? sigmaLower(psd) : sigmaUpper(psd);
  return clamp(normCdf(Math.log(sizeUm / psd.d50Um) / sigma), 0, 1);
}

/** Mass fraction (0..1) coarser than `sizeUm` - what a sharp cut would retain. */
export function fractionCoarserThan(psd: Psd, sizeUm: number): number {
  return clamp(1 - fractionFinerThan(psd, sizeUm), 0, 1);
}

/** Mass fraction in the half-open interval [fromUm, toUm). */
export function massFractionBetween(psd: Psd, fromUm: number, toUm: number): number {
  return clamp(fractionFinerThan(psd, toUm) - fractionFinerThan(psd, fromUm), 0, 1);
}

/** Size below which `percent` % of the mass lies. */
export function sizeAtPercentile(psd: Psd, percent: number): number {
  const z = normInv(clamp(percent / 100, 0.0001, 0.9999));
  const sigma = z <= 0 ? sigmaLower(psd) : sigmaUpper(psd);
  return psd.d50Um * Math.exp(z * sigma);
}

/**
 * Discretises the distribution onto a logarithmic grid.
 *
 * Everything downstream integrates against this: the hydrocyclone's efficiency
 * varies with size, and so does each fraction's contribution to fouling, so
 * neither can be applied to a single average size.
 */
export interface SizeBin {
  loUm: number;
  hiUm: number;
  /** Geometric mean of the bin edges - the representative size. */
  midUm: number;
  massFraction: number;
}

export function binDistribution(psd: Psd, bins = 240, minUm = 0.05, maxUm = 3000): SizeBin[] {
  const out: SizeBin[] = [];
  const logMin = Math.log(minUm);
  const step = (Math.log(maxUm) - logMin) / bins;
  for (let i = 0; i < bins; i += 1) {
    const loUm = Math.exp(logMin + i * step);
    const hiUm = Math.exp(logMin + (i + 1) * step);
    const massFraction = massFractionBetween(psd, loUm, hiUm);
    if (massFraction > 1e-9) {
      out.push({ loUm, hiUm, midUm: Math.sqrt(loUm * hiUm), massFraction });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Loading from the data file                                          */
/* ------------------------------------------------------------------ */

interface ProfileFile {
  profiles: Record<string, { d10Um: number; d50Um: number; d90Um: number; status: string; note: string }>;
}

/**
 * The assumed distribution for a solids character.
 *
 * Returns a `status: "guessed"` PSD. Anything measured for the site must be
 * used in preference to this - see the roadmap note on block 5d below.
 */
export function psdForCharacter(character: ParticleCharacter): Psd {
  const file = JSON.parse(
    readFileSync(join(process.cwd(), "data", "particle-sizes.json"), "utf8"),
  ) as ProfileFile;
  const p = file.profiles[character];
  if (!p) throw new Error(`No particle size profile for character "${character}"`);
  return {
    d10Um: p.d10Um,
    d50Um: p.d50Um,
    d90Um: p.d90Um,
    status: "guessed",
    label: `Assumed distribution for a ${character.replace(/_/g, " ")} suspended load`,
    note: p.note,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : lo;
}

/* ==================================================================== */
/* ROADMAP - blocks 5b to 5e, not yet built                             */
/* ==================================================================== */
/*
 * Written out in plain English so this can be picked up cold. Each block is
 * independently testable; do not start one before the block above it is
 * proven.
 *
 * ------------------------------------------------------------------
 * BLOCK 5b - how well a hydrocyclone removes a given sediment
 * ------------------------------------------------------------------
 * The key realisation, from the user: a hydrocyclone does NOT have one
 * performance curve. It has a different one for every kind of sediment fed to
 * it. Crushed aquarium soil is not river silt. So performance data must be
 * stored per (hydrocyclone x feed material), never per hydrocyclone alone.
 *
 * Build this as `lib/separation.ts`:
 *
 *   1. DONE. Read data/hydrocyclones.json for the fallback d20/d50/d90 cut
 *      sizes. These are GUESSES. Three points define the shape of a
 *      grade-efficiency curve, which is better than a single cut size plus
 *      an assumed sharpness. Fit a curve through them - the reduced form
 *        G(d) = (d/d50)^m / (1 + (d/d50)^m)
 *      passes through 50 % at d50 by construction; solve m so the curve also
 *      passes near d20 and d90. See `fitSharpness` / `gradeEfficiencyCurve` /
 *      `gradeEfficiency` in lib/separation.ts, tested in tests/separation.test.ts.
 *
 *   2. NOT STARTED. Read data/trials.json for real before/after evidence.
 *      Where a trial exists for this hydrocyclone AND a comparable feed
 *      material, it supersedes the fitted curve. Say so in the output.
 *      What counts as "a comparable feed material" is a judgement call -
 *      confirm it with the user before coding it, rather than guessing.
 *
 *   3. NOT STARTED. Never let a guessed curve be reported as measured. Carry
 *      the status through, exactly as the geology and character modules do.
 *      (Step 1 already carries `hydrocyclone.status.cut` through unchanged;
 *      this item is about combining that with the trial's own status once
 *      step 2 exists.)
 *
 * A new hydrocyclone or a new feed material must be addable by editing JSON
 * only. No code change.
 *
 * ------------------------------------------------------------------
 * BLOCK 5c - what the membrane retains
 * ------------------------------------------------------------------
 * Simple: a sharp cut at the pore size, i.e. everything coarser is retained.
 * State the caveat that a real nominal-rated element passes some material
 * coarser than its rating.
 *
 * When data/membranes.json has `product.retentionUm` and `product.rating`
 * populated from a supplier page, use those in preference to the nominal pore
 * size. That is why those fields exist.
 *
 * ------------------------------------------------------------------
 * BLOCK 5d - the assessment. THE IMPORTANT ONE.
 * ------------------------------------------------------------------
 * The question is NOT "does the cyclone remove solids". It always removes
 * some. The question is:
 *
 *   Does removing what the cyclone can remove meaningfully extend how long
 *   the membrane runs before it blinds? "Meaningfully" = about 1.5x the
 *   filterable volume, per data/screening-parameters.json.
 *
 * The step everyone gets wrong: MASS REMOVED IS NOT FOULING REMOVED.
 * Specific cake resistance goes as 1/d^2 (Carman-Kozeny), so a gram of 2 um
 * silt resists roughly 100x as hard as a gram of 20 um sand. A cyclone strips
 * the coarse end, so it can remove most of the MASS while barely touching the
 * FOULING.
 *
 * For each (hydrocyclone x membrane) pair, integrate over the size bins:
 *
 *   retainedMass      = sum over bins where mid >= poreSize of massFraction
 *   foulingLoad       = sum over those bins of massFraction / mid^2
 *   foulingRemoved    = sum over those bins of massFraction * G(mid) / mid^2
 *   foulingReduction  = foulingRemoved / foulingLoad          <- decides it
 *
 * Then convert to the quantity the user actually cares about. Because volume
 * scales as 1/sqrt(load):
 *
 *   volumeRatio = 1 / sqrt(1 - foulingReduction)
 *
 * So a 56 % reduction gives 1.5x, and 75 % gives 2x. Verdicts:
 *
 *   volumeRatio >= 2.0                        promising (strong)
 *   volumeRatio >= 1.5                        promising
 *   volumeRatio >= 1.2                        marginal
 *   otherwise                                 unlikely
 *   retainedMass < minimumRetainedMassFraction  marginal, whatever the ratio,
 *       because there is almost nothing there to remove
 *   no separation data at all                 insufficient data - NOT a
 *       negative verdict; absence of evidence is not evidence of absence
 *
 * Every cell must carry: the four numbers above, the derived volume ratio,
 * a confidence, and reasoning in plain English. Confidence is the weakest
 * link in the chain - a guessed cut size caps everything at low, no matter
 * how good the geology is.
 *
 * NEVER report a volume ratio as a prediction when the inputs are guesses.
 * Report it as "what this model gives, given assumptions X, Y and Z".
 *
 * ------------------------------------------------------------------
 * BLOCK 5e - the report
 * ------------------------------------------------------------------
 * Group the cells into best / marginal / unlikely / insufficient-data, and
 * find the USEFUL WINDOW: the contiguous band of membrane ratings where
 * pre-treatment looks worthwhile. That window is the single most valuable
 * output, more than any individual cell.
 *
 * Sections, in the user's layout: the verdict, the configuration list,
 * WHY, WHAT WE KNOW, WHAT WE DON'T KNOW, RECOMMENDED TEST.
 *
 * RECOMMENDED TEST should always be the cheapest measurement that would most
 * improve confidence. Right now that is almost always a filtration trial:
 * filter a known volume of raw water through the target membrane, then the
 * same volume of hydrocyclone overflow, and compare - which measures the
 * volume ratio directly instead of inferring it.
 */
