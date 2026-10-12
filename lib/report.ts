import type { Membrane } from "./data";
import type { Psd } from "./psd";
import type { MembraneAssessment } from "./assessment";

/**
 * BLOCK 5e, REBUILT (rebuild phase 1) - the report.
 *
 * Built around the new per-membrane shape from lib/assessment.ts: a
 * baseline volume (or honestly "insufficient data"), every pretreatment
 * method's uplift, and a recommendation. The USEFUL WINDOW concept from
 * the original report survives, redefined against the new output: the
 * contiguous band of membrane ratings where the recommendation is actually
 * to use a pretreatment method (not filter alone, not sample sediment).
 */

export interface UsefulWindow {
  membraneIds: string[];
  fromPoreSizeUm: number;
  toPoreSizeUm: number;
}

/**
 * The widest contiguous run of membrane ratings (ascending pore size)
 * where the recommendation is a pretreatment method. A membrane
 * recommending filter-alone, more-replicates or sample-sediment breaks the
 * run - those are not "pretreatment looks worthwhile" outcomes.
 */
export function findUsefulWindow(assessments: MembraneAssessment[], membranes: Membrane[]): UsefulWindow | null {
  const sorted = [...membranes].sort((a, b) => a.poreSizeUm - b.poreSizeUm);
  const byMembraneId = new Map(assessments.map((a) => [a.membraneId, a]));

  let bestRun: Membrane[] = [];
  let currentRun: Membrane[] = [];
  for (const m of sorted) {
    const recommendsPretreatment = byMembraneId.get(m.id)?.recommendation.kind === "pretreatment";
    if (recommendsPretreatment) {
      currentRun.push(m);
      if (currentRun.length > bestRun.length) bestRun = currentRun;
    } else {
      currentRun = [];
    }
  }

  if (bestRun.length === 0) return null;
  return {
    membraneIds: bestRun.map((m) => m.id),
    fromPoreSizeUm: bestRun[0].poreSizeUm,
    toPoreSizeUm: bestRun[bestRun.length - 1].poreSizeUm,
  };
}

export interface ScreeningReport {
  verdict: string;
  usefulWindow: UsefulWindow | null;
  why: string;
  whatWeKnow: string[];
  whatWeDontKnow: string[];
  recommendedTest: string;
  assessments: MembraneAssessment[];
}

export function buildReport(psd: Psd, assessments: MembraneAssessment[], membranes: Membrane[]): ScreeningReport {
  const window = findUsefulWindow(assessments, membranes);
  const membraneById = new Map(membranes.map((m) => [m.id, m]));
  const pretreatmentCount = assessments.filter((a) => a.recommendation.kind === "pretreatment").length;

  const verdict = window
    ? `Pretreatment looks worthwhile for membrane ratings from ${window.fromPoreSizeUm} to ${window.toPoreSizeUm} µm (of ${membranes.length} tested).`
    : pretreatmentCount > 0
      ? `Pretreatment looks worthwhile for some membrane ratings, but not a contiguous band - see each membrane's own recommendation.`
      : `No membrane rating currently recommends a pretreatment method for this feed.`;

  const why = window
    ? `Removing what a pretreatment method can catch cuts the fouling load enough, in the ${window.fromPoreSizeUm}-${window.toPoreSizeUm} µm band, to plausibly reach this project's "likely" threshold. Outside that band, either too little of the feed is coarse enough to be worth removing, or what is coarse enough is too small a share of the fouling load to move the number.`
    : `Nowhere does removing the coarse fraction plausibly cut the fouling load far enough - remember volume scales as 1/sqrt(load), so even a 50% mass removal usually buys nowhere near a 50% volume gain. This is the expected outcome for a fine or clay-dominated feed, not a sign the model is broken.`;

  const whatWeKnow = buildWhatWeKnow(psd, assessments, membraneById);
  const whatWeDontKnow = buildWhatWeDontKnow(psd, assessments);
  const recommendedTest = buildRecommendedTest(assessments, membraneById);

  return { verdict, usefulWindow: window, why, whatWeKnow, whatWeDontKnow, recommendedTest, assessments };
}

function buildWhatWeKnow(psd: Psd, assessments: MembraneAssessment[], membraneById: Map<string, Membrane>): string[] {
  const lines = [`Particle size assumption used: ${psd.label} (d50 = ${psd.d50Um} µm).`];
  for (const a of assessments) {
    const m = membraneById.get(a.membraneId);
    const label = m?.label ?? a.membraneId;
    if (a.baselineVolume) {
      const prefix = a.baselineSource === "estimated" ? "ESTIMATED " : "";
      lines.push(
        `${label}: ${prefix}baseline filterable volume ${a.baselineVolume.lowMl.toFixed(0)}-${a.baselineVolume.highMl.toFixed(0)} mL (mid ${a.baselineVolume.midMl.toFixed(0)} mL), confidence ${a.baselineConfidence}.`,
      );
    }
  }
  return lines;
}

function buildWhatWeDontKnow(psd: Psd, assessments: MembraneAssessment[]): string[] {
  const lines: string[] = [];
  if (psd.status === "guessed") {
    lines.push("The particle size distribution is a guess from solids character, not a site measurement.");
  } else if (psd.status === "field-adjusted") {
    lines.push("The particle size distribution is a field read (grain card/settle test, see lib/field-update.ts) with an assumed spread, not a full lab measurement.");
  }
  const anyMeasuredBaseline = assessments.some((a) => a.baselineSource === "measured");
  const anyEstimatedBaseline = assessments.some((a) => a.baselineSource === "estimated");

  if (!anyMeasuredBaseline && !anyEstimatedBaseline) {
    lines.push("No membrane pore size tested has a real bench-trial calibration for an absolute baseline volume, and no real trial exists at any pore size to estimate one from either.");
  } else {
    if (!anyMeasuredBaseline) {
      lines.push("No membrane pore size tested has a real bench-trial calibration for an absolute baseline volume - every baseline volume shown is a literature-based ESTIMATE (data/sediment-properties.json), not a measurement. Treat it as order-of-magnitude.");
    } else if (anyEstimatedBaseline) {
      lines.push("Some membrane pore sizes have no real bench-trial calibration - their baseline volumes are literature-based ESTIMATES (data/sediment-properties.json), always low confidence, not measurements.");
    }
    // Real text authored in assessment.ts's assessMembrane - a direct
    // check rather than plumbing a separate boolean through just for this
    // one line, since every baseline-having assessment already says this
    // in its own reasoning verbatim.
    const anyRealConcentration = assessments.some((a) => a.baselineReasoning.includes("real measured solids concentration"));
    if (!anyRealConcentration) {
      lines.push("Every baseline volume assumes a reference solids concentration, not a measured one - no real EA Water Quality Archive reading was found near this site.");
    }
  }
  lines.push("Floc density effects on cohesive clay are not modelled (see screening-parameters.json).");
  lines.push("No filtration trial exists for this specific site - see data/trials.json.");
  return lines;
}

function buildRecommendedTest(assessments: MembraneAssessment[], membraneById: Map<string, Membrane>): string {
  const pretreatmentWins = assessments.filter((a) => a.recommendation.kind === "pretreatment");
  if (pretreatmentWins.length === 0) {
    return "Nothing in this assessment recommends a pretreatment method yet, so the cheapest useful step is not a filtration trial - it is a measured particle size distribution of the raw water, to check whether the guessed solids character is actually right before ruling pretreatment out.";
  }
  const a = pretreatmentWins[0];
  const rec = a.recommendation as Extract<typeof a.recommendation, { kind: "pretreatment" }>;
  const m = membraneById.get(a.membraneId);
  return `Run one filtration trial: filter a known volume of raw water through the ${m?.label ?? a.membraneId} membrane, then the same volume of ${rec.methodLabel} overflow, and compare. That measures the uplift directly instead of inferring it through three layers of assumption - record it in data/trials.json.`;
}
