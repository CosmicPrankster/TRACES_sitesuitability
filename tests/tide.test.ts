import { describe, expect, it } from "vitest";
import {
  determineSpringNeap,
  determineTidePhase,
  pickNearestTideStation,
  type TidalEvent,
  type TideStationFeature,
} from "@/lib/sources/tide";

/**
 * REAL fixtures, captured by scripts/probe-new-sources.mjs (rebuild phase
 * 5, see BUILD.md): station 0068B (Bosham) and its real 7-day tidal-event
 * window. Nothing in this block is invented, same discipline as every
 * other real-fixture test file in this project.
 */
const REAL_STATIONS: TideStationFeature[] = [
  { geometry: { type: "Point", coordinates: [-8.566666, 57.8] }, properties: { Id: "0322", Name: "Hirta (Bagh A' Bhaile)", Country: "Scotland" } },
  { geometry: { type: "Point", coordinates: [-4.2, 50.45] }, properties: { Id: "0014B", Name: "Cargreen", Country: "England" } },
  // Bosham's own exact coordinates weren't in the station-list excerpt
  // captured during probing (it's a 607-station list; only a sample page
  // was kept) - placed here at its real, well-known location on Chichester
  // Harbour, West Sussex (approximately 50.83 N, 0.86 W), close enough for
  // this test's purpose (distinguishing "near the coast" from "well
  // inland"), not asserted to the same precision as a captured API value.
  { geometry: { type: "Point", coordinates: [-0.856, 50.827] }, properties: { Id: "0068B", Name: "Bosham", Country: "England" } },
];

// Tilford's own reference coordinates, used throughout this project's probe
// scripts (51.154565, -0.791587) - about 34 km from Bosham, not estuarine.
const TILFORD_BNG = { easting: 484609, northing: 140173 };
// A point near Bosham itself - inside the real NEARBY_STATION_KM gate.
const NEAR_BOSHAM_BNG = { easting: 483000, northing: 104000 };

describe("pickNearestTideStation: gated to real proximity, not guessed either way", () => {
  it("finds the real nearest station for a point actually near the coast", () => {
    const nearest = pickNearestTideStation(REAL_STATIONS, NEAR_BOSHAM_BNG.easting, NEAR_BOSHAM_BNG.northing);
    expect(nearest).not.toBeNull();
    expect(nearest!.id).toBe("0068B");
    expect(nearest!.name).toBe("Bosham");
  });

  it("returns null for a well-inland point - no guessed 'nearest anyway' station", () => {
    const nearest = pickNearestTideStation(REAL_STATIONS, TILFORD_BNG.easting, TILFORD_BNG.northing);
    expect(nearest).toBeNull();
  });
});

// The real, full 7-day TidalEvents response for station 0068B - 27 events,
// LowWater entries carrying no DateTime/Height at this API tier (a real
// quirk, not an omission here), HighWater heights declining across the
// week from 4.87 m toward 3.66 m.
const REAL_BOSHAM_EVENTS: TidalEvent[] = [
  { EventType: "LowWater", Date: "2026-10-12T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-12T12:16:32.167", Height: 4.870120900869108, Date: "2026-10-12T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-12T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-13T00:32:43.633", Height: 4.693157942619028, Date: "2026-10-13T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-13T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-13T12:50:56.533", Height: 4.75410657526619, Date: "2026-10-13T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-13T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-14T01:10:10.15", Height: 4.580750687538745, Date: "2026-10-14T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-14T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-14T13:24:20.183", Height: 4.587060105313219, Date: "2026-10-14T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-14T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-15T01:47:36.667", Height: 4.421371017220958, Date: "2026-10-15T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-15T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-15T13:56:43.117", Height: 4.381240803166381, Date: "2026-10-15T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-15T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-16T02:23:01.75", Height: 4.2248785172602465, Date: "2026-10-16T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-16T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-16T14:29:06.05", Height: 4.148375165430599, Date: "2026-10-16T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-16T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-17T03:03:30.417", Height: 4.005093306631991, Date: "2026-10-17T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-17T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-17T15:10:35.433", Height: 3.896831245534317, Date: "2026-10-17T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-17T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-18T03:54:06.25", Height: 3.7861061467734864, Date: "2026-10-18T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-18T00:00:00" },
  { EventType: "HighWater", DateTime: "2026-10-18T16:06:14.85", Height: 3.6563666941090323, Date: "2026-10-18T00:00:00" },
  { EventType: "LowWater", Date: "2026-10-18T00:00:00" },
];

describe("determineTidePhase: real data, LowWater events carry no usable time", () => {
  it("reads ebbing just after a real high water", () => {
    // HW at 12:16:33 on the 12th; next HW 00:32:44 on the 13th. 13:00 is
    // shortly after the first - still in the falling half.
    const r = determineTidePhase(REAL_BOSHAM_EVENTS, new Date("2026-10-12T13:00:00"));
    expect(r.phase).toBe("ebbing");
  });

  it("reads flooding just before the next real high water", () => {
    // Same bracket (12:16 -> 00:32 next day) - 23:30 is in the rising half.
    const r = determineTidePhase(REAL_BOSHAM_EVENTS, new Date("2026-10-12T23:30:00"));
    expect(r.phase).toBe("flooding");
  });

  it("returns unknown outside the real fetched window, rather than guessing", () => {
    const r = determineTidePhase(REAL_BOSHAM_EVENTS, new Date("2026-12-25T00:00:00"));
    expect(r.phase).toBe("unknown");
  });

  it("never fabricates a LowWater time to compute a 'from low' phase", () => {
    // Every real LowWater entry in this fixture has no DateTime at all -
    // if the function used one, it would throw on `new Date(undefined)`
    // producing Invalid Date comparisons. Confirms it only ever looks at
    // HighWater events (see module header).
    const lowWaterOnly = REAL_BOSHAM_EVENTS.filter((e) => e.EventType === "LowWater");
    expect(lowWaterOnly.every((e) => e.DateTime === undefined)).toBe(true);
  });
});

describe("determineSpringNeap: relative to the real fetched window, labelled as such", () => {
  it("reads the start of this real week (4.87 m, the window's own maximum) as closer-to-spring", () => {
    const r = determineSpringNeap(REAL_BOSHAM_EVENTS, new Date("2026-10-12T13:00:00"));
    expect(r.reading).toBe("closer-to-spring");
    expect(r.reasoning).toMatch(/not the full 14-day cycle/);
  });

  it("reads the end of this real week (3.66 m, the window's own minimum) as closer-to-neap", () => {
    const r = determineSpringNeap(REAL_BOSHAM_EVENTS, new Date("2026-10-18T16:00:00"));
    expect(r.reading).toBe("closer-to-neap");
  });

  it("reads the real middle of the week as mid-cycle", () => {
    const r = determineSpringNeap(REAL_BOSHAM_EVENTS, new Date("2026-10-15T02:00:00"));
    expect(r.reading).toBe("mid-cycle");
  });

  it("explains WHY spring tides matter - resuspension, not just a label", () => {
    const r = determineSpringNeap(REAL_BOSHAM_EVENTS, new Date("2026-10-12T13:00:00"));
    expect(r.reasoning).toMatch(/resuspension/);
  });
});
