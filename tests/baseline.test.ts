import { describe, expect, it } from "vitest";
import { loadMembranes, loadTrials } from "@/lib/data";
import {
  calibrateBaselines,
  foulingLoadForMembrane,
  predictBaselineVolume,
  psdFromMeasuredD20D50D90,
} from "@/lib/baseline";
import { fractionFinerThan, psdForCharacter } from "@/lib/psd";

const membranes = loadMembranes();
const byPoreSize = new Map(membranes.map((m) => [m.poreSizeUm, m]));
const fiveUm = byPoreSize.get(5)!;
const trials = loadTrials();

describe("psdFromMeasuredD20D50D90", () => {
  it("reconstructs a d10 that reproduces the d20 anchor's own sigma", () => {
    const psd = psdFromMeasuredD20D50D90(7.66, 22.8, 72.7);
    // 20% of the mass should read back as finer than the d20 anchor -
    // round-trips through the same fractionFinerThan/binDistribution
    // machinery the rest of the codebase uses.
    expect(fractionFinerThan(psd, 7.66)).toBeCloseTo(0.2, 1);
    expect(fractionFinerThan(psd, 22.8)).toBeCloseTo(0.5, 2);
  });
});

describe("foulingLoadForMembrane", () => {
  it("matches the retained-mass/fouling-load math assessPair uses, for a sand PSD at a 20um membrane", () => {
    const twentyUm = byPoreSize.get(20)!;
    const psd = psdForCharacter("sand");
    const { retainedMass, foulingLoad } = foulingLoadForMembrane(psd, twentyUm);
    expect(retainedMass).toBeGreaterThan(0);
    expect(retainedMass).toBeLessThan(1);
    expect(foulingLoad).toBeGreaterThan(0);
  });

  it("gives a finer membrane a higher retained mass than a coarser one, same PSD", () => {
    const psd = psdForCharacter("mixed_mineral");
    const fine = foulingLoadForMembrane(psd, byPoreSize.get(0.45)!).retainedMass;
    const coarse = foulingLoadForMembrane(psd, byPoreSize.get(20)!).retainedMass;
    expect(fine).toBeGreaterThan(coarse);
  });
});

describe("calibrateBaselines: real trial data, not synthetic", () => {
  const cal = calibrateBaselines(trials, byPoreSize);

  it("produces exactly one calibration, for the one pore size every trial actually used (5um)", () => {
    expect(cal.length).toBe(1);
    expect(cal[0].poreSizeUm).toBe(5);
  });

  it("is anchored on all 10 recorded trials, not a handful", () => {
    expect(cal[0].anchorTrialCount).toBe(10);
  });

  it("keeps kLow <= kMid <= kHigh, and all positive", () => {
    const c = cal[0];
    expect(c.kLow).toBeGreaterThan(0);
    expect(c.kLow).toBeLessThanOrEqual(c.kMid);
    expect(c.kMid).toBeLessThanOrEqual(c.kHigh);
  });

  it("the real spread (kHigh/kLow) is far tighter once concentration is accounted for than when it is ignored", () => {
    // Regression guard for the bug caught while building this: folding
    // concentration differences silently into the shape-only term made
    // kHigh/kLow blow out to ~9x. With concentration correctly paired via
    // untreatedConcentrationMgL, the real residual spread should be well
    // under that - a few times, not an order of magnitude.
    const c = cal[0];
    expect(c.kHigh / c.kLow).toBeLessThan(5);
  });
});

describe("predictBaselineVolume", () => {
  const cal = calibrateBaselines(trials, byPoreSize);
  const cal5 = cal.find((c) => c.poreSizeUm === 5);

  it("returns null - insufficient data - for a membrane no trial ever used", () => {
    const calForMissingPoreSize = undefined;
    const psd = psdForCharacter("sand");
    const { foulingLoad } = foulingLoadForMembrane(psd, byPoreSize.get(20)!);
    expect(predictBaselineVolume(calForMissingPoreSize, foulingLoad)).toBeNull();
  });

  it("gives a real range for the 5um membrane, with low < mid < high", () => {
    const psd = psdForCharacter("sand");
    const { foulingLoad } = foulingLoadForMembrane(psd, fiveUm);
    const range = predictBaselineVolume(cal5, foulingLoad);
    expect(range).not.toBeNull();
    expect(range!.lowMl).toBeLessThan(range!.midMl);
    expect(range!.midMl).toBeLessThan(range!.highMl);
  });

  it("gives a coarser (sandier) site a larger baseline volume than a finer (clay) one, same membrane", () => {
    // Coarser feed -> less of it is even retained by a 5um membrane in the
    // first place, and what is retained fouls less per gram (1/d^2) -> more
    // filterable volume before blinding.
    const sandRange = predictBaselineVolume(cal5, foulingLoadForMembrane(psdForCharacter("sand"), fiveUm).foulingLoad);
    const clayRange = predictBaselineVolume(cal5, foulingLoadForMembrane(psdForCharacter("clay"), fiveUm).foulingLoad);
    expect(sandRange!.midMl).toBeGreaterThan(clayRange!.midMl);
  });

  it("falls back to the calibration's own reference concentration when the site's concentration is unknown", () => {
    const psd = psdForCharacter("sand");
    const { foulingLoad } = foulingLoadForMembrane(psd, fiveUm);
    const withDefault = predictBaselineVolume(cal5, foulingLoad);
    const withExplicitSameValue = predictBaselineVolume(cal5, foulingLoad, cal5!.referenceConcentrationMgL);
    expect(withDefault).toEqual(withExplicitSameValue);
  });

  it("predicts a smaller volume at a higher assumed concentration, same PSD", () => {
    const psd = psdForCharacter("sand");
    const { foulingLoad } = foulingLoadForMembrane(psd, fiveUm);
    const lowC = predictBaselineVolume(cal5, foulingLoad, 500);
    const highC = predictBaselineVolume(cal5, foulingLoad, 5000);
    expect(highC!.midMl).toBeLessThan(lowC!.midMl);
  });
});
