import { describe, expect, it } from "vitest";
import {
  characterCorrectionFactor,
  grainSizeClassForD50,
  loadSedimentProperties,
  porosityPrefactor,
  TRIAL_FEED_CLASS,
} from "@/lib/sediment-properties";

describe("grainSizeClassForD50: same Wentworth boundaries lib/field-update.ts already uses", () => {
  it("classifies clay, silt and sand correctly at and around the boundaries", () => {
    expect(grainSizeClassForD50(2)).toBe("clay");
    expect(grainSizeClassForD50(3.99)).toBe("clay");
    expect(grainSizeClassForD50(4)).toBe("silt");
    expect(grainSizeClassForD50(30)).toBe("silt");
    expect(grainSizeClassForD50(62.99)).toBe("silt");
    expect(grainSizeClassForD50(63)).toBe("sand");
    expect(grainSizeClassForD50(500)).toBe("sand");
  });

  it("classifies the real trial feed's own measured d50s (22-31 um across all 10 trials) as silt", () => {
    for (const d50 of [22.8, 26.2, 22.5, 27.7, 31.1]) {
      expect(grainSizeClassForD50(d50)).toBe("silt");
    }
    expect(TRIAL_FEED_CLASS).toBe("silt");
  });
});

describe("loadSedimentProperties: the real published data", () => {
  const props = loadSedimentProperties();

  it("every class has physically valid porosity (strictly between 0 and 1) and positive density", () => {
    for (const cls of ["sand", "silt", "clay"] as const) {
      const c = props[cls];
      expect(c.porosityLow).toBeGreaterThan(0);
      expect(c.porosityHigh).toBeLessThan(1);
      expect(c.porosityLow).toBeLessThanOrEqual(c.porosityMid);
      expect(c.porosityMid).toBeLessThanOrEqual(c.porosityHigh);
      expect(c.particleDensityKgM3).toBeGreaterThan(0);
      expect(c.note?.length).toBeGreaterThan(0);
    }
  });

  it("has all three classes with sensible, published-range porosities", () => {
    expect(props.sand.porosityMid).toBeGreaterThan(0.3);
    expect(props.sand.porosityMid).toBeLessThan(0.5);
    expect(props.clay.porosityHigh).toBeGreaterThan(props.sand.porosityHigh);
  });

  it("clay's porosity range is the widest - the biggest real source of this estimate's uncertainty", () => {
    const spread = (c: { porosityLow: number; porosityHigh: number }) => c.porosityHigh - c.porosityLow;
    expect(spread(props.clay)).toBeGreaterThan(spread(props.sand));
    expect(spread(props.clay)).toBeGreaterThan(spread(props.silt));
  });

  it("porosity increases sand -> silt -> clay at the mid estimate, matching the cited literature", () => {
    expect(props.sand.porosityMid).toBeLessThan(props.silt.porosityMid);
    expect(props.silt.porosityMid).toBeLessThan(props.clay.porosityMid);
  });
});

describe("porosityPrefactor", () => {
  it("a lower porosity gives a HIGHER prefactor (denser packing resists filtration more)", () => {
    expect(porosityPrefactor(0.3, 2650)).toBeGreaterThan(porosityPrefactor(0.6, 2650));
  });

  it("a higher particle density gives a LOWER prefactor, at fixed porosity", () => {
    expect(porosityPrefactor(0.5, 3000)).toBeLessThan(porosityPrefactor(0.5, 2000));
  });
});

describe("characterCorrectionFactor: real hand-computed values against the real data file", () => {
  it("sand (lower porosity than the silt-class trial feed) gets a correction below 1 - a smaller baseline than naively reusing k", () => {
    const sand = characterCorrectionFactor("sand");
    expect(sand.low).toBeCloseTo(0.550, 2);
    expect(sand.mid).toBeCloseTo(0.631, 2);
    expect(sand.high).toBeCloseTo(0.784, 2);
  });

  it("clay (higher porosity than the trial feed, at mid/high estimates) gets a correction mostly above 1", () => {
    const clay = characterCorrectionFactor("clay");
    expect(clay.low).toBeCloseTo(0.818, 2);
    expect(clay.mid).toBeCloseTo(1.637, 2);
    expect(clay.high).toBeCloseTo(4.989, 2);
  });

  it("silt corrected against itself is close to 1 (low/mid/high straddling the trial's own mid porosity)", () => {
    const silt = characterCorrectionFactor("silt");
    expect(silt.mid).toBeCloseTo(1, 1);
  });

  it("low < mid < high for every class - porosity uncertainty is a real, ordered range, never scrambled", () => {
    for (const cls of ["sand", "silt", "clay"] as const) {
      const c = characterCorrectionFactor(cls);
      expect(c.low).toBeLessThanOrEqual(c.mid);
      expect(c.mid).toBeLessThanOrEqual(c.high);
    }
  });

  it("clay's correction spans a far wider ratio than sand's - the uncertainty is reported, not hidden", () => {
    const clay = characterCorrectionFactor("clay");
    const sand = characterCorrectionFactor("sand");
    expect(clay.high / clay.low).toBeGreaterThan(sand.high / sand.low);
  });
});
