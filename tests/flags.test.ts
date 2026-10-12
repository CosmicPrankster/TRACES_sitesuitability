import { describe, expect, it } from "vitest";
import { assessAlgaeRisk, assessInhibitionRisk, assessSiteFlags } from "@/lib/flags";
import { isPeat } from "@/lib/geology";

describe("isPeat", () => {
  it("matches real BGS peat descriptions", () => {
    expect(isPeat("Peat")).toBe(true);
    expect(isPeat("Peat, Devensian - Holocene")).toBe(true);
  });

  it("does not match unrelated lithologies", () => {
    expect(isPeat("Sandstone")).toBe(false);
    expect(isPeat(null)).toBe(false);
  });
});

describe("assessAlgaeRisk: nutrient enrichment vs. being in season are separate facts", () => {
  it("flags elevated for a heavily arable catchment (the real Motray's own cropland figure)", () => {
    const r = assessAlgaeRisk({ cropland: 0.5679, builtUp: 0.0181 }, new Date("2026-07-15"));
    expect(r.risk).toBe("elevated");
    expect(r.reasoning).toMatch(/57% arable/);
  });

  it("flags elevated for a heavily built-up catchment even with low cropland", () => {
    const r = assessAlgaeRisk({ cropland: 0.05, builtUp: 0.4 }, new Date("2026-07-15"));
    expect(r.risk).toBe("elevated");
    expect(r.reasoning).toMatch(/40% built up/);
  });

  it("flags low for the real Wey at Tilford's own figures - permeable, not especially enriched", () => {
    const r = assessAlgaeRisk({ cropland: 0.2614, builtUp: 0.123 }, new Date("2026-07-15"));
    expect(r.risk).toBe("low");
  });

  it("says in-season during a real UK summer month, out of season in winter - same catchment, same risk level", () => {
    const summer = assessAlgaeRisk({ cropland: 0.6, builtUp: 0 }, new Date("2026-07-15"));
    const winter = assessAlgaeRisk({ cropland: 0.6, builtUp: 0 }, new Date("2026-01-15"));
    expect(summer.risk).toBe("elevated");
    expect(winter.risk).toBe("elevated");
    expect(summer.inSeason).toBe(true);
    expect(winter.inSeason).toBe(false);
    expect(summer.reasoning).toMatch(/live now/);
    expect(winter.reasoning).toMatch(/unlikely to be active right now/);
  });

  it("never blends into a mineral-character verdict - returns insufficient-data, not a guessed low, with no catchment data", () => {
    const r = assessAlgaeRisk(null);
    expect(r.risk).toBe("insufficient-data");
    expect(r.reasoning).toMatch(/insufficient data/i);
  });

  it("treats an explicit zero cropland/builtUp as real data, not absence of data", () => {
    const r = assessAlgaeRisk({ cropland: 0, builtUp: 0 });
    expect(r.risk).toBe("low");
  });
});

describe("assessInhibitionRisk: peat is read honestly, never conflated with a DOC measurement", () => {
  it("flags elevated for real peat superficial deposits", () => {
    const r = assessInhibitionRisk({ bedrock: "Mudstone", superficial: "Peat" });
    expect(r.risk).toBe("elevated");
    expect(r.reasoning).toMatch(/at the surface/);
    expect(r.reasoning).toMatch(/not a dissolved-organic-carbon measurement/);
  });

  it("flags elevated for peat named only in the bedrock record", () => {
    const r = assessInhibitionRisk({ bedrock: "Peat", superficial: null });
    expect(r.risk).toBe("elevated");
    expect(r.reasoning).toMatch(/in the bedrock record/);
  });

  it("flags low for real non-peat geology (the real Wey's sandstone)", () => {
    const r = assessInhibitionRisk({ bedrock: "Sandstone", superficial: "Alluvium" });
    expect(r.risk).toBe("low");
  });

  it("returns insufficient-data, not a guessed low, when no geology was checked at all", () => {
    const r = assessInhibitionRisk({ bedrock: null, superficial: null });
    expect(r.risk).toBe("insufficient-data");
  });
});

describe("assessSiteFlags: both flags are independent of each other and of the mineral score", () => {
  it("can be elevated on one axis and low on the other at the same site", () => {
    const flags = assessSiteFlags({ cropland: 0.6, builtUp: 0 }, { bedrock: "Sandstone", superficial: "Alluvium" }, new Date("2026-07-01"));
    expect(flags.algae.risk).toBe("elevated");
    expect(flags.inhibition.risk).toBe("low");
  });

  it("can be insufficient-data on one axis while the other has real data", () => {
    const flags = assessSiteFlags(null, { bedrock: "Peat", superficial: null });
    expect(flags.algae.risk).toBe("insufficient-data");
    expect(flags.inhibition.risk).toBe("elevated");
  });
});
