import type { Membrane, Trial } from "./data";
import { binDistribution, Z90, type Psd } from "./psd";
import { membraneRetention } from "./retention";

/**
 * BLOCK 6, rebuild phase 1 - the baseline: how much water the filter alone
 * is likely to pass before it blinds, with no pretreatment at all.
 *
 * This replaces the old self-contained "volumeRatio per hydrocyclone x
 * membrane cell" output. Per the user's own correction: the primary number
 * is a real, absolute volume - not a dimensionless multiplier - and every
 * pretreatment method (today: either hydrocyclone; later: flocculation) is
 * then expressed as an UPLIFT on top of this baseline, not a self-contained
 * verdict. See lib/assessment.ts for the uplift side.
 *
 * An absolute volume needs a calibration constant this project has never
 * had before: the dead-end cake filtration law from data/screening-
 * parameters.json is V proportional to 1/sqrt(alpha * c) - alpha (specific
 * cake resistance, the PSD-shape term: mass-fraction-weighted 1/d^2) AND c
 * (solids CONCENTRATION) both matter. The old volumeRatio math never needed
 * c explicitly because it only ever compared two volumes on the SAME feed,
 * same concentration - c cancelled out of the ratio. An absolute volume
 * does not get that cancellation, so c has to be in the model now, not
 * folded silently into a shape-only term (an earlier version of this file
 * did exactly that and the calibration constant swung 9x across trials
 * purely because of the concentration differences it was ignoring).
 *
 * The ONE place this project has real, measured absolute volumes AND their
 * matching concentrations is data/trials.json's bench baselines
 * (volumeBeforeMl, feed.concentrationMgL, feed.psd). Calibrate k in
 * `volumeMl = k / sqrt(concentrationMgL * alpha)` from those, then predict
 * a new site's volume the same way - but a new site's concentration is not
 * yet known (no measured-water-quality source is wired in - that is
 * rebuild phase 4). Until then, predictions assume the calibration set's
 * own mean concentration, clearly labelled as an assumption, confidence
 * capped low specifically because of it.
 *
 * This only works for a membrane pore size that at least one recorded trial
 * actually used. For any other pore size, there is no real calibration
 * anchor - the honest answer is "insufficient data" for the ABSOLUTE
 * volume, not an invented number. The relative uplift (lib/assessment.ts)
 * does not depend on this and is always computable.
 */

export interface VolumeRange {
  lowMl: number;
  midMl: number;
  highMl: number;
}

export interface BaselineCalibration {
  poreSizeUm: number;
  /** Geometric mean k, and the full real spread from the anchor trials. */
  kLow: number;
  kMid: number;
  kHigh: number;
  /** Mean concentration across the anchor trials - the assumption a prediction falls back to when the site's own concentration is unknown. */
  referenceConcentrationMgL: number;
  anchorTrialCount: number;
}

/**
 * Builds a Psd-compatible object from a trial's measured d20/d50/d90 (the
 * shape actually recorded for a feed), not the d10/d50/d90 the Psd
 * interface is keyed on. The same two-piece log-normal machinery in psd.ts
 * is reused unmodified: back-solving a synthetic d10Um that reproduces
 * exactly the sigma a d20 anchor implies (Z20's z-score, not Z90's) means
 * sigmaLower(psd) recomputes to the same value either way - this is an
 * algebraic equivalence, not an approximation.
 */
const Z20 = 0.8416212335729143; // |normInv(0.20)| - the 20th percentile's z-score magnitude.

export function psdFromMeasuredD20D50D90(d20Um: number, d50Um: number, d90Um: number): Psd {
  const sigmaFromD20 = Math.log(d50Um / d20Um) / Z20;
  const syntheticD10Um = d50Um * Math.exp(-Z90 * sigmaFromD20);
  return {
    d10Um: syntheticD10Um,
    d50Um,
    d90Um,
    status: "measured",
    label: "Trial feed's own measured particle size distribution",
  };
}

/** The PSD-shape term alone (alpha: mass-fraction-weighted 1/d^2 over what the membrane retains) - no concentration, no hydrocyclone. */
export function foulingLoadForMembrane(psd: Psd, membrane: Membrane): { retainedMass: number; foulingLoad: number } {
  const poreUm = membraneRetention(membrane).effectiveRetentionUm;
  const retainedBins = binDistribution(psd).filter((b) => b.midUm >= poreUm);
  const retainedMass = retainedBins.reduce((sum, b) => sum + b.massFraction, 0);
  const foulingLoad = retainedBins.reduce((sum, b) => sum + b.massFraction / b.midUm ** 2, 0);
  return { retainedMass, foulingLoad };
}

/**
 * Calibrates k per membrane pore size, from every recorded trial that has
 * a positive volumeBeforeMl, a measured feed PSD, and a measured
 * concentration. Multiple trials at the same pore size (this project's 5
 * concentration tiers of the same bench feed) give a genuine spread, not a
 * single-point fit - kLow/kHigh is that real range, not an invented error
 * bar.
 */
export function calibrateBaselines(trials: Trial[], membranesByPoreSize: Map<number, Membrane>): BaselineCalibration[] {
  const byPoreSize = new Map<number, { k: number; concentrationMgL: number }[]>();
  for (const t of trials) {
    if (t.status !== "recorded") continue;
    if (!(t.volumeBeforeMl! > 0)) continue;
    const poreSizeUm = t.filter?.poreSizeUm;
    const psd = t.feed?.psd;
    // The BASELINE concentration, paired with volumeBeforeMl - not
    // feed.concentrationMgL, which is the post-treatment value reaching
    // the membrane in this specific run and can differ from the baseline.
    const concentrationMgL = t.feed?.untreatedConcentrationMgL;
    if (!(poreSizeUm! > 0) || !psd || !(concentrationMgL! > 0)) continue;
    const membrane = membranesByPoreSize.get(poreSizeUm!);
    if (!membrane) continue;
    const trialPsd = psdFromMeasuredD20D50D90(psd.d20Um, psd.d50Um, psd.d90Um);
    const { foulingLoad: alpha } = foulingLoadForMembrane(trialPsd, membrane);
    if (!(alpha > 0)) continue;
    const k = t.volumeBeforeMl! * Math.sqrt(concentrationMgL! * alpha);
    if (!byPoreSize.has(poreSizeUm!)) byPoreSize.set(poreSizeUm!, []);
    byPoreSize.get(poreSizeUm!)!.push({ k, concentrationMgL: concentrationMgL! });
  }

  const out: BaselineCalibration[] = [];
  for (const [poreSizeUm, rows] of byPoreSize) {
    const ks = rows.map((r) => r.k);
    const concentrations = rows.map((r) => r.concentrationMgL);
    out.push({
      poreSizeUm,
      kLow: Math.min(...ks),
      kMid: ks.reduce((a, b) => a + b, 0) / ks.length,
      kHigh: Math.max(...ks),
      referenceConcentrationMgL: concentrations.reduce((a, b) => a + b, 0) / concentrations.length,
      anchorTrialCount: ks.length,
    });
  }
  return out;
}

/**
 * Predicts a baseline volume range for a new site's PSD, if a calibration
 * anchor exists for this membrane's pore size. Returns null - insufficient
 * data - otherwise. `siteConcentrationMgL` defaults to the calibration's
 * own reference concentration when the site's real concentration is
 * unknown (true today for every site - no measured-water-quality source
 * is wired in yet); callers should treat that default case as a further
 * reason to keep confidence low, not just the usual PSD/cut-size caveats.
 */
export function predictBaselineVolume(
  calibration: BaselineCalibration | undefined,
  alpha: number,
  siteConcentrationMgL?: number,
): VolumeRange | null {
  if (!calibration || !(alpha > 0)) return null;
  const c = siteConcentrationMgL ?? calibration.referenceConcentrationMgL;
  if (!(c > 0)) return null;
  return {
    lowMl: calibration.kLow / Math.sqrt(c * alpha),
    midMl: calibration.kMid / Math.sqrt(c * alpha),
    highMl: calibration.kHigh / Math.sqrt(c * alpha),
  };
}
