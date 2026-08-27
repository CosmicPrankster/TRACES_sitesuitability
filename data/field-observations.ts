import type { FieldObservation, ObservationFeed } from "@/types";

/**
 * FIELD OBSERVATIONS
 * ==================
 *
 * What you actually saw at a site. This is the highest-grade evidence the
 * application holds: everything else is a catalogue value, an open-data lookup
 * or an assumption, whereas these are things that happened.
 *
 * They feed straight into the assessment. An observation can raise the
 * confidence of a configuration, change the solids character used, and add its
 * own line of reasoning to the cells it bears on.
 *
 * ---------------------------------------------------------------------------
 * HOW TO ADD ONE
 * ---------------------------------------------------------------------------
 * Copy an entry, change the fields, done. Nothing else in the application
 * changes. The two fields that matter most:
 *
 *   `feed`  - what the unit was actually fed. This governs how much weight the
 *             engine gives the observation. Be honest here; it is the
 *             difference between a result that transfers to the real duty and
 *             one that does not.
 *
 *   `doesNotDemonstrate` - the limits of what you saw. Filling this in properly
 *             is what stops a good field result being over-read later, by you
 *             or by the AI. If you leave it empty the engine will say so.
 *
 * Do not record what you inferred - record what you observed. Put the inference
 * in `demonstrates`, where it is clearly labelled as a reading of the evidence.
 * ---------------------------------------------------------------------------
 */

/**
 * How much weight each kind of feed can carry. Used by the engine, and stated
 * in the report so the reasoning is auditable.
 */
export const FEED_WEIGHT: Record<
  ObservationFeed,
  { transfersToDuty: "high" | "partial" | "low"; caveat: string }
> = {
  natural_suspended_load: {
    transfersToDuty: "high",
    caveat:
      "Observed on the water as it normally runs, so it bears directly on the duty a plant " +
      "would actually see.",
  },
  disturbed_bed_sediment: {
    transfersToDuty: "partial",
    caveat:
      "Observed on deliberately disturbed bed material. That feed is far coarser and far more " +
      "concentrated than the naturally suspended load, and is close to the easiest duty a " +
      "hydrocyclone is ever given. It is real evidence that the unit separates, passes solids " +
      "and does not block at this site — but it does not establish behaviour on the fine " +
      "fraction that governs membrane loading in normal running.",
  },
  spiked_or_synthetic: {
    transfersToDuty: "partial",
    caveat:
      "Observed on a dosed or synthetic feed. Useful for characterising the unit, but the " +
      "particle population was chosen rather than encountered.",
  },
  unknown: {
    transfersToDuty: "low",
    caveat:
      "The feed is not recorded, so how far this transfers to the real duty cannot be judged. " +
      "Add the `feed` field to make this observation count for more.",
  },
};

export const fieldObservations: FieldObservation[] = [
  {
    id: "tilford-bed-sediment-separation",
    siteMatches: ["tilford"],
    siteName: "Tilford, River Wey",
    kind: "separation_confirmed",
    feed: "disturbed_bed_sediment",
    hydrocycloneIds: ["4mm", "10mm"],
    observation:
      "Riverbed sediment was deliberately disturbed upstream of the intake and the resulting " +
      "water was processed through the system. Physical separation was confirmed in both the " +
      "10 mm and the 4 mm hydrocyclone: solids reported to the underflow in both units.",
    demonstrates: [
      "Both the 4 mm and the 10 mm unit physically separate solids on water from this site — " +
        "they are not merely assumed to work here.",
      "Both units passed a coarse, high-concentration feed without blocking or bridging, which " +
        "is a real operability result and is often where small-diameter cyclones fail.",
      "The bed material at this reach contains a coarse fraction that these units can remove, " +
        "consistent with the sandy Lower Greensand geology of the reach.",
    ],
    doesNotDemonstrate: [
      "A cut size. Seeing separation does not tell you the size at which half the mass reports " +
        "to the underflow, so the catalogue cut sizes remain unverified placeholders.",
      "A separation efficiency, or how much of the feed solids was removed.",
      "Performance on the naturally suspended load, which is considerably finer than disturbed " +
        "bed material. The fine fraction is what governs membrane loading in normal running, and " +
        "this test did not put that fraction to the units.",
      "Any benefit to a downstream membrane, since no membrane was run against a control.",
    ],
    // The observation is about BED material. That is genuinely informative about
    // the mineral character of the reach, so it is recorded - but the suspended
    // load is finer, and the engine and report both say so.
    particleCharacter: "sand",
    provenance: "measured",
    confidence: "medium",
    notes: [
      "Recorded from the operator's account of the trial. Confidence is medium rather than high " +
        "because the observation is qualitative: no sample was sized, no split was measured and " +
        "no control was run.",
      "The single highest-value follow-up is to repeat this on undisturbed water and size both " +
        "the feed and the overflow. That would convert this from 'it separates' into a cut size.",
    ],
  },
];

/** Observations matching a free-text site query. */
export function findFieldObservations(query: string): FieldObservation[] {
  const q = query.toLowerCase();
  return fieldObservations.filter((o) => o.siteMatches.some((m) => q.includes(m)));
}

/*
 * ---------------------------------------------------------------------------
 * TEMPLATE - copy, change, and delete the fields you have nothing for.
 * ---------------------------------------------------------------------------
 *
 * {
 *   id: "somewhere-2026-04-trial",
 *   siteMatches: ["somewhere", "river whatever"],
 *   siteName: "Somewhere, River Whatever",
 *   date: "2026-04-18",
 *   observer: "VS",
 *   kind: "separation_confirmed",   // or no_separation | blockage | hydraulic |
 *                                   //    solids_character | membrane_behaviour | other
 *   feed: "natural_suspended_load", // or disturbed_bed_sediment | spiked_or_synthetic | unknown
 *   hydrocycloneIds: ["10mm"],
 *   membraneIds: ["20um"],
 *   observation: "What you actually saw, in your own words.",
 *   demonstrates: ["What this genuinely establishes."],
 *   doesNotDemonstrate: ["What it does not establish. Be strict with yourself here."],
 *   particleCharacter: "sand",      // only if the observation really tells you this
 *   provenance: "measured",
 *   confidence: "medium",
 *   evidenceRef: "photo IMG_2231; sample jar 4",
 * },
 */
