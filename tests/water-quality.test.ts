import { describe, expect, it } from "vitest";
import {
  classifyReadings,
  pickNearbyRiverPoints,
  toReading,
  type ObservationRecord,
  type SamplingPointFeature,
  type WaterQualityReading,
} from "@/lib/sources/water-quality";

/**
 * REAL fixtures, captured by scripts/probe-new-sources.mjs against the
 * Tilford reference site (rebuild phase 3, see BUILD.md) - coordinates,
 * notations, names and types copied verbatim from the actual response.
 * Nothing in this block is invented, same discipline as character.ts's
 * real NRFA fixtures.
 */
const REAL_SEARCH_RESULTS: SamplingPointFeature[] = [
  {
    geometry: { type: "Point", coordinates: [-1.043122097, 51.021761551] },
    properties: { name: "OLD DOWN FARM, EAST MEON, PRIVETT, ALTON", status: "OPEN", type: "GROUNDWATER - BOREHOLE", notation: "SO-5GWQ0393" },
  },
  {
    geometry: { type: "Point", coordinates: [-0.906158685, 51.000542525] },
    properties: { name: "PETERSFIELD WWTW INLET UWWTD CUSTOMER SELF MONITORING DATA", status: "OPEN", type: "SEWAGE - CRUDE TO FURTHER TREATMENT - WATER COMPANY", notation: "SO-CSM00057" },
  },
  {
    geometry: { type: "Point", coordinates: [-0.639035653, 50.972826335] },
    properties: { name: "PERRYFIELDS,RIVER ROTHER, PROPERTY D/S SOUTH AMBERSHAM STW", status: "OPEN", type: "FRESHWATER - UNSPECIFIED", notation: "SO-F0002057" },
  },
  {
    geometry: { type: "Point", coordinates: [-0.462614798, 51.074507191] },
    properties: { name: "DOWNSTREAM RUDGWICK STW,RIVER ARUN", status: "OPEN", type: "FRESHWATER - UNSPECIFIED", notation: "SO-F0002329" },
  },
];

describe("pickNearbyRiverPoints: real search results, not every sampling point is a river", () => {
  // Anchor near SO-F0002057's own real BNG position (easting 495650,
  // northing 120150, from a real observation record's geometry) - distance
  // ranking exercised against real relative positions, not invented ones.
  const picked = pickNearbyRiverPoints(REAL_SEARCH_RESULTS, 495650, 120150);

  it("keeps only the real ambient freshwater points, excluding groundwater and sewage", () => {
    const notations = picked.map((p) => p.notation);
    expect(notations).toEqual(["SO-F0002057", "SO-F0002329"]);
  });

  it("ranks the real nearer river point first", () => {
    // SO-F0002057 is the point these coordinates are anchored on; SO-F0002329
    // (Rudgwick, River Arun) is real but much further away.
    expect(picked[0].notation).toBe("SO-F0002057");
    expect(picked[0].distanceKm).toBeLessThan(picked[1].distanceKm);
  });

  it("returns the real, human-readable name alongside the notation", () => {
    const perryfields = picked.find((p) => p.notation === "SO-F0002057")!;
    expect(perryfields.name).toMatch(/RIVER ROTHER/);
  });
});

describe("pickNearbyRiverPoints: the second real freshwater type code", () => {
  // No real search result near Tilford happened to use this type code, but
  // the codelist fetch (BUILD.md, rebuild phase 3) confirmed it's real and
  // live ("F6", prefLabel "FRESHWATER - RIVERS") - this is a synthetic
  // point built from that real code, not a captured response.
  const syntheticRiversTypePoint: SamplingPointFeature = {
    geometry: { type: "Point", coordinates: [-0.639035653, 50.972826335] },
    properties: { name: "SYNTHETIC - exercises the real but unobserved FRESHWATER - RIVERS code", status: "OPEN", type: "FRESHWATER - RIVERS", notation: "SYNTHETIC-F6" },
  };

  it("accepts the real FRESHWATER - RIVERS type code, not just FRESHWATER - UNSPECIFIED", () => {
    const picked = pickNearbyRiverPoints([syntheticRiversTypePoint], 495650, 120150);
    expect(picked.map((p) => p.notation)).toContain("SYNTHETIC-F6");
  });
});

// A real pH observation record, captured from SO-F0002057's own observation
// history (rebuild phase 3 probe) - this project's one real example of the
// full record shape, including the censored-result case below.
const REAL_PH_OBSERVATION: ObservationRecord = {
  phenomenonTime: "2002-03-13T10:37:00",
  observedProperty: { notation: "0061", prefLabel: "pH" },
  hasResult: { numericValue: 7.47, upperBound: null, lowerBound: null, hasUnit: { prefLabel: "PH UNITS" } },
};

// Same real sampling run, BOD came back as a "less than" result - a real
// censored value, not a clean point number.
const REAL_CENSORED_BOD_OBSERVATION: ObservationRecord = {
  phenomenonTime: "2002-03-13T10:37:00",
  observedProperty: { notation: "0085", prefLabel: "BOD : 5 Day ATU" },
  hasResult: { numericValue: null, upperBound: 3, lowerBound: null, hasUnit: { prefLabel: "MILLIGRAM PER LITRE" } },
};

describe("toReading: the real observation record shape", () => {
  it("maps a real point-value reading", () => {
    const r = toReading(REAL_PH_OBSERVATION)!;
    expect(r.determinandNotation).toBe("0061");
    expect(r.determinandLabel).toBe("pH");
    expect(r.date).toBe("2002-03-13T10:37:00");
    expect(r.value).toBe(7.47);
    expect(r.censored).toBeNull();
    expect(r.unit).toBe("PH UNITS");
  });

  it("maps a real censored ('less than') result honestly - null value, not a guessed number", () => {
    const r = toReading(REAL_CENSORED_BOD_OBSERVATION)!;
    expect(r.value).toBeNull();
    expect(r.censored).toEqual({ bound: "upper", value: 3 });
  });

  it("refuses a record with no date or no determinand, rather than fabricating one", () => {
    expect(toReading({ observedProperty: { notation: "0061", prefLabel: "pH" } })).toBeNull();
    expect(toReading({ phenomenonTime: "2002-01-01T00:00:00" })).toBeNull();
  });
});

/**
 * SYNTHETIC readings below. No real observation captured during probing
 * happened to be a turbidity or suspended-solids reading (the one real
 * record fetched was an unfiltered first page - pH, conductivity,
 * temperature, BOD, nutrients, hardness - see BUILD.md). Each fixture's
 * determinand NOTATION and LABEL are real, confirmed codes (the turbidity
 * determinand codelist fetch, rebuild phase 3); only the specific reading
 * VALUES and dates are made up, to exercise the classification logic
 * against the real vocabulary.
 */
describe("classifyReadings: turbidity is not a suspended-solids concentration", () => {
  const turbidityReading: WaterQualityReading = {
    determinandNotation: "0068", // real: "Turbidity"
    determinandLabel: "Turbidity",
    date: "2020-06-01T09:00:00",
    value: 12.4,
    censored: null,
    unit: "FORMAZIN NEPHELOMETRIC UNIT",
  };
  const suspendedSolidsReading: WaterQualityReading = {
    determinandNotation: "9999", // no real gravimetric SS code confirmed yet - see BUILD.md
    determinandLabel: "Solids, Suspended at 105 C",
    date: "2020-06-01T09:00:00",
    value: 18,
    censored: null,
    unit: "MILLIGRAM PER LITRE",
  };
  const opticalSuspendedSolidsEstimate: WaterQualityReading = {
    determinandNotation: "7064", // real: "Solids, Suspended, (Optical Turbidity)"
    determinandLabel: "Solids, Suspended, (Optical Turbidity)",
    date: "2020-06-01T09:00:00",
    value: 15,
    censored: null,
    unit: "FORMAZIN NEPHELOMETRIC UNIT",
  };
  const phReading: WaterQualityReading = {
    determinandNotation: "0061", // real: "pH" (same code as the real fixture above)
    determinandLabel: "pH",
    date: "2020-06-01T09:00:00",
    value: 7.5,
    censored: null,
    unit: "PH UNITS",
  };

  const classified = classifyReadings([turbidityReading, suspendedSolidsReading, opticalSuspendedSolidsEstimate, phReading]);

  it("puts the real turbidity determinand in the turbidity list", () => {
    expect(classified.turbidity.map((r) => r.determinandNotation)).toContain("0068");
  });

  it("puts a gravimetric mg/L suspended-solids reading in its own list", () => {
    expect(classified.suspendedSolidsMgL.map((r) => r.determinandNotation)).toContain("9999");
  });

  it("does NOT put the real optical (non-mg/L) suspended-solids estimate in the concentration list - wrong unit for lib/baseline.ts", () => {
    expect(classified.suspendedSolidsMgL.map((r) => r.determinandNotation)).not.toContain("7064");
  });

  it("leaves an unrelated determinand (pH) out of both lists", () => {
    expect(classified.turbidity.map((r) => r.determinandNotation)).not.toContain("0061");
    expect(classified.suspendedSolidsMgL.map((r) => r.determinandNotation)).not.toContain("0061");
  });

  it("sorts newest first", () => {
    const older: WaterQualityReading = { ...turbidityReading, date: "2019-01-01T00:00:00" };
    const newer: WaterQualityReading = { ...turbidityReading, date: "2021-01-01T00:00:00" };
    const result = classifyReadings([older, newer]);
    expect(result.turbidity[0].date).toBe("2021-01-01T00:00:00");
  });
});
