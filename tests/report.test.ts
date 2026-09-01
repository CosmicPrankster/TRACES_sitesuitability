import { describe, expect, it } from "vitest";
import { loadHydrocyclones, loadMembranes } from "@/lib/data";
import { psdForCharacter } from "@/lib/psd";
import { assessMatrix } from "@/lib/assessment";
import { buildReport, findUsefulWindow, groupCells } from "@/lib/report";

const cyclones = loadHydrocyclones();
const membranes = loadMembranes(); // ascending pore size: 0.45, 1.2, 5, 10, 20

describe("groupCells", () => {
  it("splits a sand matrix into more than one group - not everything is 'best'", () => {
    const matrix = assessMatrix(psdForCharacter("sand"), cyclones, membranes);
    const groups = groupCells(matrix);
    expect(groups.best.length).toBeGreaterThan(0);
    expect(groups.unlikely.length).toBeGreaterThan(0);
    expect(groups.best.length + groups.marginal.length + groups.unlikely.length + groups.insufficientData.length)
      .toBe(matrix.length);
  });

  it("lumps strong and promising together as 'best'", () => {
    const matrix = assessMatrix(psdForCharacter("sand"), cyclones, membranes);
    const groups = groupCells(matrix);
    expect(groups.best.every((c) => c.verdict === "strong" || c.verdict === "promising")).toBe(true);
  });
});

describe("findUsefulWindow: the single most valuable output", () => {
  it("finds a contiguous coarse-membrane band for a sand site", () => {
    const matrix = assessMatrix(psdForCharacter("sand"), cyclones, membranes);
    const window = findUsefulWindow(matrix, membranes);
    expect(window).not.toBeNull();
    expect(window!.membraneIds).toEqual(["10um", "20um"]);
    expect(window!.fromPoreSizeUm).toBe(10);
    expect(window!.toPoreSizeUm).toBe(20);
  });

  it("returns null - not a fabricated window - when nothing qualifies", () => {
    const matrix = assessMatrix(psdForCharacter("clay"), cyclones, membranes);
    const fineOnly = membranes.filter((m) => m.id === "0p45um" || m.id === "1p2um");
    const window = findUsefulWindow(matrix, fineOnly);
    expect(window).toBeNull();
  });

  it("never includes a membrane whose best available verdict is below 'promising'", () => {
    const matrix = assessMatrix(psdForCharacter("clay"), cyclones, membranes);
    const window = findUsefulWindow(matrix, membranes);
    const covered = new Set(window?.membraneIds ?? []);
    for (const m of membranes) {
      if (covered.has(m.id)) continue;
      const cellsForM = matrix.filter((c) => c.membraneId === m.id);
      const anyPromisingOrBetter = cellsForM.some((c) => c.verdict === "strong" || c.verdict === "promising");
      expect(anyPromisingOrBetter).toBe(false);
    }
  });
});

describe("buildReport: the six sections", () => {
  it("headlines the useful window in plain English when one exists", () => {
    const psd = psdForCharacter("sand");
    const matrix = assessMatrix(psd, cyclones, membranes);
    const report = buildReport(psd, matrix, cyclones, membranes);
    expect(report.verdict).toMatch(/Pretreatment looks worthwhile/);
    expect(report.verdict).toMatch(/10 to 20/);
    expect(report.usefulWindow?.membraneIds).toEqual(["10um", "20um"]);
  });

  it("lists every configuration, best result first", () => {
    const psd = psdForCharacter("sand");
    const matrix = assessMatrix(psd, cyclones, membranes);
    const report = buildReport(psd, matrix, cyclones, membranes);
    expect(report.configurations.length).toBe(cyclones.length * membranes.length);
    expect(report.configurations[0].verdict).toBe("strong");
    expect(report.configurations.at(-1)!.verdict).toBe("unlikely");
  });

  it("WHAT WE KNOW names the actual inputs used, in plain English", () => {
    const psd = psdForCharacter("sand");
    const matrix = assessMatrix(psd, cyclones, membranes);
    const report = buildReport(psd, matrix, cyclones, membranes);
    expect(report.whatWeKnow.some((l) => l.includes("Particle size assumption used"))).toBe(true);
    expect(report.whatWeKnow.some((l) => l.includes("10 mm hydrocyclone"))).toBe(true);
  });

  it("WHAT WE DON'T KNOW names every guess as a guess, honestly, on today's real data", () => {
    const psd = psdForCharacter("sand");
    const matrix = assessMatrix(psd, cyclones, membranes);
    const report = buildReport(psd, matrix, cyclones, membranes);
    const text = report.whatWeDontKnow.join(" ");
    expect(text).toMatch(/particle size distribution is a guess/);
    expect(text).toMatch(/cut sizes are guessed/);
    expect(text).toMatch(/nominal pore size - no supplier product page/);
    expect(text).toMatch(/No filtration trial exists for this specific site/);
  });

  it("recommends a real filtration trial when something screens as worthwhile", () => {
    const psd = psdForCharacter("sand");
    const matrix = assessMatrix(psd, cyclones, membranes);
    const report = buildReport(psd, matrix, cyclones, membranes);
    expect(report.recommendedTest).toMatch(/Run one filtration trial/);
    expect(report.recommendedTest).toMatch(/data\/trials\.json/);
  });

  it("recommends a measured PSD instead, when nothing screens as worthwhile at all", () => {
    const psd = psdForCharacter("clay");
    const fineOnly = membranes.filter((m) => m.id === "0p45um" || m.id === "1p2um");
    const matrix = assessMatrix(psd, cyclones, fineOnly);
    const report = buildReport(psd, matrix, cyclones, fineOnly);
    expect(report.usefulWindow).toBeNull();
    expect(report.recommendedTest).toMatch(/measured particle size distribution/);
    expect(report.verdict).toMatch(/No membrane rating currently screens/);
  });
});
