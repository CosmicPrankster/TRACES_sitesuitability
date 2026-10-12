import { describe, expect, it } from "vitest";
import type { Trial } from "@/lib/data";
import { loadHydrocyclones, loadMembranes, loadTrials } from "@/lib/data";
import { buildBenchValidationEntries, validateTrial } from "@/lib/validation";

const trials = loadTrials();
const membranes = loadMembranes();
const hydrocyclones = loadHydrocyclones();

describe("validateTrial: leave-one-out against today's real 10 bench trials", () => {
  it("validates the single-pass 0.5 g/L trial against every OTHER real trial, never itself", () => {
    const trial = trials.find((t) => t.id === "aquarium-soil-bench-001")!;
    const entry = validateTrial(trial, trials, membranes, hydrocyclones)!;
    expect(entry.trialId).toBe("aquarium-soil-bench-001");
    expect(entry.membraneId).toBe("5um");
    expect(entry.observedBaselineMl).toBeCloseTo(457.333, 2);
    expect(entry.observedUpliftMultiplier).toBeCloseTo(4.293, 2);
    // A real prediction exists - 9 other real trials at the same 5um pore size remain to calibrate from.
    expect(entry.predictedBaselineMl).not.toBeNull();
    expect(entry.predictedUpliftMultiplier).not.toBeNull();
    expect(entry.baselineWithinPredictedRange).not.toBeNull();
    expect(entry.upliftWithinPredictedRange).not.toBeNull();
  });

  it("the leave-one-out calibration never includes the trial being validated", () => {
    // Direct check of the "never circular" claim: calibrating from all 10
    // trials and calibrating from the other 9 must give a different kMid.
    const trial = trials.find((t) => t.id === "aquarium-soil-bench-001")!;
    const entry = validateTrial(trial, trials, membranes, hydrocyclones)!;
    const entryIfCircular = validateTrial(trial, [trial], membranes, hydrocyclones);
    // With only itself in the pool, leave-one-out has nothing left to
    // calibrate from - insufficient data, not a (circular) perfect match.
    expect(entryIfCircular!.predictedBaselineMl).toBeNull();
    expect(entry.predictedBaselineMl).not.toBeNull();
  });

  it("returns null for a trial still awaiting data", () => {
    const pending: Trial = { ...trials[0], status: "awaiting-data", volumeBeforeMl: null, volumeAfterMl: null };
    expect(validateTrial(pending, trials, membranes, hydrocyclones)).toBeNull();
  });

  it("returns null for a trial with no measured feed PSD", () => {
    const noPsd: Trial = { ...trials[0], feed: { ...trials[0].feed, psd: null } };
    expect(validateTrial(noPsd, trials, membranes, hydrocyclones)).toBeNull();
  });

  it("returns null for a pore size with no membrane on record", () => {
    const oddPoreSize: Trial = { ...trials[0], filter: { ...trials[0].filter, poreSizeUm: 999 } };
    expect(validateTrial(oddPoreSize, trials, membranes, hydrocyclones)).toBeNull();
  });

  it("notes, rather than silently skips, a hydrocyclone id missing from data/hydrocyclones.json", () => {
    const unknownHydrocyclone: Trial = { ...trials[0], hydrocycloneId: "99mm-does-not-exist" };
    const entry = validateTrial(unknownHydrocyclone, trials, membranes, hydrocyclones)!;
    expect(entry.predictedUpliftMultiplier).toBeNull();
    expect(entry.upliftWithinPredictedRange).toBeNull();
    expect(entry.note).toMatch(/not in data\/hydrocyclones\.json/i);
    // The baseline side is independent of the hydrocyclone and still checkable.
    expect(entry.predictedBaselineMl).not.toBeNull();
  });
});

describe("buildBenchValidationEntries", () => {
  it("produces one entry per real recorded trial - all 10 are checkable", () => {
    const entries = buildBenchValidationEntries(trials, membranes, hydrocyclones);
    expect(entries.length).toBe(trials.length);
    expect(entries.every((e) => e.kind === "bench-validation")).toBe(true);
  });

  it("every real trial's observed baseline and uplift are checkable against a real leave-one-out prediction", () => {
    // Not asserting every one falls WITHIN its predicted range - that's an
    // honest empirical question this project should be able to answer no
    // either way (HANDOFF rule 6: insufficient/negative are real outcomes).
    // What's asserted is that a prediction and a real check exist for all 10.
    const entries = buildBenchValidationEntries(trials, membranes, hydrocyclones);
    for (const e of entries) {
      expect(e.predictedBaselineMl, e.trialId).not.toBeNull();
      expect(e.baselineWithinPredictedRange, e.trialId).not.toBeNull();
      expect(e.predictedUpliftMultiplier, e.trialId).not.toBeNull();
      expect(e.upliftWithinPredictedRange, e.trialId).not.toBeNull();
    }
  });
});
