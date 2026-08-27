import { describe, expect, it } from "vitest";
import {
  analysePSD,
  cumulativePassingPercent,
  fractionAbovePercent,
  fractionBelowPercent,
  geometricStdDevOf,
  massFractionBetween,
  normCdf,
  normInv,
  parsePSDFromText,
  psdFromPercentiles,
  psdFromTable,
  psdVersusSizes,
  quantile,
  DEFAULT_GEOMETRIC_STD_DEV,
} from "@/lib/psd";

const percentilePSD = psdFromPercentiles({
  d10Um: 2,
  d50Um: 25,
  d90Um: 150,
  label: "test",
  provenance: "measured",
  confidence: "high",
  verified: true,
});

describe("statistical primitives", () => {
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

describe("percentile PSD", () => {
  it("reproduces the percentiles it was built from", () => {
    const stats = analysePSD(percentilePSD);
    // A single log-normal cannot pass through three arbitrary percentiles, so
    // the fit is anchored on D50 with the spread taken from D10 and D90.
    expect(stats.d50Um).toBeCloseTo(25, 3);
    expect(stats.d90Um / stats.d10Um).toBeCloseTo(150 / 2, 1);
  });

  it("derives the geometric standard deviation from D10 and D90", () => {
    const { value, assumed } = geometricStdDevOf(percentilePSD);
    expect(assumed).toBe(false);
    expect(value).toBeCloseTo(Math.exp(Math.log(150 / 2) / (2 * 1.2815515655)), 4);
  });

  it("falls back to the documented default spread when only D50 is known", () => {
    const psd = psdFromPercentiles({
      d50Um: 20,
      label: "d50 only",
      provenance: "assumed",
      confidence: "low",
    });
    const { value, assumed } = geometricStdDevOf(psd);
    expect(assumed).toBe(true);
    expect(value).toBe(DEFAULT_GEOMETRIC_STD_DEV);
    expect(analysePSD(psd).notes.join(" ")).toContain("geometric standard deviation");
  });

  it("above and below always sum to 100 %", () => {
    for (const size of [0.5, 1, 5, 25, 100, 500]) {
      expect(
        fractionAbovePercent(percentilePSD, size) + fractionBelowPercent(percentilePSD, size),
      ).toBeCloseTo(100, 6);
    }
  });

  it("cumulative passing increases monotonically with size", () => {
    let prev = -1;
    for (const size of [0.1, 1, 2, 5, 10, 25, 50, 100, 200, 500]) {
      const v = cumulativePassingPercent(percentilePSD, size);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("mass fractions across a partition sum to one", () => {
    const edges = [0.05, 1, 2, 5, 10, 20, 50, 100, 250, 3000];
    let total = 0;
    for (let i = 1; i < edges.length; i += 1) {
      total += massFractionBetween(percentilePSD, edges[i - 1], edges[i]);
    }
    expect(total).toBeGreaterThan(0.98);
    expect(total).toBeLessThanOrEqual(1.0001);
  });
});

describe("table PSD", () => {
  const table = psdFromTable(
    [
      { sizeUm: 1, cumulativePassingPercent: 5 },
      { sizeUm: 10, cumulativePassingPercent: 30 },
      { sizeUm: 50, cumulativePassingPercent: 70 },
      { sizeUm: 200, cumulativePassingPercent: 100 },
    ],
    { label: "measured table", provenance: "measured", confidence: "high", verified: true },
  );

  it("interpolates between tabulated points", () => {
    expect(cumulativePassingPercent(table, 1)).toBeCloseTo(5, 6);
    expect(cumulativePassingPercent(table, 50)).toBeCloseTo(70, 6);
    const mid = cumulativePassingPercent(table, 20);
    expect(mid).toBeGreaterThan(30);
    expect(mid).toBeLessThan(70);
  });

  it("clamps outside the tabulated range rather than extrapolating", () => {
    expect(cumulativePassingPercent(table, 0.01)).toBe(0);
    expect(cumulativePassingPercent(table, 5000)).toBe(100);
  });

  it("recovers quantiles from the table", () => {
    expect(quantile(table, 30)).toBeCloseTo(10, 3);
    expect(quantile(table, 70)).toBeCloseTo(50, 3);
  });
});

describe("free-text PSD parsing", () => {
  it("reads the second critical test case", () => {
    const psd = parsePSDFromText("D10 = 2 µm\nD50 = 25 µm\nD90 = 150 µm\nMostly sand.");
    expect(psd).toBeDefined();
    expect(psd?.d10Um).toBe(2);
    expect(psd?.d50Um).toBe(25);
    expect(psd?.d90Um).toBe(150);
    expect(psd?.verified).toBe(false);
  });

  it("handles the conversational phrasing", () => {
    const psd = parsePSDFromText("I have a PSD: D10 2 um, D50 25 um and D90 150 um");
    expect(psd?.d50Um).toBe(25);
  });

  it("returns undefined rather than inventing a distribution", () => {
    expect(parsePSDFromText("the water looks quite dirty today")).toBeUndefined();
    expect(parsePSDFromText("D10 = 2 µm")).toBeUndefined();
  });
});

describe("membrane comparison", () => {
  it("reports the percentage above and below each pore size", () => {
    const rows = psdVersusSizes(percentilePSD, [1, 10, 100]);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.abovePercent + r.belowPercent).toBeCloseTo(100, 1);
    }
    // Coarser ratings retain less.
    expect(rows[0].abovePercent).toBeGreaterThan(rows[2].abovePercent);
  });
});

describe("provenance propagation", () => {
  it("never claims a statistic is stronger than its input", () => {
    const assumed = psdFromPercentiles({
      d50Um: 20,
      label: "placeholder",
      provenance: "assumed",
      confidence: "low",
    });
    expect(analysePSD(assumed).provenance).toBe("assumed");
    expect(analysePSD(percentilePSD).provenance).toBe("calculated");
  });
});
