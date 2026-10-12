/**
 * Inferring what the suspended solids are likely to be, from catchment
 * properties.
 *
 * This is the step that decides whether hydrocyclone pre-treatment can help,
 * so it is the most important inference in the application - and it is an
 * INFERENCE, not a measurement. It is labelled as one everywhere it appears.
 *
 * The inputs come from NRFA, which was chosen because it is the only catchment
 * source that covers the whole UK: the Environment Agency has no data for
 * Scotland at all.
 *
 * The reasoning, in order of weight:
 *
 * 1. BEDROCK PERMEABILITY is the strongest single signal. Permeable bedrock
 *    means sandstone, chalk or greensand, which weather to sand-grade quartz
 *    and let water infiltrate. Impermeable bedrock means mudstone, clay or
 *    crystalline rock, which weather to silt and clay and shed water at the
 *    surface.
 *
 * 2. BASE FLOW INDEX (BFIHOST) corroborates it and says how flashy the river
 *    is. A high BFI means groundwater-fed and stable: less suspended sediment
 *    overall, and less of it fine. A low BFI means storm-driven surface runoff,
 *    which carries fines.
 *
 * 3. ARABLE LAND is the strongest anthropogenic term. Cultivated ground is bare
 *    for part of the year and sheds fine silt and clay; a heavily arable
 *    catchment shifts the population finer regardless of its geology.
 *
 * 4. URBAN LAND shifts it finer too, and makes the response flashier.
 *
 * None of this replaces a measured particle-size distribution. It exists so
 * that a site with no measurements still gets an honest, evidence-based
 * starting point rather than a default.
 */

export type ParticleCharacter = "sand" | "mixed_mineral" | "silt" | "clay";

/** The NRFA fields this inference uses. All optional: real records have gaps. */
export interface CatchmentProperties {
  stationId?: number;
  stationName?: string;
  catchmentAreaKm2?: number | null;
  highPermBedrock?: number | null;
  moderatePermBedrock?: number | null;
  lowPermBedrock?: number | null;
  mixedPermBedrock?: number | null;
  highPermSuperficial?: number | null;
  lowPermSuperficial?: number | null;
  mixedPermSuperficial?: number | null;
  /** Base flow index, 0..1. Higher means more groundwater-fed. */
  bfihost?: number | null;
  /** Fraction of the catchment under crops, 0..1. */
  cropland?: number | null;
  /** Fraction built up, 0..1. */
  builtUp?: number | null;
  /** Standard average annual rainfall, mm. */
  saarMm?: number | null;
}

export interface CharacterInference {
  character: ParticleCharacter;
  /** How much to trust it. Never "high" - this is an inference, not a measurement. */
  confidence: "low" | "medium";
  /** Ordered reasoning, strongest first. Shown to the user verbatim. */
  reasoning: string[];
  /** What would change the answer. */
  wouldChangeThis: string[];
  /** The evidence actually used, for the audit trail. */
  evidence: { field: string; value: number; means: string }[];
}

/** NRFA maps a null permeability to "none of this class", not "unknown". */
const num = (v: number | null | undefined): number => (typeof v === "number" ? v : 0);

/** True when a record has enough in it to infer anything at all. */
export function hasEnoughToInfer(p: CatchmentProperties): boolean {
  const bedrockKnown =
    num(p.highPermBedrock) + num(p.moderatePermBedrock) +
    num(p.lowPermBedrock) + num(p.mixedPermBedrock) > 0;
  return bedrockKnown || typeof p.bfihost === "number";
}

/**
 * The character-category boundaries characterFromCoarseness uses. Exported
 * so the tier-descent decision below can check proximity to them without
 * duplicating the thresholds themselves.
 */
export const CATEGORY_THRESHOLDS = [-0.5, 0.1, 0.55] as const;
const BOUNDARY_MARGIN = 0.1;

export function isNearCategoryBoundary(coarseness: number): boolean {
  return CATEGORY_THRESHOLDS.some((t) => Math.abs(coarseness - t) < BOUNDARY_MARGIN);
}

/**
 * Tier-5-only coarseness: bedrock + base flow + land cover, no geology.
 * Mirrors steps 1-4 of inferCharacter's reasoning build exactly, as plain
 * arithmetic with no prose - this is ONLY used to decide, before BGS is
 * ever called, whether descending to tier 6 (mapped point geology) is worth
 * it. inferCharacter remains the single source of truth for the actual
 * inference and its reasoning; if these two drift apart, character.test.ts's
 * tier-descent tests will catch it against real NRFA fixtures.
 */
function catchmentOnlyCoarseness(p: CatchmentProperties): number {
  const high = num(p.highPermBedrock);
  const moderate = num(p.moderatePermBedrock);
  const low = num(p.lowPermBedrock);
  const mixed = num(p.mixedPermBedrock);
  const bedrockTotal = high + moderate + low + mixed;

  let coarseness = bedrockTotal > 0 ? (high + 0.4 * moderate - low) / bedrockTotal : 0;

  const bfi = p.bfihost;
  if (typeof bfi === "number") {
    if (bfi >= 0.7) coarseness += 0.25;
    else if (bfi <= 0.45) coarseness -= 0.25;
  }

  const crop = p.cropland;
  if (typeof crop === "number" && crop > 0) {
    if (crop >= 0.4) coarseness -= 0.35;
    else if (crop >= 0.2) coarseness -= 0.15;
  }

  const urban = p.builtUp;
  if (typeof urban === "number" && urban >= 0.15) coarseness -= 0.1;

  return coarseness;
}

/**
 * The tier-5 -> tier-6 descent decision (see HANDOFF.md / the rebuild plan's
 * "Descent rule"): stop at the first tier with usable data, and drop one
 * tier further only to corroborate a result worth double-checking - not
 * merely because the next tier exists. BGS's point geology (tier 6) is
 * worth fetching only when one of two things is true, both computable from
 * NRFA alone, before BGS is ever called:
 *
 *   - the catchment-only reading sits near a category boundary, where one
 *     more piece of evidence could change the answer; or
 *   - the catchment reads impermeable-bedrock-dominant, which carries a
 *     known failure mode regardless of how confidently it reads: NRFA
 *     classes crystalline (igneous/metamorphic) rock as low-permeability,
 *     but permeability describes water movement, not grain size - granite
 *     and psammite weather to coarse sand. A confidently "impermeable"
 *     catchment can still be this trap, so it is always worth a second
 *     opinion from the mapped geology (see the permeability-trap handling
 *     in inferCharacter below).
 *
 * A confidently permeable catchment (e.g. high-permeability-bedrock, high
 * base flow, nowhere near a threshold) has neither risk, and tier 6 is
 * skipped - no BGS call is made for it at all.
 */
export function worthCorroboratingWithGeology(p: CatchmentProperties): boolean {
  const high = num(p.highPermBedrock);
  const moderate = num(p.moderatePermBedrock);
  const low = num(p.lowPermBedrock);
  const mixed = num(p.mixedPermBedrock);
  const bedrockTotal = high + moderate + low + mixed;
  const lowPermDominant = bedrockTotal > 0 && low / bedrockTotal > 0.5;
  if (lowPermDominant) return true;

  return isNearCategoryBoundary(catchmentOnlyCoarseness(p));
}

/**
 * Optional corroboration from BGS geology at the point.
 * NRFA drives the inference because a river integrates its whole catchment;
 * BGS names the specific rock and either backs the reading up or contradicts
 * it. A contradiction is reported, not averaged away.
 */
export interface GeologyCorroboration {
  /** -1..+1 from lib/geology summariseGeology. */
  coarseness: number;
  /** e.g. "At this point BGS maps ... over ... bedrock (Sandstone)." */
  statement: string;
  /**
   * True when the bedrock is crystalline - igneous or metamorphic. NRFA classes
   * all such rock "low permeability", but permeability describes how water
   * moves through rock, NOT the grain size of what it weathers to. Granite and
   * psammite weather to coarse sand. Where this is set and the mapped
   * superficial deposits are coarse, the geology is trusted over the
   * permeability class.
   */
  bedrockIsCrystalline?: boolean;
  /** True when the superficial deposit is coarse and not the river's own alluvium. */
  coarseSuperficial?: boolean;
  /** Raw lithology strings, for callers that need more than the coarseness score - e.g. lib/flags.ts's peat check. Not used by inferCharacter itself. */
  bedrockLithology?: string | null;
  superficialLithology?: string | null;
}

export function inferCharacter(
  p: CatchmentProperties,
  geology?: GeologyCorroboration,
): CharacterInference | null {
  if (!hasEnoughToInfer(p)) return null;

  const reasoning: string[] = [];
  const wouldChangeThis: string[] = [];
  const evidence: { field: string; value: number; means: string }[] = [];

  const high = num(p.highPermBedrock);
  const moderate = num(p.moderatePermBedrock);
  const low = num(p.lowPermBedrock);
  const mixed = num(p.mixedPermBedrock);
  const bedrockTotal = high + moderate + low + mixed;

  /* --- 1. Bedrock permeability: a coarseness score from -1 to +1 ------ */
  // +1 wholly permeable (sandstone/chalk/greensand), -1 wholly impermeable.
  let coarseness = 0;
  if (bedrockTotal > 0) {
    coarseness = (high + 0.4 * moderate - low) / bedrockTotal;
    if (high / bedrockTotal > 0.5) {
      reasoning.push(
        `${Math.round((high / bedrockTotal) * 100)} % of the catchment sits on high-permeability ` +
          "bedrock — sandstone, chalk or greensand. These weather to sand-grade quartz, and " +
          "water infiltrates rather than running off, so the suspended load tends to be coarser, " +
          "and present at a lower overall concentration, than in an impermeable catchment " +
          "(\"lighter\" here means less loaded, not lower-density grains - quartz is not lighter " +
          "than clay minerals).",
      );
      evidence.push({ field: "high-perm-bedrock", value: high, means: "permeable, sand-yielding bedrock" });
    } else if (low / bedrockTotal > 0.5) {
      reasoning.push(
        `${Math.round((low / bedrockTotal) * 100)} % of the catchment sits on low-permeability ` +
          "bedrock — mudstone, clay or crystalline rock. These weather to silt- and clay-grade " +
          "material, and shed water at the surface, which mobilises fines.",
      );
      evidence.push({ field: "low-perm-bedrock", value: low, means: "impermeable, fines-yielding bedrock" });
    } else {
      reasoning.push(
        "The catchment bedrock is mixed in permeability, so it gives no strong steer either way " +
          "on the coarseness of the mineral load.",
      );
    }
  } else {
    wouldChangeThis.push("Bedrock permeability is not recorded for this catchment.");
  }

  /* --- 2. Base flow index -------------------------------------------- */
  const bfi = p.bfihost;
  if (typeof bfi === "number") {
    evidence.push({ field: "bfihost", value: bfi, means: "base flow index" });
    if (bfi >= 0.7) {
      coarseness += 0.25;
      reasoning.push(
        `A base flow index of ${bfi.toFixed(2)} is high: the river is largely groundwater-fed and ` +
          "its flow is stable. Stable rivers carry less suspended sediment, and less of what they " +
          "do carry is storm-mobilised fines.",
      );
    } else if (bfi <= 0.45) {
      coarseness -= 0.25;
      reasoning.push(
        `A base flow index of ${bfi.toFixed(2)} is low: the river responds quickly to rainfall. ` +
          "Storm runoff mobilises fine material from the catchment surface, so the suspended load " +
          "is likely to be finer and much more variable with flow.",
      );
    } else {
      reasoning.push(
        `A base flow index of ${bfi.toFixed(2)} is middling — partly groundwater-fed, partly ` +
          "responsive to rainfall.",
      );
    }
  }

  /* --- 3. Arable land ------------------------------------------------- */
  const crop = p.cropland;
  if (typeof crop === "number" && crop > 0) {
    evidence.push({ field: "cropland", value: crop, means: "fraction under crops" });
    if (crop >= 0.4) {
      coarseness -= 0.35;
      reasoning.push(
        `${Math.round(crop * 100)} % of the catchment is arable. Cultivated ground is bare for ` +
          "part of the year and sheds fine silt and clay into watercourses, which shifts the " +
          "suspended load finer than the geology alone would suggest.",
      );
    } else if (crop >= 0.2) {
      coarseness -= 0.15;
      reasoning.push(
        `${Math.round(crop * 100)} % of the catchment is arable, contributing some fine ` +
          "soil-derived material.",
      );
    }
  }

  /* --- 4. Urban land -------------------------------------------------- */
  const urban = p.builtUp;
  if (typeof urban === "number" && urban >= 0.15) {
    coarseness -= 0.1;
    evidence.push({ field: "built-up", value: urban, means: "fraction urban" });
    reasoning.push(
      `${Math.round(urban * 100)} % of the catchment is built up. Urban runoff is flashy and ` +
        "carries fine road- and roof-derived particulates.",
    );
  }

  /* --- 5. Geology corroboration --------------------------------------- */
  let geologyAgrees: boolean | null = null;
  if (geology) {
    const catchmentSaysCoarse = coarseness > 0.1;
    const geologySaysCoarse = geology.coarseness > 0.1;
    const bothClear = Math.abs(coarseness) > 0.1 && Math.abs(geology.coarseness) > 0.1;
    geologyAgrees = bothClear ? catchmentSaysCoarse === geologySaysCoarse : null;

    evidence.push({ field: "bgs-geology", value: geology.coarseness, means: "mapped geology at the point" });

    // The permeability trap. NRFA classes crystalline rock "low permeability",
    // which the bedrock rule above reads as "yields fines". For granite and
    // psammite that is simply wrong: they weather to coarse sand. Where the
    // mapped superficial deposits are also coarse, the geology is the better
    // evidence and it overrides.
    const permeabilityMisleading =
      geology.bedrockIsCrystalline === true &&
      geology.coarseSuperficial === true &&
      coarseness < 0 &&
      geology.coarseness > 0.3;

    if (permeabilityMisleading) {
      coarseness = 0.6 * geology.coarseness;
      geologyAgrees = null;
      reasoning.push(
        `${geology.statement} The catchment figures class this bedrock as low-permeability, and ` +
          "on its own that would read as a fine-grained catchment — but permeability describes " +
          "how water moves through rock, not the size of the grains it weathers to. Crystalline " +
          "rock is impermeable and still weathers to coarse sand, and the mapped superficial " +
          "deposits here are coarse. The mapped geology is therefore used in preference to the " +
          "permeability class.",
      );
      wouldChangeThis.push(
        "This site's reading rests on the mapped geology overriding the catchment permeability " +
          "class. A raw water sample would settle whether that was the right call.",
      );
    } else if (geologyAgrees === true) {
      // Agreement nudges, it does not dominate: one polygon is not a catchment.
      coarseness += 0.15 * Math.sign(geology.coarseness);
      reasoning.push(
        `${geology.statement} That agrees with the catchment properties, which is somewhat ` +
          "reassuring - though worth keeping in proportion: this is one mapped polygon at the " +
          "abstraction point agreeing with a catchment-wide reading, not two independently " +
          "collected datasets. It nudges the result; it does not confirm it the way a real " +
          "measurement would.",
      );
    } else if (geologyAgrees === false) {
      reasoning.push(
        `${geology.statement} That does NOT agree with the catchment properties. The mapped ` +
          "geology describes one polygon at the abstraction point, while the catchment figures " +
          "describe everything upstream — so a disagreement usually means the site sits on " +
          "something locally unrepresentative. The catchment-wide reading is used, and the " +
          "disagreement is the reason confidence stays low.",
      );
      wouldChangeThis.push(
        "Resolving the disagreement between the mapped geology at the point and the catchment-wide " +
          "properties. A raw water sample would settle it directly.",
      );
    } else {
      reasoning.push(`${geology.statement}`);
    }
  }

  /* --- Decide --------------------------------------------------------- */
  let character: ParticleCharacter;
  if (coarseness >= 0.55) character = "sand";
  else if (coarseness >= 0.1) character = "mixed_mineral";
  else if (coarseness >= -0.5) character = "silt";
  else character = "clay";

  // Confidence: medium only when bedrock AND base flow both point the same way.
  const bedrockDecisive = bedrockTotal > 0 && (high / bedrockTotal > 0.6 || low / bedrockTotal > 0.6);
  const bfiDecisive = typeof bfi === "number" && (bfi >= 0.7 || bfi <= 0.45);
  const agree =
    bedrockDecisive && bfiDecisive &&
    ((high / bedrockTotal > 0.6 && bfi! >= 0.7) || (low / bedrockTotal > 0.6 && bfi! <= 0.45));
  // Geology disagreeing with the catchment always drops confidence back to low.
  const confidence: "low" | "medium" =
    agree && geologyAgrees !== false ? "medium" : "low";

  reasoning.push(
    `Taken together, the catchment points to ${describeCharacter(character)}. This is inferred ` +
      "from catchment properties, not measured in the water: it says what the catchment is likely " +
      "to yield, not what is in suspension on any given day.",
  );

  wouldChangeThis.push(
    "A measured particle-size distribution on a raw water sample would replace this inference " +
      "entirely, and is the single most valuable measurement available.",
    "A settle test on a raw sample would confirm or contradict it in an afternoon: rapid " +
      "settling of gritty material indicates a coarse fraction a hydrocyclone can act on, while a " +
      "haze that persists for hours indicates fines it cannot.",
  );
  if (typeof bfi === "number" && bfi >= 0.7) {
    wouldChangeThis.push(
      "Sampling during a storm rather than at baseflow, since a groundwater-fed river's " +
        "suspended load changes character sharply on the rising limb.",
    );
  }

  return { character, confidence, reasoning, wouldChangeThis, evidence };
}

/** size -> character thresholds, shared with inferCharacter so the two paths agree. */
function characterFromCoarseness(coarseness: number): ParticleCharacter {
  if (coarseness >= 0.55) return "sand";
  if (coarseness >= 0.1) return "mixed_mineral";
  if (coarseness >= -0.5) return "silt";
  return "clay";
}

/**
 * The fallback for a site with no NRFA gauge nearby - normal for a small or
 * urban watercourse, per resolve.ts's decideResolution. There is no
 * catchment-wide data to weigh here, only the mapped geology at one point,
 * so this is deliberately a separate, simpler function rather than a mode
 * of inferCharacter: it must never claim the confidence a catchment-wide
 * reading earns, and the reasoning must say plainly that this is a single
 * point, not the catchment.
 */
export function inferCharacterFromGeologyOnly(geology: GeologyCorroboration): CharacterInference {
  const character = characterFromCoarseness(geology.coarseness);
  return {
    character,
    // Never anything but low: there is no catchment corroboration possible
    // when there is no catchment data in the first place.
    confidence: "low",
    reasoning: [
      "No NRFA gauging station is near enough to give catchment-wide properties for this site - " +
        "normal for a small or urban watercourse.",
      geology.statement,
      `Read alone, that is ${describeCharacter(character)}. This comes from the geology mapped at ` +
        "this one point, not from a catchment-wide reading, so it carries none of the corroboration " +
        "a gauged site gets from bedrock permeability and base flow agreeing (or disagreeing). " +
        "Treat it as a starting point, not a confident read.",
    ],
    wouldChangeThis: [
      "A measured particle-size distribution on a raw water sample would replace this inference " +
        "entirely, and matters more here than at a gauged site, precisely because there is no " +
        "catchment data to fall back on.",
      "A settle test on a raw sample would confirm or contradict it in an afternoon: rapid " +
        "settling of gritty material indicates a coarse fraction a hydrocyclone can act on, while a " +
        "haze that persists for hours indicates fines it cannot.",
      "The geology reading is for one point; upstream catchment character can differ from what is " +
        "mapped at the site itself, more so for a small catchment than a large one.",
    ],
    evidence: [{ field: "bgs-geology", value: geology.coarseness, means: "mapped geology at the point (no catchment data available)" }],
  };
}

export function describeCharacter(c: ParticleCharacter): string {
  switch (c) {
    case "sand":
      return "a predominantly sand-grade mineral load of dense, discrete particles";
    case "mixed_mineral":
      return "a mixed mineral load spanning silt into fine sand";
    case "silt":
      return "a predominantly silt-grade load";
    case "clay":
      return "a predominantly clay-grade, cohesive load";
  }
}

/** Maps a raw NRFA record onto the fields this module uses. */
export function fromNrfaRecord(rec: Record<string, unknown>): CatchmentProperties {
  const n = (k: string): number | null => {
    const v = rec[k];
    return typeof v === "number" ? v : null;
  };
  return {
    stationId: typeof rec.id === "number" ? rec.id : undefined,
    stationName: typeof rec.name === "string" ? rec.name : undefined,
    catchmentAreaKm2: n("catchment-area"),
    highPermBedrock: n("high-perm-bedrock"),
    moderatePermBedrock: n("moderate-perm-bedrock"),
    lowPermBedrock: n("low-perm-bedrock"),
    mixedPermBedrock: n("mixed-perm-bedrock"),
    highPermSuperficial: n("high-perm-superficial"),
    lowPermSuperficial: n("low-perm-superficial"),
    mixedPermSuperficial: n("mixed-perm-superficial"),
    bfihost: n("bfihost19") ?? n("bfihost"),
    cropland: n("lcm2023-cropland") ?? n("lcm2000-arable-horticultural"),
    builtUp: n("lcm2023-built-up-areas") ?? n("lcm2000-urban"),
    saarMm: n("saar-1991-2020") ?? n("saar-1961-1990"),
  };
}
