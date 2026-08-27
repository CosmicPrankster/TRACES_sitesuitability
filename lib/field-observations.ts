import type {
  Confidence,
  ConfigurationAssessment,
  FieldObservation,
  Hydrocyclone,
  MembraneOption,
} from "@/types";
import { CONFIDENCE_STRENGTH } from "@/types";
import { FEED_WEIGHT, findFieldObservations } from "@/data/field-observations";

/**
 * How recorded field observations are allowed to affect the assessment.
 *
 * The governing principle is that an observation counts for exactly what it
 * showed and no more. Seeing a hydrocyclone separate solids is real evidence
 * that it works at that site; it is not evidence of a cut size, an efficiency,
 * or a membrane benefit. The engine therefore lets an observation raise
 * confidence and add reasoning, but never lets it manufacture a number.
 */

export { findFieldObservations };

/** Observations that bear on one specific hydrocyclone. */
export function observationsForCyclone(
  observations: FieldObservation[],
  cyclone: Hydrocyclone,
): FieldObservation[] {
  return observations.filter(
    (o) => !o.hydrocycloneIds || o.hydrocycloneIds.includes(cyclone.id),
  );
}

/** Observations that bear on one specific configuration. */
export function observationsForConfiguration(
  observations: FieldObservation[],
  cyclone: Hydrocyclone,
  membrane: MembraneOption,
): FieldObservation[] {
  return observationsForCyclone(observations, cyclone).filter(
    (o) => !o.membraneIds || o.membraneIds.includes(membrane.id),
  );
}

function step(c: Confidence, by: number): Confidence {
  const order: Confidence[] = ["unknown", "low", "medium", "high"];
  const i = Math.max(0, Math.min(order.length - 1, order.indexOf(c) + by));
  return order[i];
}

export interface ObservationEffect {
  confidence: Confidence;
  reasoning: string[];
  limitations: string[];
  /** True when an observation moved the confidence. */
  lifted: boolean;
}

/**
 * Applies the observations to one cell.
 *
 * Confidence can be raised by at most one step, and never above "medium".
 * Reaching "high" requires a measured grade-efficiency curve in the catalogue -
 * a qualitative field result, however encouraging, cannot substitute for one.
 */
export function applyObservations(
  base: Confidence,
  observations: FieldObservation[],
  cyclone: Hydrocyclone,
  membrane: MembraneOption,
): ObservationEffect {
  const relevant = observationsForConfiguration(observations, cyclone, membrane);
  const reasoning: string[] = [];
  const limitations: string[] = [];

  if (relevant.length === 0) {
    return { confidence: base, reasoning, limitations, lifted: false };
  }

  let confidence = base;
  let lifted = false;

  for (const o of relevant) {
    const weight = FEED_WEIGHT[o.feed];
    const negative = o.kind === "no_separation" || o.kind === "blockage";

    const header =
      `Field observation at ${o.siteName}${o.date ? ` on ${o.date}` : ""}: ${o.observation}`;
    reasoning.push(header);

    if (o.demonstrates.length > 0) {
      reasoning.push(`That establishes: ${o.demonstrates.join(" ")}`);
    }

    reasoning.push(weight.caveat);

    if (o.doesNotDemonstrate.length > 0) {
      limitations.push(
        `The field observation at ${o.siteName} does not establish: ${o.doesNotDemonstrate.join(" ")}`,
      );
    } else {
      limitations.push(
        `The field observation at ${o.siteName} has no recorded limits ` +
          "(`doesNotDemonstrate` is empty), so how far it can be read is unclear. Fill that in " +
          "in data/field-observations.ts.",
      );
    }

    if (negative) {
      // A negative result is evidence too, and it is not softened.
      confidence = step(confidence, 1);
      lifted = true;
      reasoning.push(
        "This is a negative field result. It is weighed as evidence in the same way a positive " +
          "one would be, and it counts against this configuration.",
      );
      continue;
    }

    if (o.kind === "separation_confirmed" && CONFIDENCE_STRENGTH[confidence] < CONFIDENCE_STRENGTH["medium"]) {
      confidence = step(confidence, 1);
      lifted = true;
      reasoning.push(
        `Confidence is raised one step because the ${cyclone.name} has been observed separating ` +
          "solids on water from this site, rather than merely assumed to. It is capped at medium: " +
          "a qualitative field result cannot substitute for a measured grade-efficiency curve, " +
          "which is what this cell would need to reach high confidence.",
      );
    }
  }

  // Never above medium on field evidence alone.
  if (CONFIDENCE_STRENGTH[confidence] > CONFIDENCE_STRENGTH["medium"]) {
    confidence = "medium";
  }

  return { confidence, reasoning, limitations, lifted };
}

/**
 * A short line for the top of the report, so a reader sees immediately that
 * this site has real evidence behind it.
 */
export function summariseObservations(observations: FieldObservation[]): string | undefined {
  if (observations.length === 0) return undefined;

  const units = [...new Set(observations.flatMap((o) => o.hydrocycloneIds ?? []))];
  const confirmed = observations.filter((o) => o.kind === "separation_confirmed");
  const negative = observations.filter(
    (o) => o.kind === "no_separation" || o.kind === "blockage",
  );

  const parts: string[] = [];
  if (confirmed.length > 0) {
    parts.push(
      `Separation has been physically confirmed at this site` +
        (units.length ? ` for ${units.length === 1 ? "the" : ""} ${units.join(" and ")}` : "") +
        `. That is direct evidence, and it is why parts of this assessment carry more ` +
        `confidence than a desk screening normally would.`,
    );
  }
  if (negative.length > 0) {
    parts.push(`${negative.length} negative or operability observation(s) are also on record.`);
  }
  parts.push(
    `${observations.length} field observation(s) in total are held for this site in ` +
      "data/field-observations.ts.",
  );
  return parts.join(" ");
}

/** Cells that carry field evidence, for the report's summary sections. */
export function cellsWithFieldEvidence(
  matrix: ConfigurationAssessment[],
): ConfigurationAssessment[] {
  return matrix.filter((c) => c.fieldEvidence.length > 0);
}
