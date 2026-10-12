import { describe, expect, it } from "vitest";
import { psdFromFieldObservation } from "@/lib/field-update";

describe("psdFromFieldObservation: nothing size-relevant reported", () => {
  it("returns null for a turbidity-tube reading alone - no size shape to give", () => {
    expect(psdFromFieldObservation({ turbidityTubeReadingCm: 12 })).toBeNull();
  });

  it("returns null for a site note alone", () => {
    expect(psdFromFieldObservation({ siteNote: "water looked brown today" })).toBeNull();
  });

  it("returns null for an empty observation", () => {
    expect(psdFromFieldObservation({})).toBeNull();
  });
});

describe("psdFromFieldObservation: grain card alone", () => {
  it("gives a real PSD for a clay-class match, status field-adjusted", () => {
    const r = psdFromFieldObservation({ grainCardClass: "clay" })!;
    expect(r.psd.status).toBe("field-adjusted");
    expect(r.psd.d50Um).toBe(2);
    expect(r.psd.d10Um).toBeLessThan(r.psd.d50Um);
    expect(r.psd.d90Um).toBeGreaterThan(r.psd.d50Um);
  });

  it("the silt class lands close to this tool's own guessed silt profile (15 um) - a real cross-check", () => {
    const r = psdFromFieldObservation({ grainCardClass: "silt" })!;
    expect(r.psd.d50Um).toBeCloseTo(16, 0);
  });

  it("orders every class's d50 correctly, clay < silt < fine < medium < coarse sand", () => {
    const classes = ["clay", "silt", "fine_sand", "medium_sand", "coarse_sand"] as const;
    const d50s = classes.map((c) => psdFromFieldObservation({ grainCardClass: c })!.psd.d50Um);
    for (let i = 1; i < d50s.length; i++) expect(d50s[i]).toBeGreaterThan(d50s[i - 1]);
  });

  it("flags a gravel read as likely bed material, not suspended load - the project's own known trap", () => {
    const r = psdFromFieldObservation({ grainCardClass: "gravel" })!;
    expect(r.additionalContext.join(" ")).toMatch(/bed material/);
    expect(r.additionalContext.join(" ")).toMatch(/suspended load of a river is normally much finer/);
  });

  it("names the real field read in the reasoning, not a guess", () => {
    const r = psdFromFieldObservation({ grainCardClass: "coarse_sand" })!;
    expect(r.reasoning.join(" ")).toMatch(/real, direct observation/);
  });
});

describe("psdFromFieldObservation: settle test corroboration, same discipline as geology corroboration", () => {
  it("raises confidence to measured when a rapid clear agrees with a coarse grain-card read", () => {
    const r = psdFromFieldObservation({
      grainCardClass: "coarse_sand",
      settleTest: { clearedWithinMinutes: 5, observedForHours: null },
    })!;
    expect(r.psd.status).toBe("measured");
    expect(r.reasoning.join(" ")).toMatch(/agrees/);
    expect(r.reasoning.join(" ")).toMatch(/raised from "field-adjusted" to "measured"/);
  });

  it("raises confidence to measured when persistent haze agrees with a fine grain-card read", () => {
    const r = psdFromFieldObservation({
      grainCardClass: "clay",
      settleTest: { clearedWithinMinutes: null, observedForHours: 6 },
    })!;
    expect(r.psd.status).toBe("measured");
  });

  it("keeps field-adjusted and reports a disagreement plainly, rather than averaging it away", () => {
    const r = psdFromFieldObservation({
      grainCardClass: "clay", // fine
      settleTest: { clearedWithinMinutes: 5, observedForHours: null }, // coarse signal
    })!;
    expect(r.psd.status).toBe("field-adjusted"); // kept the grain-card read
    expect(r.psd.d50Um).toBe(2); // still the clay value, not averaged with a coarse one
    expect(r.reasoning.join(" ")).toMatch(/does NOT agree/);
    expect(r.reasoning.join(" ")).toMatch(/repeat test/);
  });

  it("reports the other disagreement direction too - coarse card, persistent haze", () => {
    const r = psdFromFieldObservation({
      grainCardClass: "coarse_sand",
      settleTest: { clearedWithinMinutes: null, observedForHours: 4 },
    })!;
    expect(r.psd.status).toBe("field-adjusted");
    expect(r.reasoning.join(" ")).toMatch(/does NOT agree/);
  });

  it("treats an inconclusive settle test as neither agreeing nor contradicting", () => {
    const r = psdFromFieldObservation({
      grainCardClass: "medium_sand",
      settleTest: { clearedWithinMinutes: null, observedForHours: null },
    })!;
    expect(r.psd.status).toBe("field-adjusted");
    expect(r.reasoning.join(" ")).toMatch(/inconclusive/);
  });
});

describe("psdFromFieldObservation: the turbidity tube is never scored on, only reported", () => {
  it("includes the raw reading as context without converting it to a number", () => {
    const r = psdFromFieldObservation({ grainCardClass: "silt", turbidityTubeReadingCm: 18 })!;
    expect(r.additionalContext.join(" ")).toMatch(/18 cm/);
    expect(r.additionalContext.join(" ")).toMatch(/not used in the particle-size estimate/);
  });

  it("never changes the computed PSD based on the tube reading", () => {
    const withTube = psdFromFieldObservation({ grainCardClass: "silt", turbidityTubeReadingCm: 2 })!;
    const withoutTube = psdFromFieldObservation({ grainCardClass: "silt" })!;
    expect(withTube.psd).toEqual(withoutTube.psd);
  });

  it("carries a free-text site note through as context, not as a scored input", () => {
    const r = psdFromFieldObservation({ grainCardClass: "silt", siteNote: "water smelled of sewage" })!;
    expect(r.additionalContext.join(" ")).toMatch(/water smelled of sewage/);
  });
});
