import { describe, expect, it } from "vitest";
import type { Membrane } from "@/lib/data";
import { loadMembranes } from "@/lib/data";
import { psdForCharacter } from "@/lib/psd";
import { membraneRetention, retainedMassFraction } from "@/lib/retention";

function populatedMembrane(overrides: Partial<Membrane> = {}): Membrane {
  return {
    id: "5um",
    poreSizeUm: 5,
    label: "5 µm",
    enabled: true,
    product: {
      populated: true,
      manufacturer: "Acme Filtration",
      productCode: "AF-5000",
      material: "PES",
      retentionUm: 3.2,
      rating: "absolute",
      sourceUrl: "https://example.com/af-5000",
      retrievedOn: "2026-01-01",
      notes: [],
    },
    ...overrides,
  };
}

describe("membraneRetention: no product data on file (today's real catalogue)", () => {
  it("falls back to the nominal pore size for every membrane in data/membranes.json", () => {
    for (const m of loadMembranes()) {
      const r = membraneRetention(m);
      expect(r.effectiveRetentionUm).toBe(m.poreSizeUm);
      expect(r.source).toBe("nominal-pore-size");
      expect(r.rating).toBe("unstated");
    }
  });

  it("warns that the unstated-rating sharp cut is an unverified approximation", () => {
    const r = membraneRetention(loadMembranes()[0]);
    expect(r.caveat).toMatch(/rough approximation/i);
  });
});

describe("membraneRetention: literature (a populated product page) takes over", () => {
  it("prefers the manufacturer's stated retentionUm over the nominal pore size", () => {
    // 3.2 um retention vs a 5 um nominal pore size - the two differ, exactly
    // the case the README calls out ('record both when they differ').
    const r = membraneRetention(populatedMembrane());
    expect(r.effectiveRetentionUm).toBe(3.2);
    expect(r.source).toBe("measured-product");
  });

  it("trusts a sharp cut more for an absolute rating than a nominal one", () => {
    const absolute = membraneRetention(populatedMembrane({
      product: { ...populatedMembrane().product, rating: "absolute" },
    }));
    const nominal = membraneRetention(populatedMembrane({
      product: { ...populatedMembrane().product, rating: "nominal" },
    }));
    expect(absolute.caveat).toMatch(/reasonable/i);
    expect(nominal.caveat).toMatch(/overstates/i);
  });

  it("still falls back to nominal pore size if populated but retentionUm was never filled in", () => {
    const m = populatedMembrane({
      product: { ...populatedMembrane().product, retentionUm: null },
    });
    const r = membraneRetention(m);
    expect(r.effectiveRetentionUm).toBe(m.poreSizeUm);
    expect(r.source).toBe("nominal-pore-size");
  });
});

describe("retainedMassFraction: physics (sharp cut) applied to a PSD", () => {
  it("matches fractionCoarserThan directly when no product data exists", () => {
    const sand = psdForCharacter("sand");
    const m = loadMembranes().find((x) => x.id === "5um")!;
    // No trial, no product page - this is the literature/physics-only path
    // the user asked to prioritise: PSD guess x sharp cut at nominal pore size.
    const fraction = retainedMassFraction(sand, m);
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThanOrEqual(1);
  });

  it("a finer effective retention size always retains at least as much mass", () => {
    const clay = psdForCharacter("clay");
    const coarseCut = populatedMembrane({ product: { ...populatedMembrane().product, retentionUm: 10 } });
    const fineCut = populatedMembrane({ product: { ...populatedMembrane().product, retentionUm: 1 } });
    expect(retainedMassFraction(clay, fineCut)).toBeGreaterThanOrEqual(retainedMassFraction(clay, coarseCut));
  });

  it("retains almost everything from a sand PSD at a coarse 20um membrane, almost nothing from clay", () => {
    // The same sanity check the project already applies to hydrocyclones
    // (block 5b), now applied to the membrane side: coarse feed screens
    // well, fine feed screens badly, from the physics alone.
    const twentyUm = loadMembranes().find((x) => x.id === "20um")!;
    const sandRetained = retainedMassFraction(psdForCharacter("sand"), twentyUm);
    const clayRetained = retainedMassFraction(psdForCharacter("clay"), twentyUm);
    expect(sandRetained).toBeGreaterThan(0.5);
    expect(clayRetained).toBeLessThan(0.1);
  });
});
