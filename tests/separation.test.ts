import { describe, expect, it } from "vitest";
import { loadHydrocyclones } from "@/lib/data";
import { fitSharpness, gradeEfficiency, gradeEfficiencyCurve } from "@/lib/separation";

const cyclones = loadHydrocyclones();
const fiveMm = cyclones.find((h) => h.id === "5mm")!;
const tenMm = cyclones.find((h) => h.id === "10mm")!;

describe("fitSharpness", () => {
  it("is positive for a catalogue entry (d20 < d50 < d90)", () => {
    expect(fitSharpness(fiveMm.cut)).toBeGreaterThan(0);
    expect(fitSharpness(tenMm.cut)).toBeGreaterThan(0);
  });

  it("gives a sharper curve to a narrower cut spread", () => {
    // 5 mm: d20=3, d50=8, d90=25 -> ratio d90/d20 ~ 8.3
    // 10 mm: d20=6, d50=15, d90=45 -> ratio d90/d20 = 7.5 (slightly narrower)
    const narrow = fitSharpness({ d20Um: 6, d50Um: 15, d90Um: 45 });
    const wide = fitSharpness({ d20Um: 3, d50Um: 15, d90Um: 90 });
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe("gradeEfficiencyCurve", () => {
  it("carries the hydrocyclone id, d50 and cut status through unchanged", () => {
    const curve = gradeEfficiencyCurve(fiveMm);
    expect(curve.hydrocycloneId).toBe("5mm");
    expect(curve.d50Um).toBe(fiveMm.cut.d50Um);
    expect(curve.status).toBe(fiveMm.status.cut);
    expect(curve.source).toBe("fitted-curve");
  });

  it("never reports a guessed cut as measured", () => {
    // Both catalogue entries are guesses today; this pins that the field is
    // read from the data, not assumed, so it changes the moment the data does.
    expect(gradeEfficiencyCurve(fiveMm).status).toBe("guessed");
    expect(gradeEfficiencyCurve(tenMm).status).toBe("guessed");
  });
});

describe("gradeEfficiency", () => {
  const curve = gradeEfficiencyCurve(fiveMm);

  it("passes through exactly 0.5 at d50, by construction", () => {
    expect(gradeEfficiency(curve, fiveMm.cut.d50Um)).toBeCloseTo(0.5, 9);
  });

  it("passes close to 0.2 at d20 and 0.9 at d90", () => {
    // Not exact: one m cannot satisfy three points, so this is the fit
    // quality, not an identity.
    expect(gradeEfficiency(curve, fiveMm.cut.d20Um)).toBeCloseTo(0.2, 1);
    expect(gradeEfficiency(curve, fiveMm.cut.d90Um)).toBeCloseTo(0.9, 1);
  });

  it("is monotonically increasing with size", () => {
    let previous = -1;
    for (const size of [0.1, 1, 3, 8, 25, 100, 1000]) {
      const g = gradeEfficiency(curve, size);
      expect(g).toBeGreaterThanOrEqual(previous);
      previous = g;
    }
  });

  it("tends to 0 for very fine particles and 1 for very coarse ones", () => {
    expect(gradeEfficiency(curve, 0.001)).toBeLessThan(0.01);
    expect(gradeEfficiency(curve, 100000)).toBeGreaterThan(0.99);
  });

  it("treats non-positive sizes as fully passing through (zero removal)", () => {
    expect(gradeEfficiency(curve, 0)).toBe(0);
    expect(gradeEfficiency(curve, -5)).toBe(0);
  });

  it("stays within [0, 1] across a wide size range", () => {
    for (const size of [0.001, 0.05, 1, 5, 15, 50, 200, 5000, 1e6]) {
      const g = gradeEfficiency(curve, size);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
    }
  });
});

describe("the 10 mm unit cuts coarser than the 5 mm unit", () => {
  it("removes less of a mid-size particle than the smaller unit does", () => {
    const small = gradeEfficiencyCurve(fiveMm);
    const large = gradeEfficiencyCurve(tenMm);
    expect(gradeEfficiency(large, 10)).toBeLessThan(gradeEfficiency(small, 10));
  });
});
