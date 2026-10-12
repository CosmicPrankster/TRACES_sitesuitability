import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hydrocyclone, Membrane, Trial, ValueStatus } from "./data";
import { binDistribution, type Psd } from "./psd";
import { gradeEfficiency, gradeEfficiencyCurve } from "./separation";
import { membraneRetention } from "./retention";
import {
  calibrateBaselines,
  foulingLoadForMembrane,
  predictBaselineVolume,
  type BaselineCalibration,
  type SiteConcentration,
  type VolumeRange,
} from "./baseline";

/**
 * BLOCK 5d, REBUILT (rebuild phase 1) - the assessment.
 *
 * Per the user's correction, the primary number is no longer a self-
 * contained verdict per hydrocyclone x membrane cell. It is:
 *
 *   baseline   how much water the filter alone is likely to pass before it
 *              blinds - a real volume (lib/baseline.ts), or honestly
 *              "insufficient data" where no trial calibrates this pore size
 *   uplift     for each available PRETREATMENT METHOD (today: either
 *              hydrocyclone; later: flocculation, as a second method in the
 *              same list), how much MORE volume it adds on top of the
 *              baseline - a range + category + confidence, never a
 *              self-contained absolute number
 *   recommendation  filter alone / run more replicates / a named
 *              pretreatment method / sample the sediment instead - chosen
 *              by comparing the uplifts, not a bespoke decision tree
 *
 * The physics underneath the uplift is UNCHANGED from the original block
 * 5d: mass removed is not fouling removed (Carman-Kozeny, 1/d^2), and
 * volume scales as 1/sqrt(fouling load). What changed is the framing: a
 * multiplier ON TOP OF a real baseline, not a free-standing ratio.
 */

export type Category = "likely" | "marginal" | "unlikely";
export type Confidence = "low" | "medium" | "high";

export interface MultiplierRange {
  low: number;
  mid: number;
  high: number;
}

export interface UpliftResult {
  methodId: string;
  methodLabel: string;
  /** Mass fraction of the feed the membrane would retain, untreated. */
  retainedMass: number;
  /** That mass, weighted by 1/d^2 - the fouling load, not the mass. */
  foulingLoad: number;
  /** The part of that load this method removes first. */
  foulingRemoved: number;
  /** foulingRemoved / foulingLoad - the number the uplift is built from. */
  foulingReduction: number;
  /** Additional volume multiplier on top of baseline - 1.0 means no benefit. */
  multiplier: MultiplierRange;
  category: Category | "insufficient-data";
  confidence: Confidence;
  reasoning: string;
}

export type MethodRecommendation =
  | { kind: "filter-alone"; reasoning: string }
  | { kind: "more-replicates"; reasoning: string }
  | { kind: "pretreatment"; methodId: string; methodLabel: string; reasoning: string }
  | { kind: "sample-sediment"; reasoning: string };

export interface MembraneAssessment {
  membraneId: string;
  /** null = insufficient data for an absolute number, not a guess at one. */
  baselineVolume: VolumeRange | null;
  baselineConfidence: Confidence;
  baselineReasoning: string;
  uplifts: UpliftResult[];
  recommendation: MethodRecommendation;
}

interface ScreeningParams {
  upliftCategory: { likelyMultiplier: number; marginalMultiplier: number };
  upliftRangeMargin: { byConfidence: Record<Confidence, number> };
  minimumRetainedMassFraction: { value: number };
}

let cachedParams: ScreeningParams | undefined;

function loadScreeningParams(): ScreeningParams {
  if (!cachedParams) {
    cachedParams = JSON.parse(
      readFileSync(join(process.cwd(), "data", "screening-parameters.json"), "utf8"),
    ) as ScreeningParams;
  }
  return cachedParams;
}

/** How much a hydrocyclone's guessed-vs-measured cut sizes count against confidence. */
function cutLevel(status: ValueStatus): 0 | 1 | 2 {
  return status === "measured" ? 2 : status === "field-adjusted" ? 1 : 0;
}

function psdLevel(status: Psd["status"]): 0 | 2 {
  return status === "measured" ? 2 : 0;
}

function membraneLevel(source: "measured-product" | "nominal-pore-size"): 0 | 2 {
  return source === "measured-product" ? 2 : 0;
}

/** Confidence is the weakest link in the chain, never an average of the three. */
function overallConfidence(...levels: number[]): Confidence {
  const weakest = Math.min(...levels);
  return weakest >= 2 ? "high" : weakest >= 1 ? "medium" : "low";
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

function categorise(multiplierMid: number, params: ScreeningParams): Category {
  const { likelyMultiplier, marginalMultiplier } = params.upliftCategory;
  if (multiplierMid >= likelyMultiplier) return "likely";
  if (multiplierMid >= marginalMultiplier) return "marginal";
  return "unlikely";
}

/** +/- a confidence-tier-set margin around the point multiplier, in log space so the range stays positive and symmetric in relative terms. */
function multiplierRange(mid: number, confidence: Confidence, params: ScreeningParams): MultiplierRange {
  const margin = params.upliftRangeMargin.byConfidence[confidence];
  const logMid = Math.log(mid);
  return {
    low: Math.max(1, Math.exp(logMid - margin)),
    mid,
    high: Math.exp(logMid + margin),
  };
}

/**
 * One pretreatment method's uplift for one PSD x membrane pair. Exported so
 * a future method (flocculation) can be slotted in alongside hydrocyclones
 * without changing assessMembrane's shape - it only needs a grade-
 * efficiency-shaped curve, which gradeEfficiencyCurve already produces for
 * a hydrocyclone's guessed/measured cut sizes.
 */
export function assessUplift(psd: Psd, membrane: Membrane, hydrocyclone: Hydrocyclone): UpliftResult {
  const params = loadScreeningParams();
  const curve = gradeEfficiencyCurve(hydrocyclone);
  const retention = membraneRetention(membrane);
  const poreUm = retention.effectiveRetentionUm;
  const methodLabel = hydrocyclone.name;

  if (!Number.isFinite(curve.sharpness) || !(poreUm > 0)) {
    return {
      methodId: hydrocyclone.id,
      methodLabel,
      retainedMass: 0,
      foulingLoad: 0,
      foulingRemoved: 0,
      foulingReduction: 0,
      multiplier: { low: 1, mid: 1, high: 1 },
      category: "insufficient-data",
      confidence: "low",
      reasoning: "No usable separation curve for this hydrocyclone, so no basis for a verdict. This is absence of evidence, not evidence of no benefit.",
    };
  }

  const { retainedMass, foulingLoad } = foulingLoadForMembrane(psd, membrane);
  const retainedBins = binDistribution(psd).filter((b) => b.midUm >= poreUm);
  const foulingRemoved = retainedBins.reduce(
    (sum, b) => sum + (b.massFraction * gradeEfficiency(curve, b.midUm)) / b.midUm ** 2,
    0,
  );
  const foulingReduction = foulingLoad > 0 ? clamp01(foulingRemoved / foulingLoad) : 0;
  const multiplierMid = foulingReduction < 1 ? 1 / Math.sqrt(1 - foulingReduction) : Infinity;

  const tooLittleToRemove = retainedMass < params.minimumRetainedMassFraction.value;
  const confidence = overallConfidence(
    psdLevel(psd.status),
    cutLevel(hydrocyclone.status.cut),
    membraneLevel(retention.source),
  );

  const category: Category = tooLittleToRemove ? "marginal" : categorise(multiplierMid, params);
  const multiplier = Number.isFinite(multiplierMid)
    ? multiplierRange(multiplierMid, confidence, params)
    : { low: multiplierMid, mid: multiplierMid, high: multiplierMid };

  const reasoning = tooLittleToRemove
    ? `Only ${(retainedMass * 100).toFixed(1)}% of the feed is coarse enough for the ${membrane.label} membrane to retain in the first place - below the threshold where there is almost nothing there to remove, whatever the cyclone's efficiency. Called marginal regardless of the ${multiplierMid.toFixed(2)}x figure the model otherwise gives.`
    : `Removing what the ${hydrocyclone.name} can catch cuts the fouling load by ${(foulingReduction * 100).toFixed(0)}%, which - because filtered volume scales as 1/sqrt(load) - this model translates to about ${multiplierMid.toFixed(2)}x the baseline filterable volume on top of filtering alone: ${category}. Confidence: ${confidence} - ${confidenceCaveat(psd, hydrocyclone, retention.source)}`;

  return {
    methodId: hydrocyclone.id,
    methodLabel,
    retainedMass,
    foulingLoad,
    foulingRemoved,
    foulingReduction,
    multiplier,
    category,
    confidence,
    reasoning,
  };
}

function confidenceCaveat(psd: Psd, hydrocyclone: Hydrocyclone, membraneSource: "measured-product" | "nominal-pore-size"): string {
  const weakLinks: string[] = [];
  if (psd.status !== "measured") weakLinks.push("the site's particle size distribution is a guess");
  if (hydrocyclone.status.cut !== "measured") weakLinks.push(`the ${hydrocyclone.name}'s cut sizes are ${hydrocyclone.status.cut}`);
  if (membraneSource !== "measured-product") weakLinks.push("the membrane's retention size is the nominal pore size, not a supplier figure");
  return weakLinks.length === 0
    ? "every input behind this number is measured, not guessed."
    : `capped by the weakest input(s): ${weakLinks.join("; ")}.`;
}

function recommend(
  baselineVolume: VolumeRange | null,
  uplifts: UpliftResult[],
  membrane: Membrane,
): MethodRecommendation {
  const real = uplifts.filter((u) => u.category !== "insufficient-data");
  const rank = (c: Category | "insufficient-data") => (c === "likely" ? 2 : c === "marginal" ? 1 : 0);
  const best = real.reduce<UpliftResult | null>((acc, u) => {
    if (!acc) return u;
    if (rank(u.category) !== rank(acc.category)) return rank(u.category) > rank(acc.category) ? u : acc;
    return u.multiplier.mid > acc.multiplier.mid ? u : acc;
  }, null);

  if (!baselineVolume && (!best || best.category !== "likely")) {
    return {
      kind: "sample-sediment",
      reasoning: `There is no calibrated baseline volume for the ${membrane.label} membrane and no pretreatment method clearly helps enough to recommend on its own - the honest next step is a raw-water sediment sample, not a guess at either number.`,
    };
  }

  if (!best || best.category === "unlikely") {
    return {
      kind: "filter-alone",
      reasoning: `No pretreatment method tested reaches a worthwhile uplift for the ${membrane.label} membrane - filtering alone is the simplest option that performs about as well.`,
    };
  }

  if (best.category === "marginal") {
    return {
      kind: "more-replicates",
      reasoning: `${best.methodLabel}'s uplift for the ${membrane.label} membrane sits in the marginal band (confidence: ${best.confidence}) - worth confirming with replicate bench runs before committing to it either way, rather than deciding on one model estimate.`,
    };
  }

  return {
    kind: "pretreatment",
    methodId: best.methodId,
    methodLabel: best.methodLabel,
    reasoning: `${best.methodLabel} gives a likely uplift (${best.multiplier.mid.toFixed(2)}x, confidence: ${best.confidence}) for the ${membrane.label} membrane - the best-supported option tested.`,
  };
}

/**
 * Full assessment for one membrane: baseline + every available pretreatment
 * method's uplift + a recommendation. `calibrations` is the real baseline
 * calibration (lib/baseline.ts) - compute it once per trial set and pass
 * it to every membrane in a matrix rather than recalibrating per call.
 */
export function assessMembrane(
  psd: Psd,
  membrane: Membrane,
  hydrocyclones: Hydrocyclone[],
  calibrations: BaselineCalibration[],
  siteConcentration?: SiteConcentration,
): MembraneAssessment {
  const { foulingLoad } = foulingLoadForMembrane(psd, membrane);
  const calibration = calibrations.find((c) => c.poreSizeUm === membrane.poreSizeUm);
  const baselineVolume = predictBaselineVolume(calibration, foulingLoad, siteConcentration?.mgL);

  // Never an average of the two factors - the weaker one caps it, same
  // discipline as overallConfidence above. A real measured concentration
  // is worth a step up even with a guessed PSD (medium, not low); both
  // real together is the one case allowed to reach high - see the
  // predictBaselineVolume caller contract in lib/baseline.ts.
  const psdIsMeasured = psd.status === "measured";
  const concentrationIsReal = Boolean(siteConcentration);
  const baselineConfidence: Confidence = !baselineVolume
    ? "low"
    : psdIsMeasured && concentrationIsReal
      ? "high"
      : psdIsMeasured || concentrationIsReal
        ? "medium"
        : "low";

  const baselineReasoning = baselineVolume
    ? siteConcentration
      ? `Calibrated against ${calibration!.anchorTrialCount} real bench trials at this membrane's pore size, scaled to this feed's predicted fouling load, using a real measured solids concentration near this site (${siteConcentration.mgL.toFixed(0)} mg/L, ${siteConcentration.source}) rather than the calibration trials' own reference concentration.`
      : `Calibrated against ${calibration!.anchorTrialCount} real bench trials at this membrane's pore size, scaled to this feed's predicted fouling load. Assumes a reference solids concentration (${calibration!.referenceConcentrationMgL.toFixed(0)} mg/L, the calibration trials' own mean) because no measured concentration exists for this site yet - that is the main reason this stays low confidence even with a real calibration behind it.`
    : `No recorded trial used a ${membrane.poreSizeUm} µm filter, so there is no real calibration anchor for an absolute volume at this pore size - insufficient data, not a guessed number. The relative uplift below does not depend on this.`;

  const uplifts = hydrocyclones.map((h) => assessUplift(psd, membrane, h));
  const recommendation = recommend(baselineVolume, uplifts, membrane);

  return { membraneId: membrane.id, baselineVolume, baselineConfidence, baselineReasoning, uplifts, recommendation };
}

/** Every membrane's full assessment, for one site's PSD. */
export function assessSite(
  psd: Psd,
  membranes: Membrane[],
  hydrocyclones: Hydrocyclone[],
  trials: Trial[],
  siteConcentration?: SiteConcentration,
): MembraneAssessment[] {
  const membranesByPoreSize = new Map(membranes.map((m) => [m.poreSizeUm, m]));
  const calibrations = calibrateBaselines(trials, membranesByPoreSize);
  return membranes.map((m) => assessMembrane(psd, m, hydrocyclones, calibrations, siteConcentration));
}
