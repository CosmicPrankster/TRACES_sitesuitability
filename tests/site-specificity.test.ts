import { describe, expect, it } from "vitest";
import { getSiteData, waterBodyTypeFromText } from "@/lib/site";
import { runScreening } from "@/lib/screening";
import type { ScreeningReport, SiteData, SiteDatum } from "@/types";

/**
 * Regression tests for the defect where every site returned an identical
 * matrix: the providers gathered site evidence, the report displayed it, and
 * none of it ever reached the assessment. A constant was being presented as an
 * analysis.
 */

async function screen(site: string, notes?: string): Promise<ScreeningReport> {
  const siteData = await getSiteData(site, { enableRemote: false, userNotes: notes });
  return runScreening({
    scenario: { siteQuery: site, userNotes: notes, siteData, changeLog: [] },
  });
}

const signature = (r: ScreeningReport) => r.matrix.map((c) => c.classification).join("|");

describe("site evidence reaches the assessment", () => {
  it("does not return the same matrix for materially different sites", async () => {
    const tilford = await screen("Tilford, River Wey"); // curated: sand, from geology
    const loch = await screen("Loch Ness, Scotland"); // standing water: fines dominate
    const estuary = await screen("Southampton Water estuary"); // cohesive fines

    const sigs = [signature(tilford), signature(loch), signature(estuary)];
    expect(new Set(sigs).size).toBe(3);

    // And the distributions behind them differ, which is why the matrices do.
    const d50s = [tilford, loch, estuary].map((r) => r.psdStatistics!.d50Um);
    expect(new Set(d50s).size).toBe(3);
    // Coarsest at the sand-bed river, finest in the estuary.
    expect(d50s[0]).toBeGreaterThan(d50s[1]);
    expect(d50s[1]).toBeGreaterThan(d50s[2]);
  });

  it("reads the water body type out of the user's own words", () => {
    expect(waterBodyTypeFromText("Loch Ness")).toBe("lake_reservoir");
    expect(waterBodyTypeFromText("Chalk borehole, Hampshire")).toBe("groundwater");
    expect(waterBodyTypeFromText("Southampton Water estuary")).toBe("estuary_coastal");
    expect(waterBodyTypeFromText("River Thames at Oxford")).toBe("river");
    expect(waterBodyTypeFromText("somewhere unspecified")).toBeUndefined();
  });

  it("drives the solids character from archived turbidity and suspended solids", async () => {
    // A fines-dominated signature: high turbidity per unit mass.
    const fine = await getSiteData("Nowhere in particular", { enableRemote: false });
    const coarse = await getSiteData("Nowhere in particular", { enableRemote: false });

    const datum = (parameter: string, value: number): SiteDatum => ({
      parameter,
      value,
      provenance: "measured",
      confidence: "medium",
      source: "test",
    });

    const rebuild = async (ss: number, turb: number): Promise<SiteData> => {
      const site = await getSiteData("Nowhere in particular", { enableRemote: false });
      site.data.push(
        datum("Suspended solids (dried at 105 C) - median of 20 archived samples", ss),
        datum("Turbidity - median of 20 archived samples", turb),
      );
      site.particleCharacter = "unknown";
      const { finaliseSite } = await import("@/lib/site");
      return finaliseSite(site);
    };

    const fines = await rebuild(10, 60); // ratio 6.0 -> fine dominated
    const mixed = await rebuild(50, 25); // ratio 0.5 -> coarser

    expect(fines.particleCharacter).toBe("silt");
    expect(mixed.particleCharacter).toBe("mixed_mineral");
    expect(fines.particleCharacterProvenance).toBe("inferred");
    expect(fines.particleCharacterBasis).toMatch(/NTU per mg\/L/);
    void fine;
    void coarse;
  });

  it("records what drove the solids character, always", async () => {
    for (const s of ["Tilford, River Wey", "Loch Ness", "asdfghjkl nonsense"]) {
      const site = await getSiteData(s, { enableRemote: false });
      expect(site.particleCharacterBasis.length).toBeGreaterThan(40);
    }
  });
});

describe("honesty when nothing is known about the site", () => {
  it("flags a result that is not site-specific", async () => {
    const report = await screen("asdfghjkl nonsense place");

    expect(report.siteData.siteSpecific).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/NOT SITE-SPECIFIC/);
    expect(report.overall.summary).toMatch(/default result, not an assessment of this site/i);
    expect(report.unknowns[0]).toMatch(/identical for any other location/i);
  });

  it("does not flag a site the application does know something about", async () => {
    const report = await screen("Tilford, River Wey");
    expect(report.siteData.siteSpecific).toBe(true);
    expect(report.warnings.join(" ")).not.toMatch(/NOT SITE-SPECIFIC/);
    // A field observation is on record here, so it - not the geology inference -
    // is what sets the character, and its provenance is a measurement.
    expect(report.siteData.particleCharacterProvenance).toBe("measured");
    expect(report.siteData.particleCharacterBasis).toMatch(/field observation/i);
    // And the basis states the qualifier that matters: it was bed material.
    expect(report.siteData.particleCharacterBasis).toMatch(/bed material|disturbed bed/i);
  });

  it("becomes site-specific as soon as the user describes the water", async () => {
    const bare = await screen("asdfghjkl nonsense place");
    const told = await screen("asdfghjkl nonsense place", "the water is mostly clay");

    expect(bare.siteData.siteSpecific).toBe(false);
    expect(told.siteData.siteSpecific).toBe(true);
    expect(signature(bare)).not.toBe(signature(told));
    expect(told.siteData.particleCharacterBasis).toMatch(/Stated by the user/i);
  });
});

describe("regression: a river name must not suppress the warning", () => {
  it("does not count knowing the river's name as site-specific", async () => {
    // The real-world case: the EA returns a river and catchment, but no
    // determinands. Nothing about the particle population is known, so the
    // matrix is still the default and must still say so.
    const site = await getSiteData("River Severn, Shrewsbury", { enableRemote: false });
    site.data.push({
      parameter: "River",
      value: "Severn",
      provenance: "published",
      confidence: "high",
      source: "EA station record",
    });
    site.waterBody = "Severn";
    const { finaliseSite } = await import("@/lib/site");
    finaliseSite(site);

    expect(site.particleCharacter).toBe("unknown");
    expect(site.siteSpecific).toBe(false);

    const report = runScreening({
      scenario: { siteQuery: "River Severn, Shrewsbury", siteData: site, changeLog: [] },
    });
    expect(report.warnings.join(" ")).toMatch(/NOT SITE-SPECIFIC/);
  });

  it("refuses to invent a character for a river, since geology is what would settle it", async () => {
    const a = await getSiteData("River Thames, Oxford", { enableRemote: false });
    const b = await getSiteData("River Aire, Leeds", { enableRemote: false });
    // Both unknown - and both loudly flagged, rather than quietly given the
    // same fabricated "mixed mineral" character.
    expect(a.particleCharacter).toBe("unknown");
    expect(b.particleCharacter).toBe("unknown");
    expect(a.siteSpecific).toBe(false);
    expect(b.siteSpecific).toBe(false);
  });

  it("one stated character makes the result site-specific and changes the matrix", async () => {
    const bare = await getSiteData("River Severn, Shrewsbury", { enableRemote: false });
    const bareReport = runScreening({
      scenario: { siteQuery: "x", siteData: bare, changeLog: [] },
    });

    const told = await getSiteData("River Severn, Shrewsbury", { enableRemote: false });
    const toldReport = runScreening({
      scenario: {
        siteQuery: "x",
        siteData: told,
        particleCharacterOverride: "sand",
        changeLog: [],
      },
    });

    expect(signature(bareReport)).not.toBe(signature(toldReport));
  });
});
