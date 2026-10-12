import { Z90, type Psd } from "./psd";

/**
 * BLOCK 6, rebuild phase 7 - the on-site field-update path.
 *
 * Per the rebuild plan: let someone standing at the site correct a desk
 * prediction on the spot, through a form, with a deterministic recompute -
 * no LLM anywhere in the scoring. (A future free-text/chat intake would
 * only ever PARSE words into the structured fields this module already
 * takes - it would never compute a verdict itself, matching the project's
 * standing rule that AI explains and consolidates, it never scores.)
 *
 * Three simple field tests a technician can realistically do in a few
 * minutes, none needing lab equipment:
 *
 *   grain card      Visually matching the settled solids against a
 *                    reference card's size classes (a real field tool -
 *                    the classes below are the standard Udden-Wentworth/
 *                    ISO 14688 size scale, not invented).
 *   settle test      Fill a jar with raw water, watch how fast it clears -
 *                    corroborates or contradicts the grain-card read, the
 *                    same way lib/character.ts's geology corroboration
 *                    corroborates or contradicts the catchment read: a
 *                    disagreement is reported, not averaged away.
 *   turbidity tube   A field turbidity tube reading. Devices and their
 *                    depth-to-NTU calibration vary too much to convert
 *                    this to a number this tool trusts - it is reported
 *                    as context, never fed into the particle-size shape
 *                    or treated as a concentration (see lib/sources/
 *                    water-quality.ts's own turbidity-vs-concentration
 *                    split for the same reasoning).
 *
 * A result here is a REAL, field-measured PSD, not a guess - it replaces
 * psdForCharacter's assumed distribution for this one session's report,
 * the same way a real trial's measured feed PSD (lib/baseline.ts's
 * psdFromMeasuredD20D50D90) always supersedes a guess. It is not written
 * back to data/particle-sizes.json or data/field-observations.json
 * automatically - this is a live, in-session correction, not a permanent
 * data-file edit, which stays a deliberate, reviewed, human action.
 */

export type GrainCardClass = "clay" | "silt" | "fine_sand" | "medium_sand" | "coarse_sand" | "gravel";

/**
 * Representative d50 for each class: the geometric mean of the real
 * Udden-Wentworth/ISO 14688 size range for that class (clay <2 um is given
 * no natural lower bound, so 2 um - the class boundary itself - is used
 * directly). Worth noting: the silt figure (~16 um) lands close to this
 * tool's own guessed "silt" profile (15 um, data/particle-sizes.json) -
 * a reassuring cross-check between the real scale and the existing guess,
 * not a coincidence this module relies on.
 */
const GRAIN_CARD_D50_UM: Record<GrainCardClass, number> = {
  clay: 2,
  silt: 16, // sqrt(4 * 63)
  fine_sand: 112, // sqrt(63 * 200)
  medium_sand: 355, // sqrt(200 * 630)
  coarse_sand: 1122, // sqrt(630 * 2000)
  gravel: 4000, // representative only - see the bed-material caveat below
};

const GRAIN_CARD_LABEL: Record<GrainCardClass, string> = {
  clay: "clay (under 4 µm)",
  silt: "silt (4-63 µm)",
  fine_sand: "fine sand (63-200 µm)",
  medium_sand: "medium sand (200-630 µm)",
  coarse_sand: "coarse sand (630 µm-2 mm)",
  gravel: "gravel (over 2 mm)",
};

/**
 * A single grain-card class gives a d50 anchor but not a measured spread -
 * this assumes a moderate, typical-for-natural-sediment spread (d10 at
 * roughly d50/1.9, d90 at roughly d50*1.9 - a factor-of-~3.6 range,
 * reusing the same Z90 z-score the rest of lib/psd.ts's log-normal
 * machinery is built on) rather than claiming a measured one. That
 * assumption is exactly why a grain-card-only read is "field-adjusted",
 * not "measured" - see psdFromFieldObservation.
 */
function psdFromGrainCardAlone(cls: GrainCardClass): Psd {
  const d50Um = GRAIN_CARD_D50_UM[cls];
  const sigma = 0.5; // natural-log units either side - a typical single-mode natural sediment spread
  return {
    d10Um: d50Um * Math.exp(-Z90 * sigma),
    d50Um,
    d90Um: d50Um * Math.exp(Z90 * sigma),
    status: "field-adjusted",
    label: `Field grain-card read: ${GRAIN_CARD_LABEL[cls]}`,
    note: "d50 from the matched grain-card class; the spread around it is assumed, not measured - see lib/field-update.ts.",
  };
}

export interface SettleTestResult {
  /** Time until the water visibly cleared, in minutes - null if it never cleared within the observation window. */
  clearedWithinMinutes: number | null;
  /** Hours the observer watched before giving up, if it never cleared - for context on how long "still hazy" actually means. */
  observedForHours: number | null;
}

export interface FieldObservationInput {
  grainCardClass?: GrainCardClass;
  settleTest?: SettleTestResult;
  /** Raw field turbidity-tube reading, in cm - reported as context only, see the module header for why it isn't converted to a number this tool scores on. */
  turbidityTubeReadingCm?: number;
  siteNote?: string;
}

export interface FieldPsdResult {
  psd: Psd;
  /** Ordered, plain-English reasoning - same convention as character.ts's CharacterInference.reasoning. */
  reasoning: string[];
  /** Plain-text context that didn't feed into the PSD itself (turbidity tube, free-text note). */
  additionalContext: string[];
}

const RAPID_CLEAR_MINUTES = 15; // a settle test clearing this fast is a real coarse-dominated signal, not a guess
const PERSISTENT_HAZE_HOURS = 2; // still hazy this long is a real fine/cohesive signal

/**
 * Turns whatever field tests were actually done into a real PSD for this
 * session, or null if nothing size-relevant was reported (a turbidity-tube
 * reading or a site note alone has no particle-size shape to give).
 *
 * The grain card is the primary signal, since it directly observes size.
 * The settle test corroborates or contradicts it, the same discipline
 * character.ts's geology corroboration uses: agreement is noted and
 * nudges confidence up (field-adjusted -> measured), disagreement is
 * reported plainly rather than averaged away, and the grain-card read
 * (the more direct size evidence) is kept as the answer either way.
 */
export function psdFromFieldObservation(input: FieldObservationInput): FieldPsdResult | null {
  const additionalContext: string[] = [];
  if (typeof input.turbidityTubeReadingCm === "number") {
    additionalContext.push(
      `Field turbidity tube reading: ${input.turbidityTubeReadingCm} cm. Tube devices and their depth-to-NTU calibration vary too much between models to convert this into a number this tool scores on - recorded for context, not used in the particle-size estimate.`,
    );
  }
  if (input.siteNote?.trim()) {
    additionalContext.push(`Site note: "${input.siteNote.trim()}"`);
  }

  if (!input.grainCardClass) {
    return null;
  }

  if (input.grainCardClass === "gravel") {
    additionalContext.push(
      "A grain-card read of \"gravel\" almost always means bed material was sampled, not the suspended load - gravel does not stay in suspension. This is the exact trap data/particle-sizes.json warns about: the suspended load of a river is normally much finer than its bed material. Treat this reading as a sign the sample needs retaking from water actually in suspension, not as this site's suspended PSD.",
    );
  }

  const reasoning: string[] = [
    `Grain-card match: ${GRAIN_CARD_LABEL[input.grainCardClass]}. This is a real, direct observation of the settled solids' size, not an assumption - it replaces the desk-based guess for this report.`,
  ];

  let psd = psdFromGrainCardAlone(input.grainCardClass);
  const coarseCard = GRAIN_CARD_D50_UM[input.grainCardClass] >= GRAIN_CARD_D50_UM.fine_sand;

  if (input.settleTest) {
    const { clearedWithinMinutes, observedForHours } = input.settleTest;
    const rapidClear = typeof clearedWithinMinutes === "number" && clearedWithinMinutes <= RAPID_CLEAR_MINUTES;
    const persistentHaze = clearedWithinMinutes === null && typeof observedForHours === "number" && observedForHours >= PERSISTENT_HAZE_HOURS;

    if (rapidClear && coarseCard) {
      reasoning.push(
        `The settle test agrees: it cleared within ${clearedWithinMinutes} minutes, consistent with the grain card's coarser read. Two independent field observations pointing the same way - confidence raised from "field-adjusted" to "measured".`,
      );
      psd = { ...psd, status: "measured" };
    } else if (persistentHaze && !coarseCard) {
      reasoning.push(
        `The settle test agrees: it was still hazy after ${observedForHours} hours, consistent with the grain card's finer read. Two independent field observations pointing the same way - confidence raised from "field-adjusted" to "measured".`,
      );
      psd = { ...psd, status: "measured" };
    } else if (rapidClear && !coarseCard) {
      reasoning.push(
        `The settle test does NOT agree with the grain card: it cleared within ${clearedWithinMinutes} minutes (a coarse signal) but the grain card read ${GRAIN_CARD_LABEL[input.grainCardClass]} (a finer class). Keeping the grain card's read, since it is the more direct size observation, but this disagreement is worth a repeat test rather than trusting either reading alone.`,
      );
    } else if (persistentHaze && coarseCard) {
      reasoning.push(
        `The settle test does NOT agree with the grain card: it was still hazy after ${observedForHours} hours (a fine signal) but the grain card read ${GRAIN_CARD_LABEL[input.grainCardClass]} (a coarser class). Keeping the grain card's read, since it is the more direct size observation, but this disagreement is worth a repeat test rather than trusting either reading alone.`,
      );
    } else {
      reasoning.push("The settle test result given was inconclusive either way, so it neither corroborates nor contradicts the grain-card read.");
    }
  }

  return { psd, reasoning, additionalContext };
}
