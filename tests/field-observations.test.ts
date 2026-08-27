import { describe, expect, it } from "vitest";
import { getSiteData } from "@/lib/site";
import { runScreening, getHydrocyclone, getMembraneOptions } from "@/lib/screening";
import {
  applyObservations,
  observationsForConfiguration,
  summariseObservations,
} from "@/lib/field-observations";
import { fieldObservations, findFieldObservations, FEED_WEIGHT } from "@/data/field-observations";
import type { FieldObservation, ScreeningReport } from "@/types";

const SITE = "Tilford, River Wey";

async function screen(site = SITE): Promise<ScreeningReport> {
  const siteData = await getSiteData(site, { enableRemote: false });
  return runScreening({ scenario: { siteQuery: site, siteData, changeLog: [] } });
}

describe("the observations file", () => {
  it("matches observations to a site and not to others", () => {
    expect(findFieldObservations(SITE).length).toBeGreaterThan(0);
    expect(findFieldObservations("River Aire, Leeds")).toHaveLength(0);
  });

  it("requires every observation to state what it does NOT establish", () => {
    for (const o of fieldObservations) {
      expect(o.doesNotDemonstrate.length).toBeGreaterThan(0);
      expect(o.demonstrates.length).toBeGreaterThan(0);
      expect(o.feed).toBeDefined();
    }
  });

  it("records the Tilford separation result with its feed qualified", () => {
    const o = findFieldObservations(SITE)[0];
    expect(o.kind).toBe("separation_confirmed");
    expect(o.feed).toBe("disturbed_bed_sediment");
    expect(o.hydrocycloneIds).toEqual(expect.arrayContaining(["4mm", "10mm"]));
    expect(o.provenance).toBe("measured");
    // It must not be allowed to imply a cut size.
    expect(o.doesNotDemonstrate.join(" ")).toMatch(/cut size/i);
  });

  it("weights a disturbed-bed feed below a natural one", () => {
    expect(FEED_WEIGHT.natural_suspended_load.transfersToDuty).toBe("high");
    expect(FEED_WEIGHT.disturbed_bed_sediment.transfersToDuty).toBe("partial");
    expect(FEED_WEIGHT.disturbed_bed_sediment.caveat).toMatch(/coarser|easiest duty/i);
  });
});

describe("observations reach the assessment", () => {
  it("attaches evidence to the cells of the units observed", async () => {
    const report = await screen();
    const withEvidence = report.matrix.filter((c) => c.fieldEvidence.length > 0);
    // Both units were observed, across every membrane rating.
    expect(withEvidence.length).toBe(report.matrix.length);
    expect(report.fieldObservations.length).toBeGreaterThan(0);
  });

  it("raises confidence one step, and never above medium", async () => {
    const observed = await screen();
    const bare = await screen("Somewhere with no records at all");

    const conf = (r: ScreeningReport) =>
      r.matrix.find((c) => c.hydrocycloneId === "10mm" && c.membraneId === "20um")!.confidence;

    expect(conf(bare)).toBe("low");
    expect(conf(observed)).toBe("medium");
    // Nothing reaches high on a qualitative field result.
    expect(observed.matrix.every((c) => c.confidence !== "high")).toBe(true);
  });

  it("states in the reasoning why confidence rose, and what the limit is", async () => {
    const report = await screen();
    const cell = report.matrix.find((c) => c.hydrocycloneId === "4mm" && c.membraneId === "10um")!;
    const prose = cell.reasoning.join(" ");
    expect(prose).toMatch(/Field observation at Tilford/i);
    expect(prose).toMatch(/observed separating solids|raised one step/i);
    expect(prose).toMatch(/capped at medium|grade-efficiency curve/i);
    // And the limits of the observation land in the limitations, not buried.
    expect(cell.limitations.join(" ")).toMatch(/does not establish/i);
  });

  it("carries the observation into the report narrative as something known", async () => {
    const report = await screen();
    expect(report.narrative.known.join(" ")).toMatch(/Observed at this site/i);
    expect(report.overall.summary).toMatch(/physically confirmed/i);
  });

  it("makes the next recommended test build on what was already seen", async () => {
    const report = await screen();
    expect(report.recommendedNextTests[0]).toMatch(/build directly on the separation/i);
    expect(report.recommendedNextTests[0]).toMatch(/undisturbed water|cut size/i);
  });

  it("does not let a field observation invent a cut size", async () => {
    const report = await screen();
    // Catalogue data is still an unverified placeholder despite the observation.
    for (const c of report.matrix) {
      expect(c.metrics.cutSizeProvenance).toBe("assumed");
    }
    expect(report.warnings.join(" ")).toMatch(/NOT verified/i);
  });
});

describe("negative observations count too", () => {
  it("weighs a blockage the same way as a success", async () => {
    const siteData = await getSiteData(SITE, { enableRemote: false });
    const negative: FieldObservation = {
      id: "neg",
      siteMatches: ["tilford"],
      siteName: "Tilford",
      kind: "blockage",
      feed: "natural_suspended_load",
      hydrocycloneIds: ["4mm"],
      observation: "The 4 mm unit bridged at the apex within twenty minutes.",
      demonstrates: ["The apex blocks on this feed at this concentration."],
      doesNotDemonstrate: ["Whether a larger apex would clear it."],
      provenance: "measured",
      confidence: "high",
    };

    const effect = applyObservations(
      "low",
      [negative],
      getHydrocyclone("4mm")!,
      getMembraneOptions(["10um"])[0],
    );
    expect(effect.lifted).toBe(true);
    expect(effect.reasoning.join(" ")).toMatch(/negative field result/i);
    expect(effect.reasoning.join(" ")).toMatch(/counts against/i);

    // It applies only to the unit it was recorded against.
    expect(
      observationsForConfiguration([negative], getHydrocyclone("10mm")!, getMembraneOptions(["10um"])[0]),
    ).toHaveLength(0);
    void siteData;
  });

  it("flags an observation with no recorded limits rather than over-reading it", () => {
    const sloppy: FieldObservation = {
      id: "sloppy",
      siteMatches: ["x"],
      siteName: "X",
      kind: "separation_confirmed",
      feed: "unknown",
      observation: "It worked.",
      demonstrates: [],
      doesNotDemonstrate: [],
      provenance: "measured",
      confidence: "low",
    };
    const effect = applyObservations(
      "low",
      [sloppy],
      getHydrocyclone("10mm")!,
      getMembraneOptions(["10um"])[0],
    );
    expect(effect.limitations.join(" ")).toMatch(/no recorded limits/i);
    expect(effect.reasoning.join(" ")).toMatch(/feed is not recorded/i);
  });

  it("summarises what is on record for the site banner", () => {
    expect(summariseObservations([])).toBeUndefined();
    const s = summariseObservations(findFieldObservations(SITE))!;
    expect(s).toMatch(/physically confirmed/i);
    expect(s).toMatch(/field-observations\.ts/);
  });
});
