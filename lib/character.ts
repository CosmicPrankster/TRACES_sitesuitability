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

export function inferCharacter(p: CatchmentProperties): CharacterInference | null {
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
          "water infiltrates rather than running off, so the suspended load tends to be coarser " +
          "and lighter than in an impermeable catchment.",
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
  const confidence: "low" | "medium" = agree ? "medium" : "low";

  reasoning.push(
    `Taken together, the catchment points to ${describeCharacter(character)}. This is inferred ` +
      "from catchment properties, not measured in the water: it says what the catchment is likely " +
      "to yield, not what is in suspension on any given day.",
  );

  wouldChangeThis.push(
    "A measured particle-size distribution on a raw water sample would replace this inference " +
      "entirely, and is the single most valuable measurement available.",
    "A settle-bottle test on a raw sample would confirm or contradict it in an afternoon: rapid " +
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
