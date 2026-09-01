import { describe, expect, it } from "vitest";
import type { Trial } from "@/lib/data";
import { loadTrials } from "@/lib/data";
import { findSiteTrial, measuredVolumeRatio } from "@/lib/trials";

// A synthetic recorded trial, built in-memory - not written to
// data/trials.json, which holds only genuine field data. This is the shape
// the README describes: 50 mL before, 75 mL after -> ratio 1.5.
function recordedTrial(overrides: Partial<Trial> = {}): Trial {
  return {
    id: "synthetic-001",
    date: "2026-01-01",
    operator: "test",
    siteId: "tilford",
    waterbodyId: "river-wey-tilford",
    hydrocycloneId: "4mm",
    feed: {
      material: "River water",
      preparation: "As drawn, no preparation",
      concentrationMgL: null,
      psdMeasured: false,
      note: "",
    },
    filter: { poreSizeUm: 5, diameterMm: 47, material: "membrane" },
    terminalCondition: "Filtered to visible cake formation on the membrane surface.",
    volumeBeforeMl: 50,
    volumeAfterMl: 75,
    replicates: 3,
    status: "recorded",
    notes: [],
    ...overrides,
  };
}

describe("measuredVolumeRatio", () => {
  it("computes the ratio the README describes: 50 mL -> 75 mL is 1.5x", () => {
    expect(measuredVolumeRatio(recordedTrial())).toBeCloseTo(1.5, 9);
  });

  it("returns null for a trial still awaiting data", () => {
    const t = recordedTrial({ status: "awaiting-data", volumeBeforeMl: null, volumeAfterMl: null });
    expect(measuredVolumeRatio(t)).toBeNull();
  });

  it("returns null if either volume is missing, even when marked recorded", () => {
    expect(measuredVolumeRatio(recordedTrial({ volumeAfterMl: null }))).toBeNull();
    expect(measuredVolumeRatio(recordedTrial({ volumeBeforeMl: null }))).toBeNull();
  });

  it("today's real placeholder trial yields no ratio - honestly insufficient data", () => {
    const [placeholder] = loadTrials();
    expect(measuredVolumeRatio(placeholder)).toBeNull();
  });
});

describe("findSiteTrial", () => {
  const trial = recordedTrial();

  it("finds a recorded trial matching hydrocyclone, site and waterbody exactly", () => {
    const found = findSiteTrial([trial], "4mm", "tilford", "river-wey-tilford");
    expect(found?.id).toBe("synthetic-001");
  });

  it("does not match a different hydrocyclone", () => {
    expect(findSiteTrial([trial], "10mm", "tilford", "river-wey-tilford")).toBeUndefined();
  });

  it("does not match a different site, even with the same hydrocyclone", () => {
    expect(findSiteTrial([trial], "4mm", "some-other-site", "river-wey-tilford")).toBeUndefined();
  });

  it("does not match a different waterbody at the same site", () => {
    // Two spellings of one burn are one site, but two different waterbodies
    // at one site are genuinely different - a trial on one river is not
    // evidence for another that happens to run through the same town.
    expect(findSiteTrial([trial], "4mm", "tilford", "some-other-waterbody")).toBeUndefined();
  });

  it("ignores a matching trial that is still awaiting data", () => {
    const pending = recordedTrial({ status: "awaiting-data", volumeBeforeMl: null, volumeAfterMl: null });
    expect(findSiteTrial([pending], "4mm", "tilford", "river-wey-tilford")).toBeUndefined();
  });

  it("finds nothing at all against today's real trials.json", () => {
    expect(findSiteTrial(loadTrials(), "4mm", "tilford", "river-wey-tilford")).toBeUndefined();
  });
});
