import type {
  ConfigurationAssessment,
  ConfigurationMetrics,
  Confidence,
  DecisionTreeStep,
  GradeEfficiencyPoint,
  HydraulicCheck,
  Hydrocyclone,
  MembraneOption,
  ParticleCharacter,
  PSD,
  PSDStatistics,
  Provenance,
  ReportNarrative,
  Scenario,
  ScreeningClass,
  ScreeningReport,
  SiteData,
  UsefulWindow,
} from "@/types";
import { CONFIDENCE_STRENGTH, PROVENANCE_STRENGTH } from "@/types";
import { hydrocyclones as hydrocycloneCatalogue } from "@/data/hydrocyclones";
import { membraneOptions as membraneCatalogue, MEMBRANE_RETENTION_NOTE } from "@/data/membranes";
import {
  analysePSD,
  clamp,
  fractionAbovePercent,
  fractionBelowPercent,
  massFractionBetween,
  round,
} from "./psd";
import {
  ASSUMED_PARTICLE_DENSITY_KG_M3,
  collectSources,
  describeParticleCharacter,
  resolvePSD,
} from "./site";

/**
 * The deterministic screening engine.
 *
 * There is deliberately no equipment-specific branching anywhere in this file.
 * Every hydrocyclone is treated identically: the engine asks the catalogue what
 * it knows, and reasons from that. Adding a new unit to `data/hydrocyclones.ts`
 * therefore extends the matrix with no change here.
 *
 * The central engineering distinction the engine exists to enforce:
 *
 *   "the membrane RETAINS particles coarser than its rating"
 *                          is not the same as
 *   "the hydrocyclone can REMOVE those particles upstream".
 *
 * A membrane pore size is a retention rating. A hydrocyclone cut size is the
 * size at which half the mass reports to the underflow, with a gradual curve
 * either side of it. The two are separate quantities and the engine never
 * substitutes one for the other.
 */

/* -------------------------------------------------------------------------- */
/* Catalogue access                                                            */
/* -------------------------------------------------------------------------- */

export function getHydrocyclones(ids?: string[]): Hydrocyclone[] {
  const all = hydrocycloneCatalogue;
  if (!ids || ids.length === 0) return all;
  return all.filter((h) => ids.includes(h.id));
}

export function getHydrocyclone(id: string): Hydrocyclone | undefined {
  return hydrocycloneCatalogue.find((h) => h.id === id);
}

export function getMembraneOptions(ids?: string[]): MembraneOption[] {
  const enabled = membraneCatalogue.filter((m) => m.enabled);
  const chosen = !ids || ids.length === 0 ? enabled : enabled.filter((m) => ids.includes(m.id));
  return [...chosen].sort((a, b) => a.poreSizeUm - b.poreSizeUm);
}

/* -------------------------------------------------------------------------- */
/* Grade efficiency                                                            */
/* -------------------------------------------------------------------------- */

export interface GradeEfficiencyModel {
  /** Mass fraction (0..1) of particles of size `dUm` reporting to the underflow. */
  efficiencyAt(dUm: number): number;
  cutSizeUm?: number;
  provenance: Provenance;
  confidence: Confidence;
  verified: boolean;
  /** Human-readable description of what the model is based on. */
  description: string;
  available: boolean;
  sharpness?: number;
  waterSplitRf: number;
}

function interpolateCurve(points: GradeEfficiencyPoint[], dUm: number): number {
  const pts = [...points].sort((a, b) => a.sizeUm - b.sizeUm);
  if (pts.length === 0) return 0;
  if (dUm <= pts[0].sizeUm) return clamp(pts[0].efficiency, 0, 1);
  const last = pts[pts.length - 1];
  if (dUm >= last.sizeUm) return clamp(last.efficiency, 0, 1);
  for (let i = 1; i < pts.length; i += 1) {
    const lo = pts[i - 1];
    const hi = pts[i];
    if (dUm <= hi.sizeUm) {
      const t = (Math.log(dUm) - Math.log(lo.sizeUm)) / (Math.log(hi.sizeUm) - Math.log(lo.sizeUm));
      return clamp(lo.efficiency + t * (hi.efficiency - lo.efficiency), 0, 1);
    }
  }
  return clamp(last.efficiency, 0, 1);
}

/**
 * Builds the separation model for a hydrocyclone from whatever the catalogue
 * holds, in descending order of trustworthiness:
 *
 *  1. a measured or published grade-efficiency curve;
 *  2. a cut size plus a sharpness exponent, fitted to the reduced
 *     grade-efficiency form G'(d) = (d/d50)^m / (1 + (d/d50)^m), corrected for
 *     short-circuit with G(d) = Rf + (1 - Rf) G'(d);
 *  3. nothing - in which case the model reports itself unavailable and the
 *     configuration is classified `insufficient_data` rather than guessed at.
 */
export function buildGradeEfficiencyModel(cyclone: Hydrocyclone): GradeEfficiencyModel {
  const cs = cyclone.cutSize;
  const rfEvidence = cs?.waterSplitRf;
  const waterSplitRf = clamp(rfEvidence?.value ?? 0, 0, 0.95);

  const curve = cs?.gradeEfficiencyCurve;
  if (curve && curve.value.length >= 2) {
    return {
      efficiencyAt: (d) => interpolateCurve(curve.value, d),
      cutSizeUm: cs?.d50Um?.value,
      provenance: curve.provenance,
      confidence: curve.confidence,
      verified: curve.verified,
      available: true,
      waterSplitRf,
      description:
        `A ${curve.provenance} grade-efficiency curve with ${curve.value.length} points` +
        (curve.source ? ` (${curve.source})` : "") +
        ". Efficiencies are interpolated between points and clamped outside the measured range.",
    };
  }

  const d50 = cs?.d50Um;
  if (d50 && d50.value > 0) {
    const m = cs?.sharpness?.value ?? 2.5;
    const sharpnessProv = cs?.sharpness?.provenance ?? "assumed";
    // The model is only as strong as its weakest input.
    const provenance: Provenance =
      PROVENANCE_STRENGTH[d50.provenance] <= PROVENANCE_STRENGTH[sharpnessProv]
        ? d50.provenance
        : sharpnessProv;
    return {
      efficiencyAt: (d) => {
        if (d <= 0) return waterSplitRf;
        const r = (d / d50.value) ** m;
        const reduced = r / (1 + r);
        return clamp(waterSplitRf + (1 - waterSplitRf) * reduced, 0, 1);
      },
      cutSizeUm: d50.value,
      provenance,
      confidence: d50.confidence,
      verified: d50.verified && (cs?.sharpness?.verified ?? false),
      available: true,
      sharpness: m,
      waterSplitRf,
      description:
        `A curve fitted to a d50 of ${d50.value} µm (${d50.provenance}` +
        `${d50.verified ? ", verified" : ", NOT verified"}) with sharpness exponent m = ${m} ` +
        `(${sharpnessProv}), using G'(d) = (d/d50)^m / (1 + (d/d50)^m)` +
        (waterSplitRf > 0
          ? ` and a short-circuit correction with Rf = ${waterSplitRf}.`
          : ". No water-split figure is available, so no short-circuit correction is applied; " +
            "a real unit will short-circuit some fines to the underflow, which flatters " +
            "apparent fine removal while wasting underflow volume."),
    };
  }

  return {
    efficiencyAt: () => 0,
    provenance: "assumed",
    confidence: "unknown",
    verified: false,
    available: false,
    waterSplitRf: 0,
    description:
      "No cut size and no grade-efficiency curve are recorded for this unit, so its " +
      "separation behaviour cannot be modelled at all.",
  };
}

/* -------------------------------------------------------------------------- */
/* Numerical integration over the size distribution                            */
/* -------------------------------------------------------------------------- */

const GRID_MIN_UM = 0.05;
const GRID_MAX_UM = 3000;
const GRID_STEPS = 480;

interface SizeBin {
  loUm: number;
  hiUm: number;
  midUm: number;
  massFraction: number;
}

/** Discretises a PSD onto a logarithmic grid, so it can be integrated against. */
export function binPSD(psd: PSD): SizeBin[] {
  const bins: SizeBin[] = [];
  const logMin = Math.log(GRID_MIN_UM);
  const logMax = Math.log(GRID_MAX_UM);
  const step = (logMax - logMin) / GRID_STEPS;

  for (let i = 0; i < GRID_STEPS; i += 1) {
    const loUm = Math.exp(logMin + i * step);
    const hiUm = Math.exp(logMin + (i + 1) * step);
    const massFraction = massFractionBetween(psd, loUm, hiUm);
    if (massFraction > 0) {
      bins.push({ loUm, hiUm, midUm: Math.sqrt(loUm * hiUm), massFraction });
    }
  }
  return bins;
}

/* -------------------------------------------------------------------------- */
/* Hydraulic compatibility                                                     */
/* -------------------------------------------------------------------------- */

export function checkHydraulics(cyclone: Hydrocyclone, site: SiteData): HydraulicCheck {
  const op = cyclone.operating;
  const known = op?.flowMinLpm || op?.flowMaxLpm || op?.pressureMinBar || op?.pressureMaxBar;

  if (!known) {
    return {
      status: "unknown",
      note:
        `No operating flow or pressure envelope is recorded for the ${cyclone.name}, and no ` +
        "duty flow or available pressure has been supplied for the site. Hydraulic " +
        "compatibility is therefore unknown and is not reflected in the classification.",
    };
  }

  const parts: string[] = [];
  if (op?.flowMinLpm || op?.flowMaxLpm) {
    parts.push(
      `documented flow range ${op?.flowMinLpm?.value ?? "?"} to ${op?.flowMaxLpm?.value ?? "?"} L/min`,
    );
  }
  if (op?.pressureMinBar || op?.pressureMaxBar) {
    parts.push(
      `documented pressure range ${op?.pressureMinBar?.value ?? "?"} to ${op?.pressureMaxBar?.value ?? "?"} bar`,
    );
  }

  return {
    status: "unknown",
    note:
      `The ${cyclone.name} has a ${parts.join(" and ")}. The site duty flow and available ` +
      "pressure are unknown, so compatibility cannot be confirmed. Establishing the duty " +
      `point is a prerequisite to any selection${
        site.waterBody ? ` on the ${site.waterBody}` : ""
      }.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Single configuration assessment                                             */
/* -------------------------------------------------------------------------- */

export interface AssessmentContext {
  site: SiteData;
  psd: PSD;
  psdIsPlaceholder: boolean;
  particleCharacter: ParticleCharacter;
}

/** Mass fraction below which the membrane's retained load is treated as negligible. */
const NEGLIGIBLE_LOAD_FRACTION = 0.02;
/** Mass fraction above which a retained load is treated as material to fouling. */
const MATERIAL_LOAD_FRACTION = 0.1;

/* Classification thresholds on the resistance-weighted relief fraction. These
 * are screening bands chosen to separate "clearly worth a pilot" from "clearly
 * not worth one". They are a judgement about where to draw the line, not a
 * measured property of anything, and they are stated in the report. */
const RELIEF_PROMISING = 0.6;
const RELIEF_WORTH_INVESTIGATING = 0.35;
const RELIEF_MARGINAL = 0.15;

export const CAKE_RESISTANCE_NOTE =
  "Fouling load is weighted by particle size, not counted by mass alone. The " +
  "Carman-Kozeny relationship gives the specific resistance of a packed cake as " +
  "proportional to 1/d², so a kilogram of 2 µm material presents far more " +
  "resistance than a kilogram of 200 µm material. Weighting the retained mass by " +
  "1/d² is what distinguishes 'the cyclone removed a lot of solids' from 'the " +
  "cyclone removed the solids that were actually causing the problem'. The " +
  "weighting is an approximation: it assumes an incompressible cake of " +
  "size-segregated spheres and ignores particle shape, cohesion, compressibility " +
  "and pore-blocking mechanisms, all of which matter in a real filtration.";

/** Carman-Kozeny 1/d² specific-resistance weighting, referenced to 1 µm. */
function resistanceWeight(dUm: number): number {
  const d = Math.max(dUm, 0.05);
  return 1 / (d * d);
}

const CLASS_RANK: Record<ScreeningClass, number> = {
  promising: 4,
  potentially_suitable: 3,
  marginal: 2,
  unlikely: 1,
  insufficient_data: 0,
};

export const CLASS_PRESENTATION: Record<
  ScreeningClass,
  { userLabel: string; symbol: string; tone: "positive" | "caution" | "negative" | "neutral" }
> = {
  promising: { userLabel: "Promising", symbol: "✓", tone: "positive" },
  potentially_suitable: { userLabel: "Worth investigating", symbol: "✓", tone: "positive" },
  marginal: { userLabel: "Marginal", symbol: "?", tone: "caution" },
  unlikely: { userLabel: "Unlikely to help", symbol: "—", tone: "negative" },
  insufficient_data: { userLabel: "Not enough data", symbol: "·", tone: "neutral" },
};

function weakest(...items: (Provenance | undefined)[]): Provenance {
  const present = items.filter((p): p is Provenance => !!p);
  if (present.length === 0) return "assumed";
  return present.reduce((a, b) => (PROVENANCE_STRENGTH[a] <= PROVENANCE_STRENGTH[b] ? a : b));
}

function lowestConfidence(...items: (Confidence | undefined)[]): Confidence {
  const present = items.filter((c): c is Confidence => !!c);
  if (present.length === 0) return "unknown";
  return present.reduce((a, b) => (CONFIDENCE_STRENGTH[a] <= CONFIDENCE_STRENGTH[b] ? a : b));
}

export function assessConfiguration(
  ctx: AssessmentContext,
  cyclone: Hydrocyclone,
  membrane: MembraneOption,
): ConfigurationAssessment {
  const model = buildGradeEfficiencyModel(cyclone);
  const pore = membrane.poreSizeUm;
  const presentationOf = (c: ScreeningClass) => CLASS_PRESENTATION[c];

  const reasoning: string[] = [];
  const limitations: string[] = [];
  const assumptions: string[] = [];
  const hydraulic = checkHydraulics(cyclone, ctx.site);

  const abovePercent = fractionAbovePercent(ctx.psd, pore);
  const belowPercent = fractionBelowPercent(ctx.psd, pore);

  /* --- No separation data at all: refuse to guess -------------------- */
  if (!model.available) {
    const cls: ScreeningClass = "insufficient_data";
    return {
      hydrocycloneId: cyclone.id,
      hydrocycloneName: cyclone.name,
      membraneId: membrane.id,
      membraneLabel: membrane.label,
      membranePoreSizeUm: pore,
      classification: cls,
      userLabel: presentationOf(cls).userLabel,
      symbol: presentationOf(cls).symbol,
      confidence: "unknown",
      metrics: {
        membraneLoadFraction: round(abovePercent / 100, 4),
        fractionAbovePorePercent: round(abovePercent, 2),
        fractionBelowPorePercent: round(belowPercent, 2),
      },
      reasoning: [
        `No conclusion can be drawn for the ${cyclone.name}. ${model.description}`,
        `On the distribution in use, a ${membrane.label} rating would have to retain about ` +
          `${abovePercent.toFixed(1)} % of the solids mass. Whether the ${cyclone.name} could ` +
          "remove any of that upstream is unknown, because its separation behaviour is not recorded.",
        "Adding a cut size or a grade-efficiency curve for this unit to data/hydrocyclones.ts " +
          "would allow this cell to be assessed.",
      ],
      mainUncertainty: `The ${cyclone.name} has no recorded separation performance.`,
      evidence: [],
      assumptions: [],
      hydraulic,
      limitations: [
        "This cell is unassessed, not negative. Absence of catalogue data is not evidence of poor performance.",
      ],
    };
  }

  /* --- Integrate the separation model against the distribution -------- */
  const bins = binPSD(ctx.psd);
  let totalRemoved = 0; // fraction of total feed solids removed by the cyclone
  let loadMass = 0; // fraction of total feed solids the membrane must retain
  let loadRemoved = 0; // of that, the fraction the cyclone could remove first
  let finesMass = 0; // fraction finer than the pore
  let finesRemoved = 0;
  // Resistance-weighted equivalents. See CAKE_RESISTANCE_NOTE.
  let loadResistance = 0;
  let loadResistanceRemoved = 0;

  for (const bin of bins) {
    const eff = model.efficiencyAt(bin.midUm);
    const removed = bin.massFraction * eff;
    totalRemoved += removed;
    if (bin.midUm >= pore) {
      loadMass += bin.massFraction;
      loadRemoved += removed;
      const w = resistanceWeight(bin.midUm);
      loadResistance += bin.massFraction * w;
      loadResistanceRemoved += removed * w;
    } else {
      finesMass += bin.massFraction;
      finesRemoved += removed;
    }
  }

  const membraneLoadFraction = clamp(loadMass, 0, 1);
  const cycloneRemovalOfLoad = membraneLoadFraction > 1e-6 ? clamp(loadRemoved / membraneLoadFraction, 0, 1) : 0;
  const residualLoadFraction = clamp(membraneLoadFraction - loadRemoved, 0, 1);
  const finesRemovalFraction = finesMass > 1e-6 ? clamp(finesRemoved / finesMass, 0, 1) : 0;
  const foulingReliefFraction =
    loadResistance > 1e-12 ? clamp(loadResistanceRemoved / loadResistance, 0, 1) : 0;

  const metrics: ConfigurationMetrics = {
    membraneLoadFraction: round(membraneLoadFraction, 4),
    cycloneRemovalOfLoad: round(cycloneRemovalOfLoad, 4),
    foulingReliefFraction: round(foulingReliefFraction, 4),
    residualLoadFraction: round(residualLoadFraction, 4),
    overallSolidsRemoval: round(totalRemoved, 4),
    cutSizeUm: model.cutSizeUm,
    cutSizeProvenance: model.provenance,
    fractionAbovePorePercent: round(abovePercent, 2),
    fractionBelowPorePercent: round(belowPercent, 2),
  };

  /* --- Classify ------------------------------------------------------- */
  // The driver is the resistance-weighted relief, not the mass removed. A
  // cyclone can strip most of the *mass* a fine membrane retains and still
  // leave the fouling essentially untouched, because what remains is the fine
  // fraction that dominates cake resistance.
  let classification: ScreeningClass;

  if (membraneLoadFraction < NEGLIGIBLE_LOAD_FRACTION) {
    // The cyclone may remove what little the membrane would retain, but there
    // is barely any such material: the benefit is small in absolute terms.
    classification = "marginal";
  } else if (foulingReliefFraction >= RELIEF_PROMISING && membraneLoadFraction >= MATERIAL_LOAD_FRACTION) {
    classification = "promising";
  } else if (foulingReliefFraction >= RELIEF_WORTH_INVESTIGATING) {
    classification = "potentially_suitable";
  } else if (foulingReliefFraction >= RELIEF_MARGINAL) {
    classification = "marginal";
  } else {
    classification = "unlikely";
  }

  /* --- Confidence ----------------------------------------------------- */
  const evidenceProvenance = weakest(model.provenance, ctx.psd.provenance, ctx.site.particleCharacterProvenance);
  let confidence: Confidence = lowestConfidence(model.confidence, ctx.psd.confidence);
  if (evidenceProvenance === "assumed" || !model.verified || !ctx.psd.verified) {
    confidence = "low";
  }

  /* --- Reasoning ------------------------------------------------------ */
  const cut = model.cutSizeUm;
  reasoning.push(
    `A ${membrane.label} rating has to retain the particles coarser than ${pore} µm. On the ` +
      `distribution in use that is about ${abovePercent.toFixed(1)} % of the solids mass; the ` +
      `remaining ${belowPercent.toFixed(1)} % is finer than the rating and would largely pass through.`,
  );

  if (cut !== undefined) {
    reasoning.push(
      `The ${cyclone.name} is modelled with a cut size of ${cut} µm — the size at which half the ` +
        "mass reports to the underflow. That is a separation characteristic of the cyclone and is " +
        `a different quantity from the ${pore} µm membrane rating: the cyclone does not remove ` +
        "everything above its cut size, and it does remove some material below it.",
    );
  }

  reasoning.push(
    `Integrating that separation curve over the distribution, the ${cyclone.name} would remove ` +
      `about ${(cycloneRemovalOfLoad * 100).toFixed(0)} % of the mass the ${membrane.label} rating ` +
      `would otherwise have to retain, and about ${(totalRemoved * 100).toFixed(0)} % of the total ` +
      "solids mass in the feed.",
  );

  reasoning.push(
    `Mass alone overstates the benefit, though. Weighting the retained material by its ` +
      `contribution to cake resistance (which scales as 1/d²), the cyclone takes away about ` +
      `${(foulingReliefFraction * 100).toFixed(0)} % of the fouling load rather than ` +
      `${(cycloneRemovalOfLoad * 100).toFixed(0)} % of it. ` +
      (foulingReliefFraction < cycloneRemovalOfLoad - 0.1
        ? "The gap between those two figures is the important part of this assessment: what the " +
          "cyclone removes is the coarse material, and what dominates the fouling at this rating " +
          "is the fine material it leaves behind."
        : "The two figures are close here, which means the material the cyclone removes is also " +
          "the material that would dominate the fouling — that is what makes a combination worth " +
          "pursuing."),
  );

  if (classification === "promising" || classification === "potentially_suitable") {
    reasoning.push(
      `In mass terms that leaves roughly ${(residualLoadFraction * 100).toFixed(1)} % of the feed ` +
        `solids still arriving at the membrane as retained material, against ` +
        `${(membraneLoadFraction * 100).toFixed(1)} % without pre-treatment. A reduction of that ` +
        "order in retained solids, concentrated in the fraction that drives cake resistance, is " +
        "the mechanism by which hydrocyclone pre-treatment could increase filterable volume. The " +
        "magnitude of any throughput improvement is not predicted here and requires testing.",
    );
  }

  if (membraneLoadFraction < NEGLIGIBLE_LOAD_FRACTION) {
    reasoning.push(
      `Only about ${(membraneLoadFraction * 100).toFixed(2)} % of the solids mass is coarser than ` +
        `${pore} µm, so the membrane's retained-solids duty is already light at this rating. Even ` +
        "efficient upstream removal takes away very little in absolute terms. A larger pore size " +
        "is not automatically better: the rating still has to meet the process filtration " +
        "requirement, which this screening does not assess.",
    );
  }

  if (foulingReliefFraction < RELIEF_WORTH_INVESTIGATING && membraneLoadFraction >= NEGLIGIBLE_LOAD_FRACTION) {
    reasoning.push(
      `The fouling load at a ${membrane.label} rating is dominated by particles at or below the ` +
        `${cyclone.name}'s cut size${cut !== undefined ? ` of ${cut} µm` : ""}, where its separation ` +
        "efficiency is low. Pre-treatment would pass that fraction straight through to the " +
        "membrane. It would still remove coarse material, and that is not worthless — it protects " +
        "against blinding and abrasion — but it is not the fraction governing membrane loading at " +
        "this rating, which is why this combination does not look attractive on present evidence.",
    );
  }

  if (finesMass > 0.2) {
    reasoning.push(
      `About ${(finesMass * 100).toFixed(0)} % of the solids mass is finer than the rating, and the ` +
        `cyclone is modelled as removing only ${(finesRemovalFraction * 100).toFixed(0)} % of it. ` +
        "Fine material passing the membrane still contributes to internal fouling, which this " +
        "mass-based screening does not quantify.",
    );
  }

  /* --- Assumptions and limitations ------------------------------------ */
  const density = ASSUMED_PARTICLE_DENSITY_KG_M3[ctx.particleCharacter];
  assumptions.push(
    `Separation model: ${model.description}`,
    `Particle population: ${describeParticleCharacter(ctx.particleCharacter)}, ` +
      `effective density taken as ${density.value} kg/m³ (${density.provenance}). ${density.note}`,
    `Size distribution: ${ctx.psd.label} (${ctx.psd.provenance}${ctx.psd.verified ? ", verified" : ", not verified"}).`,
  );

  if (ctx.psdIsPlaceholder) {
    limitations.push(
      "No site-specific particle-size distribution was available. The percentages above are " +
        "computed from a screening placeholder distribution and should be read as illustrating " +
        "the shape of the argument, not as site figures.",
    );
  }
  if (!model.verified) {
    limitations.push(
      `The separation data for the ${cyclone.name} is not verified against a source. Until a ` +
        "measured or published cut size or grade-efficiency curve is entered in the catalogue, " +
        "this cell's classification cannot rise above low confidence.",
    );
  }
  if (model.waterSplitRf === 0) {
    limitations.push(
      "No water split (Rf) is recorded, so short-circuiting of feed to the underflow is not " +
        "modelled. A real unit sends some fines to the underflow regardless of size, and also " +
        "loses that underflow volume, which matters for the water balance.",
    );
  }
  limitations.push(CAKE_RESISTANCE_NOTE);
  limitations.push(MEMBRANE_RETENTION_NOTE);
  limitations.push(
    "The screening is on a solids-mass basis. Fouling also depends on particle shape, " +
      "cohesiveness, organic content and the operating regime, none of which are modelled.",
  );

  const mainUncertainty = ctx.psdIsPlaceholder
    ? "The particle-size distribution. Nothing in this cell is anchored to a site measurement, " +
      "and the classification moves substantially with the distribution assumed."
    : !model.verified
      ? `The separation performance of the ${cyclone.name}, which is not yet backed by a verified source.`
      : "The relationship between reduced retained-solids mass and actual filterable volume, " +
        "which is not predicted by this screening.";

  const p = presentationOf(classification);
  return {
    hydrocycloneId: cyclone.id,
    hydrocycloneName: cyclone.name,
    membraneId: membrane.id,
    membraneLabel: membrane.label,
    membranePoreSizeUm: pore,
    classification,
    userLabel: p.userLabel,
    symbol: p.symbol,
    confidence,
    metrics,
    reasoning,
    mainUncertainty,
    evidence: ctx.site.data.filter(
      (d) => d.provenance === "measured" || d.provenance === "published",
    ),
    assumptions,
    hydraulic,
    limitations,
  };
}

/* -------------------------------------------------------------------------- */
/* Full matrix                                                                 */
/* -------------------------------------------------------------------------- */

export function assessAllConfigurations(
  ctx: AssessmentContext,
  cyclones: Hydrocyclone[],
  membranes: MembraneOption[],
): ConfigurationAssessment[] {
  const out: ConfigurationAssessment[] = [];
  for (const cyclone of cyclones) {
    for (const membrane of membranes) {
      out.push(assessConfiguration(ctx, cyclone, membrane));
    }
  }
  return out;
}

/** Benefit magnitude used only for ranking; deliberately not shown as a score. */
function benefitScore(a: ConfigurationAssessment): number {
  const relief = a.metrics.foulingReliefFraction ?? 0;
  const removedMass = (a.metrics.membraneLoadFraction ?? 0) * (a.metrics.cycloneRemovalOfLoad ?? 0);
  return (
    CLASS_RANK[a.classification] * 1000 +
    relief * 80 +
    removedMass * 20 +
    CONFIDENCE_STRENGTH[a.confidence]
  );
}

export function rankConfigurations(matrix: ConfigurationAssessment[]): ConfigurationAssessment[] {
  return [...matrix].sort((a, b) => benefitScore(b) - benefitScore(a));
}

/**
 * Side-by-side comparison of two or more hydrocyclones over the same site and
 * membrane range. Answers "compare the 4 mm and the 10 mm".
 */
export interface CycloneComparison {
  hydrocycloneId: string;
  hydrocycloneName: string;
  cutSizeUm?: number;
  cutSizeProvenance?: Provenance;
  promisingMembranes: string[];
  worthInvestigatingMembranes: string[];
  unlikelyMembranes: string[];
  bestCell?: ConfigurationAssessment;
  /** Largest share of the membrane-retained load this unit removes anywhere in the range. */
  peakLoadRemoval: number;
}

export function compareConfigurations(
  matrix: ConfigurationAssessment[],
  hydrocycloneIds?: string[],
): CycloneComparison[] {
  const ids = hydrocycloneIds?.length
    ? hydrocycloneIds
    : [...new Set(matrix.map((m) => m.hydrocycloneId))];

  return ids.map((id) => {
    const cells = matrix.filter((m) => m.hydrocycloneId === id);
    const ranked = rankConfigurations(cells);
    return {
      hydrocycloneId: id,
      hydrocycloneName: cells[0]?.hydrocycloneName ?? id,
      cutSizeUm: cells[0]?.metrics.cutSizeUm,
      cutSizeProvenance: cells[0]?.metrics.cutSizeProvenance,
      promisingMembranes: cells.filter((c) => c.classification === "promising").map((c) => c.membraneLabel),
      worthInvestigatingMembranes: cells
        .filter((c) => c.classification === "potentially_suitable")
        .map((c) => c.membraneLabel),
      unlikelyMembranes: cells.filter((c) => c.classification === "unlikely").map((c) => c.membraneLabel),
      bestCell: ranked[0],
      peakLoadRemoval: Math.max(0, ...cells.map((c) => c.metrics.cycloneRemovalOfLoad ?? 0)),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Useful window                                                               */
/* -------------------------------------------------------------------------- */

export function findUsefulWindow(
  matrix: ConfigurationAssessment[],
  membranes: MembraneOption[],
): UsefulWindow {
  const bestPerPore = membranes.map((m) => {
    const cells = matrix.filter((c) => c.membraneId === m.id);
    const best = cells.reduce<ConfigurationAssessment | undefined>(
      (acc, c) => (!acc || CLASS_RANK[c.classification] > CLASS_RANK[acc.classification] ? c : acc),
      undefined,
    );
    return { membrane: m, best };
  });

  const useful = bestPerPore.filter(
    (x) =>
      x.best &&
      (x.best.classification === "promising" || x.best.classification === "potentially_suitable"),
  );

  const confidence = lowestConfidence(...matrix.map((c) => c.confidence));

  if (useful.length === 0) {
    const anyAssessed = matrix.some((c) => c.classification !== "insufficient_data");
    return {
      statement: anyAssessed
        ? "The available evidence does not currently support a useful membrane pore-size window. " +
          "Across the ratings screened, the hydrocyclones in the catalogue are not shown to remove " +
          "enough of the material the membrane would retain for pre-treatment to look worthwhile. " +
          "This is a statement about the evidence available, not a demonstration that pre-treatment " +
          "cannot work here."
        : "No membrane pore-size window can be identified, because no hydrocyclone in the catalogue " +
          "has recorded separation performance to assess.",
      confidence: anyAssessed ? confidence : "unknown",
    };
  }

  // Longest contiguous run of useful ratings, in pore-size order.
  let bestRun: typeof useful = [];
  let run: typeof useful = [];
  for (const entry of bestPerPore) {
    const isUseful = useful.includes(entry);
    if (isUseful) {
      run.push(entry);
      if (run.length > bestRun.length) bestRun = [...run];
    } else {
      run = [];
    }
  }
  if (bestRun.length === 0) bestRun = useful;

  const lowerUm = bestRun[0].membrane.poreSizeUm;
  const upperUm = bestRun[bestRun.length - 1].membrane.poreSizeUm;
  const excluded = bestPerPore
    .filter((x) => !useful.includes(x))
    .map((x) => x.membrane.label);

  const statement =
    lowerUm === upperUm
      ? `On the current evidence, hydrocyclone pre-treatment looks worth investigating only at ` +
        `about ${lowerUm} µm.` +
        (excluded.length ? ` It does not look worthwhile at ${excluded.join(", ")}.` : "")
      : `On the current evidence, hydrocyclone pre-treatment looks most worth investigating for ` +
        `membrane ratings of roughly ${lowerUm} to ${upperUm} µm.` +
        (excluded.length
          ? ` Outside that band — at ${excluded.join(", ")} — the case is weaker, either because ` +
            "the cyclone cannot remove the fraction that would load the membrane, or because " +
            "there is very little retained mass to remove."
          : "");

  return { lowerUm, upperUm, statement, confidence };
}

/* -------------------------------------------------------------------------- */
/* Report assembly                                                             */
/* -------------------------------------------------------------------------- */

function overallAssessment(
  matrix: ConfigurationAssessment[],
  window: UsefulWindow,
  siteSpecific: boolean,
): ScreeningReport["overall"] {
  const prefix = siteSpecific
    ? ""
    : "This is the application's default result, not an assessment of this site: no evidence " +
      "specific to it was found. With that said — ";
  const promising = matrix.filter((c) => c.classification === "promising");
  const worth = matrix.filter((c) => c.classification === "potentially_suitable");
  const assessed = matrix.filter((c) => c.classification !== "insufficient_data");
  const confidence = lowestConfidence(...matrix.map((c) => c.confidence));

  if (assessed.length === 0) {
    return {
      classification: "insufficient_data",
      userLabel: "Not enough data to screen",
      confidence: "unknown",
      summary:
        "No hydrocyclone in the catalogue has recorded separation performance, so no " +
        "configuration could be assessed. Add a cut size or grade-efficiency curve to " +
        "data/hydrocyclones.ts and re-run.",
    };
  }

  if (promising.length > 0) {
    return {
      classification: "promising",
      userLabel: "Promising for further investigation",
      confidence,
      summary:
        prefix +
        `${promising.length} of ${matrix.length} screened combinations look promising and ` +
        `${worth.length} more are worth investigating. ${window.statement} The mechanism is a ` +
        "reduction in the coarser solids reaching the membrane, which could improve filterability; " +
        "the size of any throughput gain is not predicted here and needs testing.",
    };
  }

  if (worth.length > 0) {
    return {
      classification: "potentially_suitable",
      userLabel: "Worth investigating, with reservations",
      confidence,
      summary:
        prefix +
        `No combination reaches the "promising" threshold, but ${worth.length} of ${matrix.length} ` +
        `are worth investigating. ${window.statement}`,
    };
  }

  return {
    classification: "unlikely",
    userLabel: "Hydrocyclone pre-treatment looks unlikely to help here",
    confidence,
    summary:
      prefix +
      "On the evidence available, none of the catalogued hydrocyclones removes enough of the " +
      "material the screened membrane ratings would retain for pre-treatment to look worthwhile. " +
      `${window.statement} The most likely way to overturn this conclusion is a measured ` +
      "particle-size distribution from the site, which would replace the assumptions this " +
      "screening rests on.",
  };
}

function buildNarrative(
  site: SiteData,
  ctx: AssessmentContext,
  stats: PSDStatistics,
  cyclones: Hydrocyclone[],
  window: UsefulWindow,
  overall: ScreeningReport["overall"],
): ReportNarrative {
  const known: string[] = [];
  const published: string[] = [];
  const calculated: string[] = [];
  const inferred: string[] = [];
  const assumed: string[] = [];

  known.push(`The site was entered as "${site.query}".`);
  if (site.resolvedName) known.push(`It was resolved to ${site.resolvedName}.`);

  for (const d of site.data) {
    const line = `${d.parameter}: ${d.value}${d.unit ? ` ${d.unit}` : ""}${d.source ? ` (${d.source})` : ""}`;
    if (d.provenance === "measured" || d.provenance === "published") published.push(line);
    else if (d.provenance === "inferred") inferred.push(line);
    else if (d.provenance === "assumed") assumed.push(line);
    else calculated.push(line);
  }

  calculated.push(
    `From the distribution in use, D10 = ${stats.d10Um} µm, D50 = ${stats.d50Um} µm and ` +
      `D90 = ${stats.d90Um} µm (span ${stats.span}).`,
  );

  for (const c of cyclones) {
    const cs = c.cutSize?.d50Um;
    if (cs) {
      const line = `${c.name}: cut size ${cs.value} µm — ${cs.provenance}${cs.verified ? ", verified" : ", NOT verified"}.`;
      if (cs.provenance === "measured" || cs.provenance === "published") published.push(line);
      else if (cs.provenance === "assumed") assumed.push(line);
      else inferred.push(line);
    } else {
      assumed.push(`${c.name}: no cut size recorded, so it could not be assessed.`);
    }
  }

  assumed.push(`Solids character: ${site.particleCharacterBasis}`);

  if (ctx.psdIsPlaceholder) {
    assumed.push(
      `No site particle-size distribution was found, so a screening placeholder for ` +
        `${describeParticleCharacter(ctx.particleCharacter)} was used. This is the dominant ` +
        "assumption in the whole assessment.",
    );
  }
  for (const a of site.assumptions) assumed.push(`${a.statement} (${a.basis})`);

  const conclusions = [
    overall.summary,
    window.statement,
    "These conclusions follow from the assumptions listed above. Where an assumption is replaced " +
      "by a site measurement the matrix will change, and the application will re-run it.",
  ];

  const dedupe = (xs: string[]) => [...new Set(xs)];
  return {
    known: dedupe(known),
    published: dedupe(published),
    calculated: dedupe(calculated),
    inferred: dedupe(inferred),
    assumed: dedupe(assumed),
    conclusions,
  };
}

function buildDecisionTree(
  ctx: AssessmentContext,
  stats: PSDStatistics,
  matrix: ConfigurationAssessment[],
  window: UsefulWindow,
): DecisionTreeStep[] {
  const coarseFraction = matrix.reduce(
    (max, c) => Math.max(max, c.metrics.membraneLoadFraction ?? 0),
    0,
  );
  const anyGoodSeparation = matrix.some((c) => (c.metrics.cycloneRemovalOfLoad ?? 0) >= 0.45);

  return [
    {
      question: "What solids are likely present?",
      answer: describeParticleCharacter(ctx.particleCharacter),
      provenance: ctx.site.particleCharacterProvenance,
      consequence: "Sets the size distribution and effective density used throughout.",
    },
    {
      question: "What does the size distribution look like?",
      answer: `D10 ${stats.d10Um} µm, D50 ${stats.d50Um} µm, D90 ${stats.d90Um} µm`,
      provenance: stats.provenance,
      consequence: ctx.psdIsPlaceholder
        ? "Placeholder distribution: every downstream number inherits low confidence."
        : "Derived from the supplied distribution.",
    },
    {
      question: "Are there enough coarse particles for hydrocyclone separation to matter?",
      answer:
        coarseFraction >= MATERIAL_LOAD_FRACTION
          ? `Yes — up to ${(coarseFraction * 100).toFixed(0)} % of the solids mass is coarse enough to ` +
            "be both membrane-retained and cyclone-removable at some rating in the range."
          : `Not clearly — at most ${(coarseFraction * 100).toFixed(1)} % of the solids mass sits in ` +
            "that overlap at any rating screened.",
      provenance: "calculated",
      consequence:
        coarseFraction >= MATERIAL_LOAD_FRACTION
          ? "Proceed to evaluate the cyclone configurations."
          : "Hydrocyclone benefit is likely limited whatever the configuration.",
    },
    {
      question: "Do the catalogued cyclones actually separate that fraction?",
      answer: anyGoodSeparation
        ? "At least one unit removes a substantial share of the membrane-retained mass at some rating."
        : "No catalogued unit removes a substantial share of the membrane-retained mass at any rating.",
      provenance: "calculated",
      consequence: anyGoodSeparation
        ? "A useful window can be identified."
        : "No useful window on present evidence.",
    },
    {
      question: "Where is the useful membrane window?",
      answer: window.statement,
      provenance: "calculated",
      consequence: "Sets what should be pilot-tested first.",
    },
  ];
}

function buildRecommendedTests(
  ctx: AssessmentContext,
  best: ConfigurationAssessment[],
  cyclones: Hydrocyclone[],
): string[] {
  const tests: string[] = [];

  if (ctx.psdIsPlaceholder) {
    tests.push(
      "Measure a particle-size distribution on a raw water sample from the intended abstraction " +
        "point. This is the single most valuable measurement: it would replace the assumption the " +
        "entire matrix currently rests on. Sample on both a baseflow day and, if possible, a rising " +
        "limb, because the two can differ substantially.",
    );
    tests.push(
      "As a low-cost proxy in the meantime, run a settle-bottle test on a raw sample: record the " +
        "volume and character of what settles in 1, 5, 30 and 120 minutes. Rapid settling of gritty " +
        "material indicates a coarse dense fraction that a hydrocyclone can act on; a persistent " +
        "turbid haze indicates fines that it cannot.",
    );
  }

  const unverified = cyclones.filter((c) => !c.dataComplete);
  if (unverified.length > 0) {
    tests.push(
      `Establish a measured grade-efficiency curve for ${unverified.map((c) => c.name).join(" and ")} ` +
        "on a representative feed. The catalogue currently holds screening placeholders for these " +
        "units, which caps every classification at low confidence regardless of the site data.",
    );
  }

  tests.push(
    "Measure the duty: available feed flow, feed pressure and acceptable underflow (reject) " +
      "volume. Hydraulic compatibility is currently unknown, and underflow volume is a real " +
      "operating cost that this screening does not weigh.",
  );

  const top = best[0];
  if (top && top.classification !== "insufficient_data") {
    tests.push(
      `For a bench or pilot trial, start with ${top.hydrocycloneName} upstream of a ` +
        `${top.membraneLabel} element, since that is the strongest candidate in the present matrix. ` +
        "Run it against an unprotected control on the same feed and compare filtered volume to a " +
        "fixed terminal pressure. Without the control the result cannot be attributed to the cyclone.",
    );
  }

  tests.push(
    "Confirm the filtration requirement the process actually needs. This screening asks only " +
      "whether pre-treatment helps at a given rating; it does not check that the rating meets the " +
      "downstream duty, and a coarser membrane is not automatically a better one.",
  );

  return tests;
}

function buildWarnings(
  ctx: AssessmentContext,
  site: SiteData,
  cyclones: Hydrocyclone[],
): string[] {
  const warnings: string[] = [];

  if (!site.siteSpecific) {
    warnings.push(
      "THIS RESULT IS NOT SITE-SPECIFIC. No provider returned any measured or published datum " +
        `for "${site.query}", and nothing was supplied about its solids, so the assessment below ` +
        "is the application's default: it would come back identical for any other location. It " +
        "shows how the method behaves, not what this site is like. Describe the water in the " +
        "notes box, or supply a particle-size distribution, to get an assessment that is actually " +
        "about this site.",
    );
  }

  const placeholderUnits = cyclones.filter(
    (c) => c.cutSize?.d50Um && !c.cutSize.d50Um.verified,
  );
  if (placeholderUnits.length > 0) {
    warnings.push(
      `Hydrocyclone separation data is NOT verified for ${placeholderUnits
        .map((c) => c.name)
        .join(", ")}. The catalogue holds screening placeholders, not equipment data, so the ` +
        "matrix shows the shape of the argument rather than a prediction for these units.",
    );
  }
  if (ctx.psdIsPlaceholder) {
    warnings.push(
      "No site-specific particle-size distribution was found. A placeholder distribution was used " +
        "and overall confidence is capped at low.",
    );
  }
  for (const r of site.providerReports) {
    if (r.status === "error") warnings.push(`${r.providerName}: ${r.message}`);
  }
  return warnings;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export interface RunScreeningInput {
  scenario: Scenario;
  queryId?: string;
  timestamp?: string;
}

export function runScreening(input: RunScreeningInput): ScreeningReport {
  const { scenario } = input;
  const site = scenario.siteData;

  const cyclones = getHydrocyclones(scenario.hydrocycloneIds);
  const membranes = getMembraneOptions(scenario.membraneIds);

  const resolved = resolvePSD(site, scenario.psdOverride, scenario.particleCharacterOverride);
  const ctx: AssessmentContext = {
    site,
    psd: resolved.psd,
    psdIsPlaceholder: resolved.isPlaceholder,
    particleCharacter: resolved.character,
  };

  const stats = analysePSD(resolved.psd);
  const matrix = assessAllConfigurations(ctx, cyclones, membranes);
  const window = findUsefulWindow(matrix, membranes);
  const overall = overallAssessment(matrix, window, site.siteSpecific);
  const ranked = rankConfigurations(matrix);

  return {
    queryId: input.queryId ?? `q_${Date.now().toString(36)}`,
    timestamp: input.timestamp ?? new Date().toISOString(),
    siteQuery: scenario.siteQuery,
    userNotes: scenario.userNotes,
    siteData: site,
    hydrocyclones: cyclones,
    membranes,
    psdStatistics: stats,
    psdSource: resolved.psd,
    matrix,
    overall,
    usefulWindow: window,
    best: ranked
      .filter((c) => c.classification === "promising" || c.classification === "potentially_suitable")
      .slice(0, 5),
    borderline: ranked.filter((c) => c.classification === "marginal"),
    unlikely: ranked.filter((c) => c.classification === "unlikely"),
    missingData: ranked.filter((c) => c.classification === "insufficient_data"),
    narrative: buildNarrative(site, ctx, stats, cyclones, window, overall),
    unknowns: site.unknowns,
    sources: collectSources(site),
    recommendedNextTests: buildRecommendedTests(ctx, ranked, cyclones),
    decisionTree: buildDecisionTree(ctx, stats, matrix, window),
    warnings: buildWarnings(ctx, site, cyclones),
    scenario,
  };
}

/** Compact matrix view: rows are cyclones, columns are pore sizes. */
export function matrixGrid(
  report: ScreeningReport,
): { hydrocycloneId: string; hydrocycloneName: string; cells: ConfigurationAssessment[] }[] {
  return report.hydrocyclones.map((h) => ({
    hydrocycloneId: h.id,
    hydrocycloneName: h.name,
    cells: report.membranes.map(
      (m) => report.matrix.find((c) => c.hydrocycloneId === h.id && c.membraneId === m.id)!,
    ),
  }));
}
