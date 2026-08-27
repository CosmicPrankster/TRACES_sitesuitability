import type { Hydrocyclone } from "@/types";

/**
 * HYDROCYCLONE CATALOGUE
 * ======================
 *
 * This file is the single place where equipment knowledge lives. The screening
 * engine contains no equipment-specific branching: adding a 6 mm, 8 mm, 15 mm
 * or 20 mm unit is done by appending an entry here and nothing else.
 *
 * -------------------------------------------------------------------------
 * DATA HONESTY RULES - please read before editing
 * -------------------------------------------------------------------------
 * 1. Never enter a number you have not read in a manufacturer datasheet, a
 *    paper, or your own measurement.
 * 2. Every `Evidence` field carries `provenance`, `source` and `verified`.
 *    Set `verified: true` ONLY once a human has checked the value against the
 *    cited source.
 * 3. Fields you do not know should be OMITTED, not guessed. The engine copes
 *    with missing data and says so in the report.
 * 4. `cutSize.d50Um` entries below are marked `provenance: "assumed"` and
 *    `verified: false`. They are SCREENING PLACEHOLDERS, not equipment data.
 *    While any placeholder is in use the report caps its confidence at "low"
 *    and prints a warning. Replacing a placeholder with a sourced value is the
 *    single highest-value improvement you can make to this application.
 * -------------------------------------------------------------------------
 */

/**
 * Set to `true` once every entry below has `dataComplete: true`. Used only for
 * the README/status banner.
 */
export const CATALOGUE_HAS_UNVERIFIED_PERFORMANCE_DATA = true;

const PLACEHOLDER_SOURCE =
  "SCREENING PLACEHOLDER - not manufacturer, experimental or published data. " +
  "Chosen only so the matrix can be produced; replace with a sourced value.";

const PLACEHOLDER_BASIS =
  "The only relationship relied on here is the well-established qualitative one " +
  "that, for geometrically similar hydrocyclones under comparable conditions, " +
  "cut size increases with body diameter. The absolute values are NOT evidence.";

export const hydrocyclones: Hydrocyclone[] = [
  {
    id: "4mm",
    name: "4 mm Hydrocyclone",
    diameterMm: {
      value: 4,
      unit: "mm",
      provenance: "published",
      confidence: "high",
      source: "Nominal designation of the unit under investigation.",
      verified: true,
      notes: "Nominal body diameter. Defines the unit; not a performance claim.",
    },
    // geometry: not yet characterised. Add inletDiameterMm, vortexFinderDiameterMm,
    // apexDiameterMm, coneAngleDeg and geometryFamily as they are measured.
    // operating: not yet characterised. Add flowMinLpm/flowMaxLpm and
    // pressureMinBar/pressureMaxBar from the datasheet or rig measurements.
    cutSize: {
      d50Um: {
        value: 8,
        unit: "µm",
        provenance: "assumed",
        confidence: "low",
        source: PLACEHOLDER_SOURCE,
        verified: false,
        notes: PLACEHOLDER_BASIS,
      },
      sharpness: {
        value: 2.5,
        provenance: "assumed",
        confidence: "low",
        source: PLACEHOLDER_SOURCE,
        verified: false,
        notes:
          "Sharpness exponent m of the reduced grade-efficiency curve " +
          "G'(d) = (d/d50)^m / (1 + (d/d50)^m). m = 2.5 is a mid-range value " +
          "for a moderately sharp cut; it is a modelling choice, not a measurement.",
      },
      // waterSplitRf: unknown. The engine therefore assumes zero fines
      // short-circuit, which is conservative for fine-particle removal.
    },
    references: [],
    notes: [
      "Performance data not yet populated. Cut size and sharpness are screening placeholders.",
      "Priority measurements: grade-efficiency curve at the intended duty, operating flow range, pressure drop, and water split Rf.",
    ],
    catalogueConfidence: "low",
    dataComplete: false,
  },
  {
    id: "10mm",
    name: "10 mm Hydrocyclone",
    diameterMm: {
      value: 10,
      unit: "mm",
      provenance: "published",
      confidence: "high",
      source: "Nominal designation of the unit under investigation.",
      verified: true,
      notes: "Nominal body diameter. Defines the unit; not a performance claim.",
    },
    cutSize: {
      d50Um: {
        value: 15,
        unit: "µm",
        provenance: "assumed",
        confidence: "low",
        source: PLACEHOLDER_SOURCE,
        verified: false,
        notes: PLACEHOLDER_BASIS,
      },
      sharpness: {
        value: 2.5,
        provenance: "assumed",
        confidence: "low",
        source: PLACEHOLDER_SOURCE,
        verified: false,
        notes:
          "Sharpness exponent m of the reduced grade-efficiency curve. " +
          "A modelling choice, not a measurement.",
      },
    },
    references: [],
    notes: [
      "Performance data not yet populated. Cut size and sharpness are screening placeholders.",
      "Priority measurements: grade-efficiency curve at the intended duty, operating flow range, pressure drop, and water split Rf.",
    ],
    catalogueConfidence: "low",
    dataComplete: false,
  },
];

/*
 * ---------------------------------------------------------------------------
 * TEMPLATE - copy, rename, and fill in only what you can source.
 * ---------------------------------------------------------------------------
 *
 * {
 *   id: "15mm",
 *   name: "15 mm Hydrocyclone",
 *   manufacturer: "...",
 *   model: "...",
 *   diameterMm: { value: 15, unit: "mm", provenance: "published",
 *                 confidence: "high", source: "Datasheet rev 3, p.2",
 *                 sourceUrl: "https://...", verified: true },
 *   geometry: {
 *     inletDiameterMm: { value: 3.5, unit: "mm", provenance: "published",
 *                        confidence: "high", source: "Datasheet", verified: true },
 *     geometryFamily:  { value: "Rietema", provenance: "published",
 *                        confidence: "medium", source: "...", verified: true },
 *   },
 *   operating: {
 *     flowMinLpm: { value: 5, unit: "L/min", provenance: "published",
 *                   confidence: "high", source: "Datasheet", verified: true },
 *     flowMaxLpm: { value: 20, unit: "L/min", provenance: "published",
 *                   confidence: "high", source: "Datasheet", verified: true },
 *   },
 *   cutSize: {
 *     d50Um: { value: 20, unit: "µm", provenance: "measured", confidence: "high",
 *              source: "Rig test 2026-03-14, silica in water",
 *              date: "2026-03-14", verified: true },
 *     gradeEfficiencyCurve: {
 *       value: [ { sizeUm: 5, efficiency: 0.08 }, { sizeUm: 20, efficiency: 0.5 } ],
 *       provenance: "measured", confidence: "high",
 *       source: "Rig test 2026-03-14", verified: true,
 *     },
 *     conditions: {
 *       particleDensityKgM3: { value: 2650, unit: "kg/m3", provenance: "published",
 *                              confidence: "high", source: "Silica", verified: true },
 *       description: "Silica flour in tap water at 20 C, 2 bar feed.",
 *     },
 *   },
 *   references: [{ title: "...", authors: "...", year: 2020, url: "https://..." }],
 *   catalogueConfidence: "high",
 *   dataComplete: true,
 * },
 */
