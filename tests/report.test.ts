import { describe, expect, it } from "vitest";
import { loadHydrocyclones, loadMembranes, loadTrials } from "@/lib/data";
import { psdForCharacter } from "@/lib/psd";
import { assessSite } from "@/lib/assessment";
import { buildReport, findUsefulWindow } from "@/lib/report";

const cyclones = loadHydrocyclones();
const membranes = loadMembranes(); // ascending pore size: 0.45, 1.2, 5, 10, 20
const trials = loadTrials();

describe("findUsefulWindow: the single most valuable output", () => {
  it("finds a contiguous coarse-membrane band for a sand site", () => {
    const assessments = assessSite(psdForCharacter("sand"), membranes, cyclones, trials);
    const window = findUsefulWindow(assessments, membranes);
    expect(window).not.toBeNull();
    expect(window!.fromPoreSizeUm).toBeLessThanOrEqual(window!.toPoreSizeUm);
    // Every membrane inside the window must actually recommend pretreatment.
    const byId = new Map(assessments.map((a) => [a.membraneId, a]));
    for (const id of window!.membraneIds) {
      expect(byId.get(id)!.recommendation.kind).toBe("pretreatment");
    }
  });

  it("returns null - not a fabricated window - when nothing qualifies", () => {
    const assessments = assessSite(psdForCharacter("clay"), membranes, cyclones, trials);
    const fineOnly = membranes.filter((m) => m.id === "0p45um" || m.id === "1p2um");
    const window = findUsefulWindow(assessments, fineOnly);
    expect(window).toBeNull();
  });

  it("never includes a membrane whose recommendation is not actually pretreatment", () => {
    const assessments = assessSite(psdForCharacter("clay"), membranes, cyclones, trials);
    const window = findUsefulWindow(assessments, membranes);
    const covered = new Set(window?.membraneIds ?? []);
    for (const a of assessments) {
      if (covered.has(a.membraneId)) {
        expect(a.recommendation.kind).toBe("pretreatment");
      }
    }
  });
});

describe("buildReport", () => {
  it("headlines the useful window in plain English when one exists", () => {
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, trials);
    const report = buildReport(psd, assessments, membranes);
    if (report.usefulWindow) {
      expect(report.verdict).toMatch(/Pretreatment looks worthwhile/);
    }
  });

  it("every assessment carries a baseline reasoning, an uplift per hydrocyclone, and a recommendation", () => {
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

  it("recommends a real filtration trial when something recommends pretreatment", () => {
    const psd = psdForCharacter("sand");
    const assessments = assessSite(psd, membranes, cyclones, trials);
    const report = buildReport(psd, assessments, membranes);
    expect(report.recommendedTest).toMatch(/Run one filtration trial/);
    expect(report.recommendedTest).toMatch(/data\/trials\.json/);
  });

  it("recommends a measured PSD instead, when nothing recommends pretreatment at all", () => {
    const psd = psdForCharacter("clay");
    const fineOnly = membranes.filter((m) => m.id === "0p45um" || m.id === "1p2um");
    const assessments = assessSite(psd, fineOnly, cyclones, trials);
    const report = buildReport(psd, assessments, fineOnly);
    expect(report.usefulWindow).toBeNull();
    expect(report.recommendedTest).toMatch(/measured particle size distribution/);
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
