import { describe, expect, it } from "vitest";
import {
  assessConfiguration,
  assessAllConfigurations,
  buildGradeEfficiencyModel,
  compareConfigurations,
  findUsefulWindow,
  getHydrocyclones,
  getHydrocyclone,
  getMembraneOptions,
  matrixGrid,
  runScreening,
  type AssessmentContext,
} from "@/lib/screening";
import { getSiteData, ASSUMED_PSD_PROFILES } from "@/lib/site";
import { psdFromPercentiles } from "@/lib/psd";
import type { Hydrocyclone, Scenario, ScreeningReport } from "@/types";

const SITE = "Tilford, River Wey";

async function screen(overrides: Partial<Scenario> = {}): Promise<ScreeningReport> {
  const siteData = await getSiteData(SITE, { enableRemote: false });
  const scenario: Scenario = { siteQuery: SITE, siteData, changeLog: [], ...overrides };
  return runScreening({ scenario });
}

describe("catalogue loading", () => {
  it("loads the hydrocyclone catalogue and finds units by id", () => {
    const all = getHydrocyclones();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map((h) => h.id)).toEqual(expect.arrayContaining(["4mm", "10mm"]));
    expect(getHydrocyclone("10mm")?.diameterMm.value).toBe(10);
    expect(getHydrocyclone("nope")).toBeUndefined();
  });

  it("filters the catalogue by id", () => {
    expect(getHydrocyclones(["4mm"]).map((h) => h.id)).toEqual(["4mm"]);
  });

  it("loads membranes in ascending pore size and honours the enabled flag", () => {
    const ms = getMembraneOptions();
    expect(ms.length).toBeGreaterThanOrEqual(7);
    expect(ms.every((m) => m.enabled)).toBe(true);
    for (let i = 1; i < ms.length; i += 1) {
      expect(ms[i].poreSizeUm).toBeGreaterThan(ms[i - 1].poreSizeUm);
    }
  });

  it("declares its separation data unverified, so nothing pretends to be measured", () => {
    for (const h of getHydrocyclones()) {
      expect(h.dataComplete).toBe(false);
      expect(h.cutSize?.d50Um?.verified).toBe(false);
      expect(h.catalogueConfidence).toBe("low");
    }
  });
});

describe("grade efficiency model", () => {
  it("is 50 % at the cut size and monotonic in size", () => {
    const model = buildGradeEfficiencyModel(getHydrocyclone("10mm")!);
    expect(model.available).toBe(true);
    expect(model.efficiencyAt(15)).toBeCloseTo(0.5, 6);
    let prev = -1;
    for (const d of [0.5, 1, 5, 15, 40, 100, 500]) {
      const e = model.efficiencyAt(d);
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
    expect(model.efficiencyAt(2000)).toBeGreaterThan(0.99);
  });

  it("prefers a published grade-efficiency curve over a fitted cut size", () => {
    const unit: Hydrocyclone = {
      id: "curve",
      name: "Curve unit",
      diameterMm: { value: 8, provenance: "published", confidence: "high", verified: true },
      cutSize: {
        d50Um: { value: 99, provenance: "assumed", confidence: "low", verified: false },
        gradeEfficiencyCurve: {
          value: [
            { sizeUm: 5, efficiency: 0.1 },
            { sizeUm: 50, efficiency: 0.9 },
          ],
          provenance: "measured",
          confidence: "high",
          verified: true,
        },
      },
      catalogueConfidence: "high",
      dataComplete: true,
    };
    const model = buildGradeEfficiencyModel(unit);
    expect(model.provenance).toBe("measured");
    expect(model.efficiencyAt(5)).toBeCloseTo(0.1, 6);
    expect(model.efficiencyAt(50)).toBeCloseTo(0.9, 6);
    expect(model.efficiencyAt(1)).toBeCloseTo(0.1, 6); // clamped, not extrapolated
  });

  it("reports itself unavailable when the catalogue records no performance data", () => {
    const bare: Hydrocyclone = {
      id: "bare",
      name: "Uncharacterised unit",
      diameterMm: { value: 6, provenance: "published", confidence: "high", verified: true },
      catalogueConfidence: "low",
      dataComplete: false,
    };
    expect(buildGradeEfficiencyModel(bare).available).toBe(false);
  });
});

describe("unknown equipment data", () => {
  it("returns insufficient_data rather than guessing", async () => {
    const siteData = await getSiteData(SITE, { enableRemote: false });
    const bare: Hydrocyclone = {
      id: "bare",
      name: "Uncharacterised unit",
      diameterMm: { value: 6, provenance: "published", confidence: "high", verified: true },
      catalogueConfidence: "low",
      dataComplete: false,
    };
    const ctx: AssessmentContext = {
      site: siteData,
      psd: ASSUMED_PSD_PROFILES.sand
        ? psdFromPercentiles({ ...ASSUMED_PSD_PROFILES.sand, label: "t", provenance: "assumed", confidence: "low" })
        : (undefined as never),
      psdIsPlaceholder: true,
      particleCharacter: "sand",
    };
    const cell = assessConfiguration(ctx, bare, getMembraneOptions(["10um"])[0]);
    expect(cell.classification).toBe("insufficient_data");
    expect(cell.confidence).toBe("unknown");
    // Explicitly not a negative verdict.
    expect(cell.limitations.join(" ")).toContain("not negative");
  });
});

describe("critical test case 1: a site name and nothing else", () => {
  it("produces a complete report without asking for any parameters", async () => {
    const report = await screen();

    expect(report.matrix.length).toBe(report.hydrocyclones.length * report.membranes.length);
    expect(report.overall.userLabel.length).toBeGreaterThan(0);
    expect(report.usefulWindow.statement.length).toBeGreaterThan(0);
    expect(report.recommendedNextTests.length).toBeGreaterThan(0);
    expect(report.decisionTree.length).toBeGreaterThan(0);
    expect(report.narrative.assumed.length).toBeGreaterThan(0);
    expect(report.unknowns.length).toBeGreaterThan(0);
    expect(report.psdStatistics).toBeDefined();

    // Every cell explains itself.
    for (const cell of report.matrix) {
      expect(cell.reasoning.length).toBeGreaterThan(0);
      expect(cell.mainUncertainty.length).toBeGreaterThan(0);
      expect(cell.limitations.length).toBeGreaterThan(0);
    }
  });

  it("caps confidence at low and warns while the evidence is placeholders", async () => {
    // Deliberately a site with no field observations on record: with nothing
    // but placeholder catalogue data, nothing may rise above low.
    const siteData = await getSiteData("Somewhere with no records", { enableRemote: false });
    const report = runScreening({
      scenario: { siteQuery: "Somewhere with no records", siteData, changeLog: [] },
    });
    expect(siteData.fieldObservations).toHaveLength(0);
    expect(report.overall.confidence).toBe("low");
    expect(report.warnings.join(" ")).toMatch(/NOT verified|placeholder/i);
    expect(report.matrix.every((c) => c.confidence === "low" || c.confidence === "unknown")).toBe(true);
  });

  it("still warns about placeholder catalogue data even where field evidence exists", async () => {
    const report = await screen();
    expect(report.siteData.fieldObservations.length).toBeGreaterThan(0);
    // Field evidence lifts confidence, but it does not make the cut sizes real.
    expect(report.warnings.join(" ")).toMatch(/NOT verified|placeholder/i);
  });

  it("never claims a numerical probability or throughput gain", async () => {
    const report = await screen();
    const prose = [
      report.overall.summary,
      report.usefulWindow.statement,
      ...report.matrix.flatMap((c) => c.reasoning),
      ...report.recommendedNextTests,
    ].join(" ");
    expect(prose).not.toMatch(/probability of success/i);
    expect(prose).not.toMatch(/\+\s*\d+\s*%\s*(filterable|throughput)/i);
    expect(prose).toMatch(/requires testing|needs testing/i);
  });
});

describe("the pore size is not the cut size", () => {
  it("distinguishes membrane retention from cyclone separation in every cell", async () => {
    const report = await screen();
    for (const cell of report.matrix) {
      if (cell.classification === "insufficient_data") continue;
      const prose = cell.reasoning.join(" ");
      expect(prose).toMatch(/retain/i);
      expect(prose).toMatch(/cut size/i);
    }
  });

  it("rates a fine rating below a coarse one for the same unit, because fines dominate fouling", async () => {
    const report = await screen();
    const at = (h: string, m: string) =>
      report.matrix.find((c) => c.hydrocycloneId === h && c.membraneId === m)!;

    // The cyclone removes most of the MASS a 1 µm rating would retain...
    expect(at("10mm", "1um").metrics.cycloneRemovalOfLoad!).toBeGreaterThan(0.5);
    // ...but almost none of the resistance-weighted fouling load.
    expect(at("10mm", "1um").metrics.foulingReliefFraction!).toBeLessThan(0.2);
    expect(at("10mm", "1um").classification).toBe("unlikely");

    expect(at("10mm", "50um").metrics.foulingReliefFraction!).toBeGreaterThan(0.8);
    expect(at("10mm", "50um").classification).toBe("promising");
  });
});

describe("configuration matrix generation", () => {
  it("expands automatically as the catalogue grows, with no engine changes", async () => {
    const siteData = await getSiteData(SITE, { enableRemote: false });
    const ctx: AssessmentContext = {
      site: siteData,
      psd: psdFromPercentiles({
        d10Um: 2, d50Um: 25, d90Um: 150, label: "t", provenance: "measured", confidence: "high", verified: true,
      }),
      psdIsPlaceholder: false,
      particleCharacter: "sand",
    };
    const extra: Hydrocyclone = {
      id: "6mm",
      name: "6 mm Hydrocyclone",
      diameterMm: { value: 6, provenance: "published", confidence: "high", verified: true },
      cutSize: {
        d50Um: { value: 11, provenance: "measured", confidence: "high", verified: true },
        sharpness: { value: 2.5, provenance: "measured", confidence: "high", verified: true },
      },
      catalogueConfidence: "high",
      dataComplete: true,
    };
    const membranes = getMembraneOptions();
    const matrix = assessAllConfigurations(ctx, [...getHydrocyclones(), extra], membranes);
    expect(matrix.length).toBe(3 * membranes.length);
    expect(matrix.some((c) => c.hydrocycloneId === "6mm")).toBe(true);
  });

  it("lays out as a grid with one cell per row/column pair", async () => {
    const report = await screen();
    const grid = matrixGrid(report);
    expect(grid).toHaveLength(report.hydrocyclones.length);
    for (const row of grid) {
      expect(row.cells).toHaveLength(report.membranes.length);
      expect(row.cells.every(Boolean)).toBe(true);
    }
  });
});

describe("critical test case 4: comparing the 4 mm and the 10 mm", () => {
  it("evaluates both against the same site and membrane range", async () => {
    const report = await screen();
    const comparison = compareConfigurations(report.matrix, ["4mm", "10mm"]);
    expect(comparison).toHaveLength(2);

    const four = comparison.find((c) => c.hydrocycloneId === "4mm")!;
    const ten = comparison.find((c) => c.hydrocycloneId === "10mm")!;

    expect(four.cutSizeUm!).toBeLessThan(ten.cutSizeUm!);
    // The finer cut reaches further down the membrane range.
    const finestFour = Math.min(
      ...report.matrix
        .filter((c) => c.hydrocycloneId === "4mm" && c.classification !== "unlikely" && c.classification !== "marginal")
        .map((c) => c.membranePoreSizeUm),
    );
    const finestTen = Math.min(
      ...report.matrix
        .filter((c) => c.hydrocycloneId === "10mm" && c.classification !== "unlikely" && c.classification !== "marginal")
        .map((c) => c.membranePoreSizeUm),
    );
    expect(finestFour).toBeLessThanOrEqual(finestTen);
    expect(four.cutSizeProvenance).toBe("assumed");
  });
});

describe("useful window", () => {
  it("identifies a contiguous band and names what falls outside it", async () => {
    const report = await screen();
    expect(report.usefulWindow.lowerUm).toBeDefined();
    expect(report.usefulWindow.upperUm!).toBeGreaterThanOrEqual(report.usefulWindow.lowerUm!);
    expect(report.usefulWindow.statement).toMatch(/µm/);
  });

  it("says so plainly when no window exists", () => {
    const window = findUsefulWindow([], getMembraneOptions());
    expect(window.statement).toMatch(/no membrane pore-size window|does not currently support/i);
  });
});

describe("critical test case 3: the particles are actually clay", () => {
  it("re-runs the assessment from the changed scenario, and becomes less favourable", async () => {
    const sand = await screen({ particleCharacterOverride: "sand" });
    const clay = await screen({ particleCharacterOverride: "clay" });

    const reliefAt = (r: ScreeningReport, m: string) =>
      r.matrix.find((c) => c.hydrocycloneId === "10mm" && c.membraneId === m)!.metrics
        .foulingReliefFraction!;

    expect(reliefAt(clay, "10um")).toBeLessThan(reliefAt(sand, "10um"));
    expect(clay.narrative.assumed.join(" ")).toMatch(/clay/i);
    // The reasoning explains the change rather than asserting an efficiency.
    expect(clay.matrix.flatMap((c) => c.assumptions).join(" ")).toMatch(/floc|effective density/i);
  });
});

describe("critical test case 2: the user supplies a PSD", () => {
  it("uses the supplied distribution instead of the placeholder and lifts the warning", async () => {
    const withoutPsd = await screen();
    const psd = psdFromPercentiles({
      d10Um: 2,
      d50Um: 25,
      d90Um: 150,
      label: "Site sample, user supplied",
      provenance: "measured",
      confidence: "medium",
      verified: false,
    });
    const withPsd = await screen({ psdOverride: psd });

    expect(withoutPsd.psdSource?.provenance).toBe("assumed");
    expect(withPsd.psdSource?.provenance).toBe("measured");
    expect(withPsd.psdStatistics?.d50Um).toBeCloseTo(25, 3);
    expect(withPsd.warnings.join(" ")).not.toMatch(/No site-specific particle-size distribution/);
    expect(withoutPsd.warnings.join(" ")).toMatch(/No site-specific particle-size distribution/);
  });
});

describe("classification logic", () => {
  it("calls a rating marginal when there is almost nothing for the membrane to retain", async () => {
    const siteData = await getSiteData(SITE, { enableRemote: false });
    // A very fine population: nothing is coarser than 100 µm.
    const ctx: AssessmentContext = {
      site: siteData,
      psd: psdFromPercentiles({
        d10Um: 0.5, d50Um: 2, d90Um: 8, label: "very fine", provenance: "measured", confidence: "high", verified: true,
      }),
      psdIsPlaceholder: false,
      particleCharacter: "clay",
    };
    const cell = assessConfiguration(ctx, getHydrocyclone("10mm")!, getMembraneOptions(["100um"])[0]);
    expect(cell.metrics.membraneLoadFraction!).toBeLessThan(0.02);
    expect(cell.classification).toBe("marginal");
    expect(cell.reasoning.join(" ")).toMatch(/larger pore size is not automatically better/i);
  });

  it("explains why unlikely combinations are unlikely, rather than just saying no", async () => {
    const report = await screen();
    for (const cell of report.unlikely) {
      expect(cell.reasoning.join(" ")).toMatch(/cut size|dominated by particles/i);
      expect(cell.reasoning.join(" ").length).toBeGreaterThan(120);
    }
  });

  it("ranks candidates into the four output categories with nothing lost", async () => {
    const report = await screen();
    const total =
      report.best.length + report.borderline.length + report.unlikely.length + report.missingData.length;
    const positives = report.matrix.filter(
      (c) => c.classification === "promising" || c.classification === "potentially_suitable",
    ).length;
    // `best` is capped at five, so the sum can be short only by the excess.
    expect(total).toBe(report.matrix.length - Math.max(0, positives - 5));
  });
});

describe("hydraulic compatibility", () => {
  it("reports unknown rather than assuming a duty point", async () => {
    const report = await screen();
    for (const cell of report.matrix) {
      expect(cell.hydraulic.status).toBe("unknown");
      expect(cell.hydraulic.note).toMatch(/unknown/i);
    }
  });
});
