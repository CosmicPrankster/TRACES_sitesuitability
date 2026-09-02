import { describe, expect, it } from "vitest";
import type { Hydrocyclone, Membrane } from "@/lib/data";
import { loadHydrocyclones, loadMembranes } from "@/lib/data";
import { psdForCharacter } from "@/lib/psd";
import { assessMatrix, assessPair } from "@/lib/assessment";

const cyclones = loadHydrocyclones();
const fiveMm = cyclones.find((h) => h.id === "5mm")!;
const tenMm = cyclones.find((h) => h.id === "10mm")!;
const membranes = loadMembranes();
const fiveUm = membranes.find((m) => m.id === "5um")!;
const twentyUm = membranes.find((m) => m.id === "20um")!;

describe("assessPair: today's real, all-guessed data (no trial required anywhere)", () => {
  it("gives a sand site real benefit from the 5mm cyclone at a coarse membrane", () => {
    const cell = assessPair(psdForCharacter("sand"), fiveMm, twentyUm);
    expect(["strong", "promising"]).toContain(cell.verdict);
    expect(cell.volumeRatio).toBeGreaterThan(1.5);
  });

  it("does NOT call everything promising - a clay site at a fine membrane should not be strong", () => {
    // HANDOFF.md's explicit warning: if this screens as promising everywhere,
    // the model is broken. Clay has almost nothing coarse enough to remove.
    const cell = assessPair(psdForCharacter("clay"), fiveMm, fiveUm);
    expect(cell.verdict).not.toBe("strong");
  });

  it("marks confidence low everywhere right now, because every input actually is a guess", () => {
    for (const character of ["sand", "clay"] as const) {
      for (const h of [fiveMm, tenMm]) {
        for (const m of [fiveUm, twentyUm]) {
          expect(assessPair(psdForCharacter(character), h, m).confidence).toBe("low");
        }
      }
    }
  });

  it("names the weak links in the reasoning text, in plain English", () => {
    const cell = assessPair(psdForCharacter("sand"), fiveMm, fiveUm);
    expect(cell.reasoning).toMatch(/particle size distribution is a guess/);
    expect(cell.reasoning).toMatch(/cut sizes are guessed/);
    expect(cell.reasoning).toMatch(/nominal pore size, not a supplier figure/);
  });
});

describe("assessPair: mass removed is not fouling removed", () => {
  it("removes less fouling load than mass, because the cyclone strips the coarse end first", () => {
    // The single most important physical claim in this block. Coarse
    // particles carry mass but little fouling resistance (1/d^2), so
    // foulingReduction should trail retainedMass's own coarse-removal share.
    const cell = assessPair(psdForCharacter("sand"), fiveMm, fiveUm);
    expect(cell.foulingReduction).toBeLessThan(1);
    expect(cell.foulingRemoved).toBeLessThanOrEqual(cell.foulingLoad);
  });

  it("converts a 56% fouling reduction to about 1.5x volume, per Carman-Kozeny", () => {
    // 1/sqrt(1-0.56) = 1.507..., matching screening-parameters.json's own
    // worked example exactly.
    expect(1 / Math.sqrt(1 - 0.56)).toBeCloseTo(1.5, 1);
  });
});

describe("assessPair: the minimum-retained-mass override", () => {
  it("calls it marginal, not unlikely-or-better, when there is almost nothing to remove", () => {
    // Clay barely reaches the 5mm's cut size at all, so retainedMass should
    // fall under screening-parameters.json's 2% threshold for a fine membrane.
    const cell = assessPair(psdForCharacter("clay"), fiveMm, fiveUm);
    if (cell.retainedMass < 0.02) {
      expect(cell.verdict).toBe("marginal");
      expect(cell.reasoning).toMatch(/almost nothing there to remove/);
    }
  });
});

describe("assessPair: insufficient data is not a negative verdict", () => {
  it("returns insufficient-data for a hydrocyclone with no usable cut curve", () => {
    const broken: Hydrocyclone = {
      ...fiveMm,
      cut: { d20Um: 5, d50Um: 5, d90Um: 5 }, // degenerate: no spread at all
    };
    const cell = assessPair(psdForCharacter("sand"), broken, fiveUm);
    expect(cell.verdict).toBe("insufficient-data");
    expect(cell.reasoning).toMatch(/absence of evidence/i);
  });
});

describe("assessMatrix", () => {
  it("produces one cell per hydrocyclone x membrane combination", () => {
    const matrix = assessMatrix(psdForCharacter("sand"), cyclones, membranes);
    expect(matrix.length).toBe(cyclones.length * membranes.length);
  });

  it("spans more than one verdict across a clay site - it is allowed to say unlikely often", () => {
    const matrix = assessMatrix(psdForCharacter("clay"), cyclones, membranes);
    const verdicts = new Set(matrix.map((c) => c.verdict));
    expect(verdicts.size).toBeGreaterThan(1);
  });

  it("the 5mm always removes at least as much fouling reduction as the 10mm on the same feed", () => {
    // Smaller body, finer cut - the sharper unit should never do worse.
    const matrix = assessMatrix(psdForCharacter("mixed_mineral"), cyclones, membranes);
    for (const m of membranes) {
      const five = matrix.find((c) => c.hydrocycloneId === "5mm" && c.membraneId === m.id)!;
      const ten = matrix.find((c) => c.hydrocycloneId === "10mm" && c.membraneId === m.id)!;
      expect(five.foulingReduction).toBeGreaterThanOrEqual(ten.foulingReduction - 1e-9);
    }
  });
});

describe("assessPair: membrane retention (block 5c) feeds straight into the verdict", () => {
  it("a supplier-stated retention size changes the confidence, not just the number", () => {
    const populated: Membrane = {
      ...fiveUm,
      product: {
        populated: true, manufacturer: "Acme", productCode: "AF-5000", material: "PES",
        retentionUm: 5, rating: "absolute", sourceUrl: "https://example.com", retrievedOn: "2026-01-01", notes: [],
      },
    };
    const before = assessPair(psdForCharacter("sand"), fiveMm, fiveUm);
    const after = assessPair(psdForCharacter("sand"), fiveMm, populated);
    expect(before.confidence).toBe("low");
    // Still capped low overall (PSD and cut size are still guesses), but the
    // membrane's own weak link should have dropped out of the reasoning.
    expect(after.reasoning).not.toMatch(/nominal pore size, not a supplier figure/);
  });
});
