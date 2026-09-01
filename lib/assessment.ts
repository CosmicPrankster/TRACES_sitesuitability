import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hydrocyclone, Membrane, ValueStatus } from "./data";
import { binDistribution, type Psd } from "./psd";
import { gradeEfficiency, gradeEfficiencyCurve } from "./separation";
import { membraneRetention } from "./retention";

/**
 * BLOCK 5d - the assessment. THE IMPORTANT ONE.
 *
 * The question is NOT "does the cyclone remove solids". It always removes
 * some. The question is: does removing what it CAN remove meaningfully
 * extend how long the membrane runs before it blinds?
 *
 * The step everyone gets wrong: MASS REMOVED IS NOT FOULING REMOVED.
 * Specific cake resistance goes as 1/d^2 (Carman-Kozeny), so a gram of
 * 2 um silt resists roughly 100x as hard as a gram of 20 um sand. A
 * hydrocyclone strips the coarse end, so it can remove most of the mass
 * while barely touching the fouling.
 *
 * This runs entirely on the literature/physics path already built - a
 * guessed PSD (5a), a fitted grade-efficiency curve (5b), a sharp cut at a
 * literature-or-nominal retention size (5c) - with no trial data required.
 * Where a real trial exists later, it supersedes this at the volumeRatio
 * level (see lib/trials.ts); that override is not built here.
 */

export type Verdict = "strong" | "promising" | "marginal" | "unlikely" | "insufficient-data";
export type Confidence = "low" | "medium" | "high";

export interface AssessmentCell {
  hydrocycloneId: string;
  membraneId: string;
  /** Mass fraction of the feed the membrane would retain, untreated. */
  retainedMass: number;
  /** That mass, weighted by 1/d^2 - the fouling load, not the mass. */
  foulingLoad: number;
  /** The part of that load the cyclone removes first. */
  foulingRemoved: number;
  /** foulingRemoved / foulingLoad - the number that decides the verdict. */
  foulingReduction: number;
  /** 1 / sqrt(1 - foulingReduction). Infinity only if foulingReduction reaches 1. */
  volumeRatio: number;
  verdict: Verdict;
  confidence: Confidence;
  reasoning: string;
}

interface ScreeningParams {
  volumeTargets: { marginalVolumeRatio: number; promisingVolumeRatio: number; strongVolumeRatio: number };
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

/**
 * The core block-5d computation for one hydrocyclone x membrane pair,
 * given a site's (guessed or measured) particle size distribution.
 */
export function assessPair(psd: Psd, hydrocyclone: Hydrocyclone, membrane: Membrane): AssessmentCell {
  const params = loadScreeningParams();
  const curve = gradeEfficiencyCurve(hydrocyclone);
  const retention = membraneRetention(membrane);
  const poreUm = retention.effectiveRetentionUm;

  if (!Number.isFinite(curve.sharpness) || !(poreUm > 0)) {
    return {
      hydrocycloneId: hydrocyclone.id,
      membraneId: membrane.id,
      retainedMass: 0,
      foulingLoad: 0,
      foulingRemoved: 0,
      foulingReduction: 0,
      volumeRatio: 1,
      verdict: "insufficient-data",
      confidence: "low",
      reasoning: "No usable separation curve for this hydrocyclone, so no basis for a verdict. This is absence of evidence, not evidence of no benefit.",
    };
  }

  const retainedBins = binDistribution(psd).filter((b) => b.midUm >= poreUm);
  const retainedMass = retainedBins.reduce((sum, b) => sum + b.massFraction, 0);
  const foulingLoad = retainedBins.reduce((sum, b) => sum + b.massFraction / b.midUm ** 2, 0);
  const foulingRemoved = retainedBins.reduce(
    (sum, b) => sum + (b.massFraction * gradeEfficiency(curve, b.midUm)) / b.midUm ** 2,
    0,
  );
  const foulingReduction = foulingLoad > 0 ? clamp01(foulingRemoved / foulingLoad) : 0;
  const volumeRatio = foulingReduction < 1 ? 1 / Math.sqrt(1 - foulingReduction) : Infinity;

  const { marginalVolumeRatio, promisingVolumeRatio, strongVolumeRatio } = params.volumeTargets;
  const tooLittleToRemove = retainedMass < params.minimumRetainedMassFraction.value;

  let verdict: Verdict;
  if (tooLittleToRemove) {
    verdict = "marginal";
  } else if (volumeRatio >= strongVolumeRatio) {
    verdict = "strong";
  } else if (volumeRatio >= promisingVolumeRatio) {
    verdict = "promising";
  } else if (volumeRatio >= marginalVolumeRatio) {
    verdict = "marginal";
  } else {
    verdict = "unlikely";
  }

  const confidence = overallConfidence(
    psdLevel(psd.status),
    cutLevel(hydrocyclone.status.cut),
    membraneLevel(retention.source),
  );

  const reasoning = tooLittleToRemove
    ? `Only ${(retainedMass * 100).toFixed(1)}% of the feed is coarse enough for the ${membrane.label} membrane to retain in the first place - below the ${(params.minimumRetainedMassFraction.value * 100).toFixed(0)}% threshold below which there is almost nothing there to remove, whatever the cyclone's efficiency. Called marginal regardless of the ${volumeRatio.toFixed(2)}x figure the model otherwise gives.`
    : `Removing what the ${hydrocyclone.name} can catch cuts the fouling load by ${(foulingReduction * 100).toFixed(0)}%, which - because filtered volume scales as 1/sqrt(load) - this model translates to about ${volumeRatio.toFixed(2)}x the untreated filterable volume: ${verdict}. ${(retainedMass * 100).toFixed(0)}% of the feed is coarse enough for the ${membrane.label} membrane to retain, so there is real material for the cyclone to work on.`;

  return {
    hydrocycloneId: hydrocyclone.id,
    membraneId: membrane.id,
    retainedMass,
    foulingLoad,
    foulingRemoved,
    foulingReduction,
    volumeRatio,
    verdict,
    confidence,
    reasoning: `${reasoning} Confidence: ${confidence} - ${confidenceCaveat(psd, hydrocyclone, retention.source)}`,
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

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

/** Every hydrocyclone x membrane pair, for one site's distribution. */
export function assessMatrix(psd: Psd, hydrocyclones: Hydrocyclone[], membranes: Membrane[]): AssessmentCell[] {
  const cells: AssessmentCell[] = [];
  for (const h of hydrocyclones) {
    for (const m of membranes) {
      cells.push(assessPair(psd, h, m));
    }
  }
  return cells;
}
