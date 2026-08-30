import { describe, expect, it } from "vitest";
import {
  binDistribution,
  fractionCoarserThan,
  fractionFinerThan,
  geometricStdDev,
  massFractionBetween,
  normCdf,
  normInv,
  psdForCharacter,
  sizeAtPercentile,
} from "@/lib/psd";

describe("statistics", () => {
  it("normCdf matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.2815515655)).toBeCloseTo(0.9, 4);
    expect(normCdf(-1.2815515655)).toBeCloseTo(0.1, 4);
  });

  it("normInv inverts normCdf", () => {
    for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      expect(normCdf(normInv(p))).toBeCloseTo(p, 5);
    }
  });
});

describe("the fitted distribution reproduces its own percentiles", () => {
  const sand = psdForCharacter("sand");

  it("passes through d50 exactly", () => {
    expect(fractionFinerThan(sand, sand.d50Um)).toBeCloseTo(0.5, 6);
    expect(sizeAtPercentile(sand, 50)).toBeCloseTo(sand.d50Um, 6);
  });

  it("spans d10 to d90 as specified", () => {
    // A single log-normal cannot pass through three arbitrary points, so the
    // fit is anchored on d50 with the spread taken from the d90/d10 ratio.
    expect(sizeAtPercentile(sand, 90) / sizeAtPercentile(sand, 10))
      .toBeCloseTo(sand.d90Um / sand.d10Um, 3);
  });

  it("is monotonic in size", () => {
    let previous = -1;
    for (const size of [0.1, 1, 5, 20, 60, 200, 1000]) {
      const f = fractionFinerThan(sand, size);
      expect(f).toBeGreaterThanOrEqual(previous);
      previous = f;
    }
  });

  it("finer and coarser always sum to one", () => {
    for (const size of [0.5, 2, 10, 50, 300]) {
      expect(fractionFinerThan(sand, size) + fractionCoarserThan(sand, size)).toBeCloseTo(1, 6);
    }
  });
});

describe("the four profiles are ordered as their names claim", () => {
  const clay = psdForCharacter("clay");
  const silt = psdForCharacter("silt");
  const mixed = psdForCharacter("mixed_mineral");
  const sand = psdForCharacter("sand");

  it("gets coarser from clay through to sand", () => {
    expect(clay.d50Um).toBeLessThan(silt.d50Um);
    expect(silt.d50Um).toBeLessThan(mixed.d50Um);
    expect(mixed.d50Um).toBeLessThan(sand.d50Um);
  });

  it("has an increasing d10 and d90 in the same order", () => {
    const order = [clay, silt, mixed, sand];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i].d10Um).toBeGreaterThan(order[i - 1].d10Um);
      expect(order[i].d90Um).toBeGreaterThan(order[i - 1].d90Um);
    }
  });

  it("marks every profile as a guess, because every one is", () => {
    for (const p of [clay, silt, mixed, sand]) {
      expect(p.status).toBe("guessed");
      expect(p.label).toMatch(/assumed/i);
    }
  });

  it("has a sane spread on each - not absurdly narrow or wide", () => {
    for (const p of [clay, silt, mixed, sand]) {
      const sigma = geometricStdDev(p);
      expect(sigma).toBeGreaterThan(1.5);
      expect(sigma).toBeLessThan(12);
    }
  });
});

describe("what this means for a hydrocyclone", () => {
  it("leaves almost nothing above 20 um in a clay water", () => {
    // The core reason clay sites screen badly: a small cyclone cuts somewhere
    // around 8-15 um, and in clay there is barely any mass above that.
    expect(fractionCoarserThan(psdForCharacter("clay"), 20)).toBeLessThan(0.1);
  });

  it("leaves a substantial coarse fraction in a sand water", () => {
    expect(fractionCoarserThan(psdForCharacter("sand"), 20)).toBeGreaterThan(0.5);
  });

  it("separates the two cases by an order of magnitude", () => {
    const clayCoarse = fractionCoarserThan(psdForCharacter("clay"), 20);
    const sandCoarse = fractionCoarserThan(psdForCharacter("sand"), 20);
    expect(sandCoarse / Math.max(clayCoarse, 1e-6)).toBeGreaterThan(10);
  });
});

describe("binning for integration", () => {
  const sand = psdForCharacter("sand");

  it("accounts for essentially all the mass", () => {
    const total = binDistribution(sand).reduce((sum, b) => sum + b.massFraction, 0);
    expect(total).toBeGreaterThan(0.98);
    expect(total).toBeLessThanOrEqual(1.0001);
  });

  it("uses the geometric mean as the representative size", () => {
    for (const bin of binDistribution(sand).slice(0, 10)) {
      expect(bin.midUm).toBeCloseTo(Math.sqrt(bin.loUm * bin.hiUm), 9);
      expect(bin.midUm).toBeGreaterThan(bin.loUm);
      expect(bin.midUm).toBeLessThan(bin.hiUm);
    }
  });

  it("agrees with the closed-form fraction over a range", () => {
    const binned = binDistribution(sand)
      .filter((b) => b.midUm >= 20)
      .reduce((sum, b) => sum + b.massFraction, 0);
    expect(binned).toBeCloseTo(fractionCoarserThan(sand, 20), 1);
  });

  it("sums a partition back to one", () => {
    const edges = [0.05, 1, 5, 20, 100, 3000];
    let total = 0;
    for (let i = 1; i < edges.length; i += 1) {
      total += massFractionBetween(sand, edges[i - 1], edges[i]);
    }
    expect(total).toBeGreaterThan(0.98);
  });
});
