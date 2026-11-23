import type { Membrane } from "./data";
import type { Psd } from "./psd";
import type { MembraneAssessment } from "./assessment";

/**
 * BLOCK 5e, REBUILT AGAIN (2026-11-23) - the report, filter-throughput only.
 *
 * Per the user's explicit instruction, this project is no longer scoring or
 * reporting hydrocyclone uplift at all - only how much volume a membrane
 * filter alone can pass before it blinds. `lib/assessment.ts` still computes
 * `uplifts`/`recommendation` internally (real, tested physics, kept rather
 * than torn out - see HANDOFF.md), but nothing in this report, and nothing
 * on the page, reads or surfaces either one any more.
 *
 * The old `findUsefulWindow`/`usefulWindow` concept ("the band where
 * pretreatment is worthwhile") is gone, not repurposed: there is no
 * threshold anywhere in this project's real data for how many mL of
 * filter-alone volume counts as "enough" - inventing one to keep a verdict
 * banner alive would be exactly the kind of false precision this project's
 * own rules forbid. The verdict is now a plain factual summary of what was
 * found, and the recommended test is whatever would most directly replace
 * an estimate with a real measurement.
 */

export interface ScreeningReport {
  verdict: string;
  why: string;
  whatWeKnow: string[];
  whatWeDontKnow: string[];
  recommendedTest: string;
  assessments: MembraneAssessment[];
}

export function buildReport(psd: Psd, assessments: MembraneAssessment[], membranes: Membrane[]): ScreeningReport {
  const membraneById = new Map(membranes.map((m) => [m.id, m]));
  const verdict = buildVerdict(assessments);
  const why = buildWhy(assessments);
  const whatWeKnow = buildWhatWeKnow(psd, assessments, membraneById);
  const whatWeDontKnow = buildWhatWeDontKnow(psd, assessments);
  const recommendedTest = buildRecommendedTest(assessments, membraneById);

  return { verdict, why, whatWeKnow, whatWeDontKnow, recommendedTest, assessments };
}

function buildVerdict(assessments: MembraneAssessment[]): string {
  const withVolume = assessments.filter((a) => a.baselineVolume);
  if (withVolume.length === 0) {
    return "No real bench-trial calibration or literature-based estimate exists for any membrane rating tested - there is no baseline filterable volume to report yet.";
  }
  const lowMl = Math.min(...withVolume.map((a) => a.baselineVolume!.lowMl));
  const highMl = Math.max(...withVolume.map((a) => a.baselineVolume!.highMl));
  const measuredCount = withVolume.filter((a) => a.baselineSource === "measured").length;
  const estimatedCount = withVolume.filter((a) => a.baselineSource === "estimated").length;
  const coverage =
    estimatedCount === 0
      ? `all ${measuredCount} backed by a real bench-trial calibration`
      : measuredCount === 0
        ? `all ${estimatedCount} a literature-based estimate, not a measurement`
        : `${measuredCount} with a real bench-trial calibration, ${estimatedCount} a literature-based estimate`;
  return `Baseline filterable volume ranges from ${lowMl.toFixed(0)} to ${highMl.toFixed(0)} mL across the ${withVolume.length} of ${assessments.length} membrane ratings with a figure at all (${coverage}).`;
}

function buildWhy(assessments: MembraneAssessment[]): string {
  const withVolume = assessments
    .filter((a) => a.baselineVolume)
    .sort((a, b) => a.baselineVolume!.midMl - b.baselineVolume!.midMl);
  if (withVolume.length < 2) {
    return "This model's physics (Carman-Kozeny cake filtration) treats a membrane's retained mass as a fouling load weighted by 1/d², not the mass itself - and filtered volume scales as 1/sqrt(load). A tighter membrane retains more of the feed, which this relationship turns into a much steeper drop in volume than the extra retained mass alone would suggest.";
  }
  return `The same physics explains the spread across pore sizes: a tighter membrane rating retains more of the feed, and because this model's physics (Carman-Kozeny) weights retained mass by 1/d² to get the fouling load, a small increase in retained mass becomes a much larger increase in fouling load - and because filtered volume scales as 1/sqrt(load), that turns into the gap seen here between the tightest and widest ratings tested.`;
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
  const uncalibrated = assessments.find((a) => a.baselineSource !== "measured");
  if (uncalibrated) {
    const m = membraneById.get(uncalibrated.membraneId);
    const label = m?.label ?? uncalibrated.membraneId;
    const gap =
      uncalibrated.baselineSource === "estimated"
        ? "a literature-based estimate stands in for it"
        : "there is no figure for it at all";
    return `Run one filtration trial: filter a known volume of raw water through the ${label} membrane alone and record the volume passed before it blinds. There is no real bench-trial calibration at this pore size yet - ${gap} - so record the result in data/trials.json.`;
  }
  const anyRealConcentration = assessments.some((a) => a.baselineReasoning.includes("real measured solids concentration"));
  if (!anyRealConcentration) {
    return "Every membrane rating tested already has a real bench-trial calibration. The next useful step is a measured suspended-solids concentration near this site (from the EA Water Quality Archive, or a direct sample) - every baseline volume here still assumes the calibration trials' own reference concentration, not a real one for this site.";
  }
  return "Every membrane rating tested already has a real, site-concentration-calibrated baseline - there is nothing cheap left to measure that would materially sharpen these numbers further.";
}
