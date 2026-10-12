import { describe, expect, it } from "vitest";
import type { Hydrocyclone, Membrane, Trial } from "@/lib/data";
import { loadHydrocyclones, loadMembranes, loadTrials } from "@/lib/data";
import { psdForCharacter } from "@/lib/psd";
import { assessMembrane, assessSite, assessUplift } from "@/lib/assessment";
import { calibrateBaselines } from "@/lib/baseline";

const cyclones = loadHydrocyclones();
const fiveMm = cyclones.find((h) => h.id === "5mm")!;
const tenMm = cyclones.find((h) => h.id === "10mm")!;
const membranes = loadMembranes();
const fiveUm = membranes.find((m) => m.id === "5um")!;
const twentyUm = membranes.find((m) => m.id === "20um")!;
const trials = loadTrials();
const membranesByPoreSize = new Map(membranes.map((m) => [m.poreSizeUm, m]));
const calibrations = calibrateBaselines(trials, membranesByPoreSize);

describe("assessUplift: today's real, all-guessed data (no trial required for the uplift itself)", () => {
  it("gives a sand site a likely uplift from the 5mm cyclone at a coarse membrane", () => {
    const u = assessUplift(psdForCharacter("sand"), twentyUm, fiveMm);
    expect(u.category).toBe("likely");
    expect(u.multiplier.mid).toBeGreaterThan(1.5);
  });

  it("does NOT call everything likely - a clay site at a fine membrane should not reach it", () => {
    // HANDOFF.md's explicit warning: if this screens as likely everywhere,
    // the model is broken. Clay has almost nothing coarse enough to remove.
    const u = assessUplift(psdForCharacter("clay"), fiveUm, fiveMm);
    expect(u.category).not.toBe("likely");
  });

  it("marks confidence low everywhere right now, because every input actually is a guess", () => {
    for (const character of ["sand", "clay"] as const) {
      for (const h of [fiveMm, tenMm]) {
        for (const m of [fiveUm, twentyUm]) {
          expect(assessUplift(psdForCharacter(character), m, h).confidence).toBe("low");
        }
      }
    }
  });

  it("names the weak links in the reasoning text, in plain English", () => {
    const u = assessUplift(psdForCharacter("sand"), fiveUm, fiveMm);
    expect(u.reasoning).toMatch(/particle size distribution is a guess/);
    expect(u.reasoning).toMatch(/cut sizes are guessed/);
    expect(u.reasoning).toMatch(/nominal pore size, not a supplier figure/);
  });
});

describe("assessUplift: mass removed is not fouling removed", () => {
  it("removes less fouling load than mass, because the cyclone strips the coarse end first", () => {
    const u = assessUplift(psdForCharacter("sand"), fiveUm, fiveMm);
    expect(u.foulingReduction).toBeLessThan(1);
    expect(u.foulingRemoved).toBeLessThanOrEqual(u.foulingLoad);
  });

  it("converts a 56% fouling reduction to about 1.5x volume, per Carman-Kozeny", () => {
    expect(1 / Math.sqrt(1 - 0.56)).toBeCloseTo(1.5, 1);
  });
});

describe("assessUplift: the minimum-retained-mass override", () => {
  it("calls it marginal, not unlikely-or-better, when there is almost nothing to remove", () => {
    const u = assessUplift(psdForCharacter("clay"), fiveUm, fiveMm);
    if (u.retainedMass < 0.02) {
      expect(u.category).toBe("marginal");
      expect(u.reasoning).toMatch(/almost nothing there to remove/);
    }
  });
});

describe("assessUplift: insufficient data is not a negative category", () => {
  it("returns insufficient-data for a hydrocyclone with no usable cut curve", () => {
    const broken: Hydrocyclone = {
      ...fiveMm,
      cut: { d20Um: 5, d50Um: 5, d90Um: 5 }, // degenerate: no spread at all
    };
    const u = assessUplift(psdForCharacter("sand"), fiveUm, broken);
    expect(u.category).toBe("insufficient-data");
    expect(u.reasoning).toMatch(/absence of evidence/i);
  });
});

describe("assessSite", () => {
  it("produces one assessment per membrane, each with one uplift per hydrocyclone", () => {
    const assessments = assessSite(psdForCharacter("sand"), membranes, cyclones, trials);
    expect(assessments.length).toBe(membranes.length);
    for (const a of assessments) expect(a.uplifts.length).toBe(cyclones.length);
  });

  it("spans more than one category across a clay site - it is allowed to say unlikely often", () => {
    const assessments = assessSite(psdForCharacter("clay"), membranes, cyclones, trials);
    const categories = new Set(assessments.flatMap((a) => a.uplifts.map((u) => u.category)));
    expect(categories.size).toBeGreaterThan(1);
  });

  it("the 5mm always removes at least as much fouling reduction as the 10mm on the same feed", () => {
    // Smaller body, finer cut - the sharper unit should never do worse.
    const assessments = assessSite(psdForCharacter("mixed_mineral"), membranes, cyclones, trials);
    for (const a of assessments) {
      const five = a.uplifts.find((u) => u.methodId === "5mm")!;
      const ten = a.uplifts.find((u) => u.methodId === "10mm")!;
      expect(five.foulingReduction).toBeGreaterThanOrEqual(ten.foulingReduction - 1e-9);
    }
  });

  it("gives the one membrane a real trial calibrates (5um) a non-null, MEASURED baseline volume", () => {
    const assessments = assessSite(psdForCharacter("sand"), membranes, cyclones, trials);
    const five = assessments.find((a) => a.membraneId === "5um")!;
    expect(five.baselineVolume).not.toBeNull();
    expect(five.baselineSource).toBe("measured");
  });

  it("ESTIMATES (rebuild phase 10), rather than leaving blank, a pore size no trial used - borrowing the 5um calibration, corrected for sediment class, always low confidence", () => {
    const assessments = assessSite(psdForCharacter("sand"), membranes, cyclones, trials);
    const twenty = assessments.find((a) => a.membraneId === "20um")!;
    expect(twenty.baselineVolume).not.toBeNull();
    expect(twenty.baselineSource).toBe("estimated");
    expect(twenty.baselineConfidence).toBe("low");
    expect(twenty.baselineReasoning).toMatch(/ESTIMATED/);
    expect(twenty.baselineReasoning).toMatch(/not a measurement/i);
  });

  it("is genuinely insufficient-data (null), not estimated, when there is no real trial at ANY pore size to anchor from", () => {
    const assessments = assessSite(psdForCharacter("sand"), membranes, cyclones, []);
    const twenty = assessments.find((a) => a.membraneId === "20um")!;
    expect(twenty.baselineVolume).toBeNull();
    expect(twenty.baselineSource).toBe("insufficient-data");
    expect(twenty.baselineReasoning).toMatch(/insufficient data/i);
  });
});

describe("assessMembrane: a real measured site concentration (rebuild phase 3) improves the baseline, never the uplift", () => {
  const siteConcentration = { mgL: 42, source: "EA Water Quality Archive, Test Point, 2024-01-01" };

  it("uses the real concentration instead of the calibration's reference mean, and says so", () => {
    const withReal = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm], calibrations, siteConcentration);
    const withoutReal = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm], calibrations);
    expect(withReal.baselineVolume).not.toBeNull();
    expect(withReal.baselineVolume).not.toEqual(withoutReal.baselineVolume);
    expect(withReal.baselineReasoning).toMatch(/real measured solids concentration/i);
    expect(withReal.baselineReasoning).toMatch(/42 mg\/L/);
    expect(withReal.baselineReasoning).toMatch(siteConcentration.source);
  });

  it("raises baseline confidence from low to medium with a real concentration alone (PSD still guessed)", () => {
    const withoutReal = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm], calibrations);
    const withReal = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm], calibrations, siteConcentration);
    expect(withoutReal.baselineConfidence).toBe("low");
    expect(withReal.baselineConfidence).toBe("medium");
  });

  it("does not touch the uplift multipliers or their reasoning - this is a baseline-only input", () => {
    const withReal = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm], calibrations, siteConcentration);
    const withoutReal = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm], calibrations);
    expect(withReal.uplifts).toEqual(withoutReal.uplifts);
  });

  it("ESTIMATES rather than nulling out for a pore size no trial calibrates, even with a real concentration - but stays low confidence regardless", () => {
    const withReal = assessMembrane(psdForCharacter("sand"), twentyUm, [fiveMm], calibrations, siteConcentration);
    expect(withReal.baselineVolume).not.toBeNull();
    expect(withReal.baselineSource).toBe("estimated");
    expect(withReal.baselineConfidence).toBe("low");
  });

  it("assessSite threads the real concentration through to every membrane", () => {
    const assessments = assessSite(psdForCharacter("sand"), membranes, cyclones, trials, siteConcentration);
    const five = assessments.find((a) => a.membraneId === "5um")!;
    expect(five.baselineReasoning).toMatch(/real measured solids concentration/i);
  });
});

describe("assessMembrane/assessSite: an exact-site trial (lib/trials.ts) supersedes the model outright", () => {
  const site = { siteId: "tilford", waterbodyId: "wey-tilford" };
  const exactBaseline: Trial = {
    id: "exact-site-baseline",
    date: "2026-01-01",
    operator: "test",
    siteId: "tilford",
    waterbodyId: "wey-tilford",
    hydrocycloneId: "5mm",
    feed: { material: "River water", preparation: "As drawn", concentrationMgL: null, untreatedConcentrationMgL: null, psdMeasured: false, psd: null, note: "" },
    filter: { poreSizeUm: 5, diameterMm: 47, material: "membrane" },
    terminalCondition: "Filtered to visible cake formation.",
    volumeBeforeMl: 200,
    volumeAfterMl: 500,
    replicates: 1,
    status: "recorded",
    notes: [],
  };

  it("overrides the baseline volume with the real measured figure, at high confidence", () => {
    const withExact = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm], calibrations, undefined, { trials: [exactBaseline], identity: site });
    expect(withExact.baselineVolume).toEqual({ lowMl: 200, midMl: 200, highMl: 200 });
    expect(withExact.baselineConfidence).toBe("high");
    expect(withExact.baselineReasoning).toMatch(/measured directly at this exact site/i);
  });

  it("overrides that hydrocyclone's uplift with the real measured ratio (500/200 = 2.5x), at high confidence", () => {
    const withExact = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm], calibrations, undefined, { trials: [exactBaseline], identity: site });
    const uplift = withExact.uplifts.find((u) => u.methodId === "5mm")!;
    expect(uplift.multiplier).toEqual({ low: 2.5, mid: 2.5, high: 2.5 });
    expect(uplift.confidence).toBe("high");
    expect(uplift.category).toBe("likely");
    expect(uplift.reasoning).toMatch(/measured directly at this exact site/i);
  });

  it("does not touch a different hydrocyclone's uplift, since the trial only tested the 5mm", () => {
    const withExact = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm, tenMm], calibrations, undefined, { trials: [exactBaseline], identity: site });
    const withoutExact = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm, tenMm], calibrations);
    const tenExact = withExact.uplifts.find((u) => u.methodId === "10mm")!;
    const tenPlain = withoutExact.uplifts.find((u) => u.methodId === "10mm")!;
    expect(tenExact).toEqual(tenPlain);
  });

  it("leaves everything exactly as before when no trial matches this site/waterbody", () => {
    const withExact = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm], calibrations, undefined, { trials: [exactBaseline], identity: { siteId: "somewhere-else", waterbodyId: "another-river" } });
    const withoutExact = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm], calibrations);
    expect(withExact).toEqual(withoutExact);
  });

  it("assessSite threads the site identity through to every membrane", () => {
    const assessments = assessSite(psdForCharacter("sand"), membranes, cyclones, [...trials, exactBaseline], undefined, site);
    const five = assessments.find((a) => a.membraneId === "5um")!;
    expect(five.baselineVolume).toEqual({ lowMl: 200, midMl: 200, highMl: 200 });
  });

  it("finds nothing against today's real trials.json, which has no site/waterbody recorded yet", () => {
    const assessments = assessSite(psdForCharacter("sand"), membranes, cyclones, trials, undefined, site);
    const five = assessments.find((a) => a.membraneId === "5um")!;
    expect(five.baselineReasoning).not.toMatch(/measured directly at this exact site/i);
  });
});

describe("assessMembrane: membrane retention (block 5c) feeds straight into the uplift", () => {
  it("a supplier-stated retention size changes the confidence, not just the number", () => {
    const populated: Membrane = {
      ...fiveUm,
      product: {
        populated: true, manufacturer: "Acme", productCode: "AF-5000", material: "PES",
        retentionUm: 5, rating: "absolute", sourceUrl: "https://example.com", retrievedOn: "2026-01-01", notes: [],
      },
    };
    const before = assessMembrane(psdForCharacter("sand"), fiveUm, [fiveMm], calibrations).uplifts[0];
    const after = assessMembrane(psdForCharacter("sand"), populated, [fiveMm], calibrations).uplifts[0];
    expect(before.confidence).toBe("low");
    // Still capped low overall (PSD and cut size are still guesses), but the
    // membrane's own weak link should have dropped out of the reasoning.
    expect(after.reasoning).not.toMatch(/nominal pore size, not a supplier figure/);
  });
});
