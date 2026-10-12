import { isPeat } from "./geology";

/**
 * BLOCK 6, rebuild phase 4 - organics/algae/inhibition flags.
 *
 * Per the rebuild plan: season + nutrients/arable -> algae risk; peat ->
 * organic/inhibition risk. These are INDEPENDENT of the mineral-character
 * score (lib/character.ts, lib/assessment.ts) and must never blend into
 * it - a confident "likely" mineral-fouling verdict can sit right next to
 * an "elevated" algae flag without the flag dragging the category down.
 * They fail by a different mechanism (algae: biological growth and gel-
 * layer formation; organics: adsorption/DOC fouling) that a hydrocyclone,
 * which separates on density, does little for either way - that is worth
 * knowing regardless of what the mineral-fouling number says.
 *
 * Rule-based, same discipline as everything else in this tool: no LLM in
 * the scoring path, every input that drives a flag is named, and
 * "insufficient data" is a real, distinct outcome from "checked and low" -
 * never collapsed into a guessed default.
 */

export type FlagRisk = "elevated" | "low" | "insufficient-data";

export interface AlgaeFlag {
  risk: FlagRisk;
  /** Whether the assessment is being made during the UK's typical bloom season (April-September). */
  inSeason: boolean;
  reasoning: string;
}

export interface InhibitionFlag {
  risk: FlagRisk;
  reasoning: string;
}

export interface SiteFlags {
  algae: AlgaeFlag;
  inhibition: InhibitionFlag;
}

/** 1-indexed months, matching Date#getMonth()+1 - April through September. */
const BLOOM_SEASON_MONTHS = new Set([4, 5, 6, 7, 8, 9]);

function isBloomSeason(date: Date): boolean {
  return BLOOM_SEASON_MONTHS.has(date.getMonth() + 1);
}

/** Matches the "heavy arable" framing character.ts already uses for the same field. */
const CROPLAND_NUTRIENT_THRESHOLD = 0.3;
const BUILT_UP_NUTRIENT_THRESHOLD = 0.25;

export interface NutrientLandCover {
  /** Fraction of the catchment under crops, 0..1 - the best available nutrient-runoff proxy. */
  cropland?: number | null;
  /** Fraction built up, 0..1 - urban runoff carries nutrients too, at a lower threshold. */
  builtUp?: number | null;
}

/**
 * Nutrient enrichment (the precondition for an algae bloom) is a fixed
 * catchment property, assessed once; whether it is actually bloom season
 * right now is a separate, date-dependent fact. Both are returned, rather
 * than collapsed into one flag, because a reader checking this report in
 * winter should see "this catchment carries the risk" without being told
 * it's active today when it isn't.
 */
export function assessAlgaeRisk(catchment: NutrientLandCover | null, now: Date = new Date()): AlgaeFlag {
  const inSeason = isBloomSeason(now);

  if (!catchment || (catchment.cropland == null && catchment.builtUp == null)) {
    return {
      risk: "insufficient-data",
      inSeason,
      reasoning:
        "No catchment land-cover data available for this site (no NRFA gauge nearby), so there is " +
        "nothing to base a nutrient-enrichment estimate on - insufficient data, not a guessed low-risk reading.",
    };
  }

  const cropland = catchment.cropland ?? 0;
  const builtUp = catchment.builtUp ?? 0;
  const enriched = cropland >= CROPLAND_NUTRIENT_THRESHOLD || builtUp >= BUILT_UP_NUTRIENT_THRESHOLD;

  if (!enriched) {
    return {
      risk: "low",
      inSeason,
      reasoning:
        `Neither the arable fraction (${Math.round(cropland * 100)}%) nor the built-up fraction ` +
        `(${Math.round(builtUp * 100)}%) suggests meaningful nutrient enrichment - no particular reason ` +
        "to expect algae-driven fouling beyond the general background risk any open water carries.",
    };
  }

  const drivers = [
    cropland >= CROPLAND_NUTRIENT_THRESHOLD ? `${Math.round(cropland * 100)}% arable` : null,
    builtUp >= BUILT_UP_NUTRIENT_THRESHOLD ? `${Math.round(builtUp * 100)}% built up` : null,
  ].filter((v): v is string => v !== null);

  return {
    risk: "elevated",
    inSeason,
    reasoning:
      `${drivers.join(" and ")} - enough nutrient input (phosphate/nitrate runoff) that algae can bloom ` +
      "given warmth and light. " +
      (inSeason
        ? "This assessment falls inside the UK's typical bloom season (April-September), so this risk is live now, not just theoretical."
        : "This assessment falls outside the UK's typical bloom season (April-September) - the catchment carries the risk, but it is unlikely to be active right now.") +
      " Independent of the mineral-fouling verdict above: a membrane can be a confident \"likely\" for " +
      "sand/silt fouling and still need an algae-specific pretreatment step, which a hydrocyclone - " +
      "separating on density, not biology - does little for.",
  };
}

export interface MappedLithology {
  bedrock: string | null;
  superficial: string | null;
}

/**
 * Peat at a mapped point, as a proxy for organic/dissolved-organic-carbon
 * (DOC) fouling risk - the plan's own "peat + DOC -> inhibition risk" pairs
 * the two together, but no DOC measurement is wired into this tool, so
 * this reads peat alone and says so plainly rather than implying a DOC
 * reading that doesn't exist.
 *
 * This is deliberately NOT given its own BGS fetch - it reads whatever
 * lithology the character-inference tier-descent (character.ts's
 * worthCorroboratingWithGeology) already decided was worth fetching for
 * THAT purpose. Impermeable-bedrock-dominant catchments - which is what
 * peat catchments typically read as - already trigger that fetch (the
 * permeability-trap risk, lib/character.ts), so the two needs are mostly
 * already aligned; a confidently permeable catchment, where that fetch is
 * skipped, is also the case least likely to be peat. Reporting
 * "insufficient data" honestly when geology wasn't fetched is preferred
 * over adding a second BGS call purely for this flag.
 */
export function assessInhibitionRisk(lithologies: MappedLithology): InhibitionFlag {
  if (!lithologies.bedrock && !lithologies.superficial) {
    return {
      risk: "insufficient-data",
      reasoning:
        "No mapped geology checked at this point (either BGS had nothing there, or the catchment " +
        "reading was clear enough that the point check was skipped - see the hierarchy-descent note), " +
        "so there is nothing to check for peat - insufficient data, not a guessed low-risk reading.",
    };
  }

  const peatAtSurface = isPeat(lithologies.superficial);
  const peatInBedrock = isPeat(lithologies.bedrock);

  if (!peatAtSurface && !peatInBedrock) {
    return {
      risk: "low",
      reasoning:
        "No peat in the mapped geology checked at this point - no particular reason to expect organic-" +
        "matter inhibition beyond the general background any natural water carries. This is a single-" +
        "point geology reading, not a dissolved-organic-carbon measurement.",
    };
  }

  const where = peatAtSurface && peatInBedrock ? "at the surface and in the bedrock record" : peatAtSurface ? "at the surface" : "in the bedrock record";
  return {
    risk: "elevated",
    reasoning:
      `The mapped geology at this point includes peat ${where}. Peat catchments shed dissolved organic ` +
      "carbon and low-density organic particulates that foul membranes by adsorption and gel-layer " +
      "formation, not the cake filtration this tool otherwise models - a hydrocyclone, which separates " +
      "on density, does little for this. This is read from the mapped geology at one point, not a " +
      "dissolved-organic-carbon measurement - no DOC source is wired into this tool yet.",
  };
}

export function assessSiteFlags(
  catchment: NutrientLandCover | null,
  lithologies: MappedLithology,
  now: Date = new Date(),
): SiteFlags {
  return {
    algae: assessAlgaeRisk(catchment, now),
    inhibition: assessInhibitionRisk(lithologies),
  };
}
