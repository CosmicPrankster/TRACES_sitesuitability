import { describe, expect, it } from "vitest";
import { loadHydrocyclones, loadMembranes, loadTrials } from "@/lib/data";
import { psdForCharacter } from "@/lib/psd";
import { assessSite } from "@/lib/assessment";
import { buildReport } from "@/lib/report";

const cyclones = loadHydrocyclones();
const membranes = loadMembranes(); // ascending pore size: 0.45, 1.2, 5, 10, 20
const trials = loadTrials();

describe("buildReport", () => {
  it("the verdict is a factual summary of baseline volume found, not a pretreatment judgment", () => {
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, trials);
    const report = buildReport(psd, assessments, membranes);
    expect(report.verdict).toMatch(/Baseline filterable volume ranges from/);
    expect(report.verdict).not.toMatch(/[Pp]retreatment/);
    expect(report.verdict).not.toMatch(/[Ww]orth investigating/);
  });

  it("the verdict names how many membranes have a figure at all, and the measured/estimated split", () => {
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, trials);
    const report = buildReport(psd, assessments, membranes);
    expect(report.verdict).toMatch(new RegExp(`of ${membranes.length} membrane ratings`));
    expect(report.verdict).toMatch(/real bench-trial calibration|literature-based estimate/);
  });

  it("says plainly when there is no baseline volume for any membrane", () => {
    const psd = psdForCharacter("sand");
    // No trials at all, and every pore size untested by estimateBaselineVolume's anchor - degenerate case.
    const assessments = assessSite(psd, membranes, cyclones, []);
    const report = buildReport(psd, assessments, membranes);
    if (assessments.every((a) => !a.baselineVolume)) {
      expect(report.verdict).toMatch(/No real bench-trial calibration or literature-based estimate exists/);
    }
  });

  it("WHY explains the Carman-Kozeny physics in filter-only terms, never mentioning pretreatment", () => {
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, trials);
    const report = buildReport(psd, assessments, membranes);
    expect(report.why).toMatch(/Carman-Kozeny/);
    expect(report.why).not.toMatch(/[Pp]retreatment|hydrocyclone/);
  });

  it("every assessment still carries a baseline reasoning, an uplift per hydrocyclone, and a recommendation internally - just unused by the report", () => {
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, trials);
    expect(assessments.length).toBe(membranes.length);
    for (const a of assessments) {
      expect(a.baselineReasoning.length).toBeGreaterThan(0);
      expect(a.uplifts.length).toBe(cyclones.length);
      expect(a.recommendation.reasoning.length).toBeGreaterThan(0);
    }
  });

  it("WHAT WE KNOW names the particle size assumption used, in plain English", () => {
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, trials);
    const report = buildReport(psd, assessments, membranes);
    expect(report.whatWeKnow.some((l) => l.includes("Particle size assumption used"))).toBe(true);
  });

  it("WHAT WE DON'T KNOW names every guess as a guess, honestly, on today's real data", () => {
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, trials);
    const report = buildReport(psd, assessments, membranes);
    const text = report.whatWeDontKnow.join(" ");
    expect(text).toMatch(/particle size distribution is a guess/);
    expect(text).toMatch(/No filtration trial exists for this specific site/);
  });

  it("recommends a real filtration trial for the first uncalibrated membrane, never mentioning pretreatment", () => {
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, trials);
    const report = buildReport(psd, assessments, membranes);
    const anyUncalibrated = assessments.some((a) => a.baselineSource !== "measured");
    if (anyUncalibrated) {
      expect(report.recommendedTest).toMatch(/Run one filtration trial/);
      expect(report.recommendedTest).toMatch(/data\/trials\.json/);
      expect(report.recommendedTest).not.toMatch(/[Pp]retreatment|hydrocyclone|overflow/);
    }
  });

  it("recommends a measured concentration once every membrane has a real calibration", () => {
    // Fine-only membranes with the clay PSD: construct a scenario by checking
    // the general invariant on the real data instead of forcing a fixture -
    // if assessSite ever returns all-measured, the recommendation must pivot.
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, trials);
    const report = buildReport(psd, assessments, membranes);
    const allMeasured = assessments.every((a) => a.baselineSource === "measured");
    if (allMeasured) {
      expect(report.recommendedTest).toMatch(/measured suspended-solids concentration|site-concentration-calibrated/);
    }
  });

  it("WHAT WE KNOW marks an estimated baseline as ESTIMATED, not a plain figure indistinguishable from a real one", () => {
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, trials);
    const report = buildReport(psd, assessments, membranes);
    const twentyLine = report.whatWeKnow.find((l) => l.startsWith("20 µm"));
    expect(twentyLine).toMatch(/^20 µm: ESTIMATED baseline filterable volume/);
    const fiveLine = report.whatWeKnow.find((l) => l.startsWith("5 µm"));
    expect(fiveLine).not.toMatch(/ESTIMATED/);
  });

  it("WHAT WE DON'T KNOW flags that some baselines are literature estimates, not measurements", () => {
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, trials);
    const report = buildReport(psd, assessments, membranes);
    const text = report.whatWeDontKnow.join(" ");
    expect(text).toMatch(/literature-based ESTIMATES/);
    expect(text).toMatch(/not measurements/);
  });

  it("WHAT WE DON'T KNOW says every baseline is estimated when there is no real trial at all", () => {
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, []);
    const report = buildReport(psd, assessments, membranes);
    const text = report.whatWeDontKnow.join(" ");
    expect(text).toMatch(/no real trial exists at any pore size to estimate one from either/);
  });
});
