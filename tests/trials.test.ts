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
    hydrocycloneIds: ["4mm"],
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

  it("computes real ratios from the recorded Oct24-Nov10 bench trials", () => {
    const bench = loadTrials().find((t) => t.id === "aquarium-soil-bench-001")!;
    // 1963.333 / 457.333 mL, from the real 10mm-alone bench data.
    expect(measuredVolumeRatio(bench)).toBeCloseTo(4.293, 2);
  });

  it("the 10mm+10mm cascade measures a bigger ratio than 10mm alone, same feed", () => {
    const trials = loadTrials();
    const single = trials.find((t) => t.id === "aquarium-soil-bench-001")!;
    const cascade = trials.find((t) => t.id === "oct24nov10-10mm-cascade-0p5gL")!;
    expect(measuredVolumeRatio(cascade)!).toBeGreaterThan(measuredVolumeRatio(single)!);
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

  it("does not attribute a cascade trial's ratio to either unit alone", () => {
    // A ["4mm", "4mm"] cascade measures the two-stage system, not one 4mm
    // run by itself - attributing it to "4mm" alone would overstate what
    // was actually measured.
    const cascade = recordedTrial({ id: "cascade-001", hydrocycloneIds: ["4mm", "4mm"] });
    expect(findSiteTrial([cascade], "4mm", "tilford", "river-wey-tilford")).toBeUndefined();
  });

  it("finds nothing at all against today's real trials.json", () => {
    expect(findSiteTrial(loadTrials(), "4mm", "tilford", "river-wey-tilford")).toBeUndefined();
  });
});
