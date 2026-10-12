import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * BLOCK 6, rebuild phase 10 - the literature-estimated baseline, per the
 * user's own framing: "it will be impossible to collect trial data for
 * everywhere in the UK... so we need to infer to a certain degree." See
 * lib/baseline.ts's estimateBaselineVolume for where this feeds in, and
 * data/sediment-properties.json for the real cited porosity/density values
 * and the full reasoning for why the ranges are this wide.
 *
 * THE CORE IDEA: the trial-calibrated k constant (lib/baseline.ts) silently
 * assumes the bench trial feed's own porosity/density applies to every
 * site, regardless of its real character - fine for a 5 um prediction on a
 * similarly fine feed, wrong in an unstated way for anything else. This
 * module corrects k by the RATIO of Carman-Kozeny prefactors between the
 * trial feed's own measured grain-size class and the target site's -
 * which means the apparatus constants (filter area, pressure, Kozeny's own
 * K constant, unit conversions) are IDENTICAL on both sides of the ratio
 * and cancel out exactly. Only porosity and particle density are needed,
 * nothing else - see data/sediment-properties.json's own header for why
 * that matters (those two values are much easier to defend from published
 * literature than the apparatus constants would be).
 */

export type GrainSizeClass = "clay" | "silt" | "sand";

/**
 * The real measured feed PSD across all 10 recorded bench trials has a d50
 * of 22-31 um - genuinely silt-class by the same Wentworth boundaries
 * lib/field-update.ts already uses (clay <4 um, silt 4-63 um, sand >=63 um),
 * not an assumption. Every baseline calibration in data/trials.json today
 * is implicitly a silt-class calibration.
 */
export const TRIAL_FEED_CLASS: GrainSizeClass = "silt";

/**
 * Classifies a PSD by its OWN d50 against the standard Udden-Wentworth
 * grain-size boundaries - the same real, published boundaries
 * lib/field-update.ts's grain-card classes use, not a new threshold
 * invented for this module. Works identically whether the PSD came from a
 * character guess, a field reading, or a measured trial feed - it only
 * ever looks at the number, never at where it came from.
 */
export function grainSizeClassForD50(d50Um: number): GrainSizeClass {
  if (d50Um < 4) return "clay";
  if (d50Um < 63) return "silt";
  return "sand";
}

export interface SedimentClassProperties {
  porosityLow: number;
  porosityMid: number;
  porosityHigh: number;
  particleDensityKgM3: number;
  note: string;
}

interface SedimentPropertiesFile {
  classes: Record<GrainSizeClass, SedimentClassProperties>;
}

let cached: Record<GrainSizeClass, SedimentClassProperties> | undefined;

export function loadSedimentProperties(): Record<GrainSizeClass, SedimentClassProperties> {
  if (!cached) {
    const file = JSON.parse(
      readFileSync(join(process.cwd(), "data", "sediment-properties.json"), "utf8"),
    ) as SedimentPropertiesFile;
    cached = file.classes;
  }
  return cached;
}

/**
 * The Carman-Kozeny specific-resistance PREFACTOR, proportional terms only:
 * (1-porosity) / (porosity^3 * particleDensity). The Kozeny constant and
 * every unit-conversion factor are left out on purpose - they are identical
 * for any two materials compared by ratio (see characterCorrectionFactor),
 * so they cancel out and do not need to be got exactly right here.
 */
export function porosityPrefactor(porosity: number, particleDensityKgM3: number): number {
  return (1 - porosity) / (porosity ** 3 * particleDensityKgM3);
}

export interface BaselineEstimateCorrection {
  low: number;
  mid: number;
  high: number;
}

/**
 * How much to scale the trial-calibrated k for a site whose inferred
 * sediment sits in `siteClass` rather than the trial feed's own
 * TRIAL_FEED_CLASS. A HIGHER porosity gives a LOWER Carman-Kozeny
 * prefactor (an easier-to-filter-through cake), which means a BIGGER k and
 * a BIGGER predicted volume - so the site's own porosityLow maps to the
 * low end of the correction and porosityHigh to the high end, not the
 * reverse. Returns the full published range as low/mid/high, not a single
 * number: this uncertainty is real (see data/sediment-properties.json),
 * especially for clay, not a modelling nicety to average away.
 */
export function characterCorrectionFactor(siteClass: GrainSizeClass): BaselineEstimateCorrection {
  const properties = loadSedimentProperties();
  const trial = properties[TRIAL_FEED_CLASS];
  const site = properties[siteClass];
  const trialPrefactor = porosityPrefactor(trial.porosityMid, trial.particleDensityKgM3);
  const factorFor = (porosity: number) => Math.sqrt(trialPrefactor / porosityPrefactor(porosity, site.particleDensityKgM3));
  return {
    low: factorFor(site.porosityLow),
    mid: factorFor(site.porosityMid),
    high: factorFor(site.porosityHigh),
  };
}
