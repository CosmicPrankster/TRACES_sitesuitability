import type { Hydrocyclone, Membrane } from "./data";
import type { Psd } from "./psd";
import { membraneRetention } from "./retention";
import type { AssessmentCell, Confidence, Verdict } from "./assessment";

/**
 * BLOCK 5e - the report.
 *
 * Groups the raw cells (block 5d) into best / marginal / unlikely /
 * insufficient-data, and finds the USEFUL WINDOW: the contiguous band of
 * membrane ratings where pretreatment looks worthwhile. That window is the
 * single most valuable output, more than any individual cell - it is the
 * answer to "where should I even look?", not just "is this pair good?".
 *
 * Sections, in the user's layout: verdict, configuration list, WHY, WHAT
 * WE KNOW, WHAT WE DON'T KNOW, RECOMMENDED TEST. The recommended test is
 * always the cheapest measurement that would most improve confidence -
 * right now, given no site trial exists, that is almost always: run one
 * filtration trial and compare volumes directly.
 */

const RANK: Record<Verdict, number> = {
  strong: 3,
  promising: 2,
  marginal: 1,
  unlikely: 0,
  "insufficient-data": -1,
};

/** "best" lumps strong + promising - the grouping is coarser than the raw verdict. */
export type Group = "best" | "marginal" | "unlikely" | "insufficientData";

function group(verdict: Verdict): Group {
  if (verdict === "strong" || verdict === "promising") return "best";
  if (verdict === "marginal") return "marginal";
  if (verdict === "unlikely") return "unlikely";
  return "insufficientData";
}

export function groupCells(cells: AssessmentCell[]): Record<Group, AssessmentCell[]> {
  const out: Record<Group, AssessmentCell[]> = { best: [], marginal: [], unlikely: [], insufficientData: [] };
  for (const c of cells) out[group(c.verdict)].push(c);
  return out;
}

export interface UsefulWindow {
  /** Ascending pore size. */
  membraneIds: string[];
  fromPoreSizeUm: number;
  toPoreSizeUm: number;
}

/**
 * The widest contiguous run of membrane ratings (by ascending pore size)
 * where the BEST available hydrocyclone reaches "promising" or "strong".
 * A membrane not tested by any hydrocyclone, or covered only by
 * insufficient-data cells, breaks the run - absence of evidence does not
 * extend a window it cannot support.
 */
export function findUsefulWindow(cells: AssessmentCell[], membranes: Membrane[]): UsefulWindow | null {
  const sorted = [...membranes].sort((a, b) => a.poreSizeUm - b.poreSizeUm);
  const bestRankByMembrane = new Map<string, number>();
  for (const c of cells) {
    const current = bestRankByMembrane.get(c.membraneId) ?? -Infinity;
    bestRankByMembrane.set(c.membraneId, Math.max(current, RANK[c.verdict]));
  }

  let bestRun: Membrane[] = [];
  let currentRun: Membrane[] = [];
  for (const m of sorted) {
    const rank = bestRankByMembrane.get(m.id) ?? -Infinity;
    if (rank >= RANK.promising) {
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

export interface ConfigurationRow {
  hydrocycloneId: string;
  membraneId: string;
  verdict: Verdict;
  volumeRatio: number;
  confidence: Confidence;
}

/** Every tested pair, best result first. */
function configurationList(cells: AssessmentCell[]): ConfigurationRow[] {
  return [...cells]
    .sort((a, b) => RANK[b.verdict] - RANK[a.verdict] || b.volumeRatio - a.volumeRatio)
    .map((c) => ({
      hydrocycloneId: c.hydrocycloneId,
      membraneId: c.membraneId,
      verdict: c.verdict,
      volumeRatio: c.volumeRatio,
      confidence: c.confidence,
    }));
}

export interface ScreeningReport {
  verdict: string;
  configurations: ConfigurationRow[];
  usefulWindow: UsefulWindow | null;
  why: string;
  whatWeKnow: string[];
  whatWeDontKnow: string[];
  recommendedTest: string;
}

export function buildReport(
  psd: Psd,
  cells: AssessmentCell[],
  hydrocyclones: Hydrocyclone[],
  membranes: Membrane[],
): ScreeningReport {
  const window = findUsefulWindow(cells, membranes);
  const configurations = configurationList(cells);
  const best = configurations[0];
  const membraneById = new Map(membranes.map((m) => [m.id, m]));
  const hydrocycloneById = new Map(hydrocyclones.map((h) => [h.id, h]));

  const verdict = window
    ? `Pretreatment looks worthwhile for membrane ratings from ${window.fromPoreSizeUm} to ${window.toPoreSizeUm} µm (of ${membranes.length} tested), at ${describeConfidenceSpread(cells)} confidence.`
    : `No membrane rating currently screens as promising or better for this feed. Best single result: ${labelOf(hydrocycloneById, best.hydrocycloneId)} + ${labelOf(membraneById, best.membraneId)}, ${best.verdict} (${best.volumeRatio.toFixed(2)}x).`;

  const why = window
    ? `Removing what a hydrocyclone can catch cuts the fouling load enough, in the ${window.fromPoreSizeUm}-${window.toPoreSizeUm} µm band, to plausibly extend the filterable volume past this project's "meaningful" threshold of about 1.5x. Outside that band, either too little of the feed is coarse enough to be worth removing, or what is coarse enough is too small a share of the fouling load to move the number.`
    : `Nowhere does removing the coarse fraction plausibly cut the fouling load far enough - remember volume scales as 1/sqrt(load), so even a 50% mass removal usually buys nowhere near a 50% volume gain. This is the expected outcome for a fine or clay-dominated feed, not a sign the model is broken.`;

  const whatWeKnow = buildWhatWeKnow(psd, hydrocyclones, membranes);
  const whatWeDontKnow = buildWhatWeDontKnow(psd, hydrocyclones, membranes);
  const recommendedTest = buildRecommendedTest(best, hydrocycloneById, membraneById);

  return { verdict, configurations, usefulWindow: window, why, whatWeKnow, whatWeDontKnow, recommendedTest };
}

function labelOf(map: Map<string, { name?: string; label?: string }>, id: string): string {
  const v = map.get(id);
  return v?.name ?? v?.label ?? id;
}

function describeConfidenceSpread(cells: AssessmentCell[]): Confidence {
  // The report's headline confidence is the best confidence anywhere in
  // the matrix, not the worst - a reader should not be told "low" overall
  // just because one untested corner is weak, if the useful window itself
  // rests on stronger inputs. Ties toward the safer (lower) reading.
  const order: Confidence[] = ["high", "medium", "low"];
  for (const level of order) {
    if (cells.some((c) => c.confidence === level)) return level;
  }
  return "low";
}

function buildWhatWeKnow(psd: Psd, hydrocyclones: Hydrocyclone[], membranes: Membrane[]): string[] {
  const lines = [`Particle size assumption used: ${psd.label} (d50 = ${psd.d50Um} µm).`];
  for (const h of hydrocyclones) {
    lines.push(
      `${h.name}: cut sizes d20/d50/d90 = ${h.cut.d20Um}/${h.cut.d50Um}/${h.cut.d90Um} µm (status: ${h.status.cut}).`,
    );
  }
  for (const m of membranes) {
    const r = membraneRetention(m);
    lines.push(`${m.label}: retention size used = ${r.effectiveRetentionUm} µm (${r.source}).`);
  }
  return lines;
}

function buildWhatWeDontKnow(psd: Psd, hydrocyclones: Hydrocyclone[], membranes: Membrane[]): string[] {
  const lines: string[] = [];
  if (psd.status !== "measured") {
    lines.push("The particle size distribution is a guess from solids character, not a site measurement.");
  }
  for (const h of hydrocyclones) {
    if (h.status.cut !== "measured") {
      lines.push(`${h.name}'s cut sizes are ${h.status.cut}, not measured from a real grade-efficiency test.`);
    }
  }
  for (const m of membranes) {
    if (membraneRetention(m).source !== "measured-product") {
      lines.push(`${m.label}'s retention size is the nominal pore size - no supplier product page on file.`);
    }
  }
  lines.push("Floc density effects on cohesive clay are not modelled (see screening-parameters.json).");
  lines.push("No filtration trial exists for this specific site - see data/trials.json.");
  return lines;
}

function buildRecommendedTest(
  best: ConfigurationRow,
  hydrocycloneById: Map<string, Hydrocyclone>,
  membraneById: Map<string, Membrane>,
): string {
  if (best.verdict === "unlikely" || best.verdict === "insufficient-data") {
    return "Nothing in this matrix screens as worthwhile yet, so the cheapest useful step is not a filtration trial - it is a measured particle size distribution of the raw water, to check whether the guessed solids character is actually right before ruling pretreatment out.";
  }
  const h = labelOf(hydrocycloneById, best.hydrocycloneId);
  const m = labelOf(membraneById, best.membraneId);
  return `Run one filtration trial: filter a known volume of raw water through the ${m} membrane, then the same volume of ${h} overflow, and compare. That measures the volume ratio directly instead of inferring it through three layers of assumption - record it in data/trials.json.`;
}
