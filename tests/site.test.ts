import { describe, expect, it } from "vitest";
import {
  ASSUMED_PSD_PROFILES,
  describeParticleCharacter,
  getSiteData,
  particleCharacterFromText,
  resolvePSD,
} from "@/lib/site";
import { geocodeProvider } from "@/lib/providers/geocode";
import { eaFloodProvider } from "@/lib/providers/ea-flood";
import { eaWaterQualityProvider } from "@/lib/providers/ea-water-quality";
import { localKnowledgeProvider } from "@/lib/providers/local-knowledge";
import { findCuratedSite } from "@/data/sites";

const CTX = { timeoutMs: 500, userAgent: "test" };

describe("curated knowledge", () => {
  it("matches a known site and returns only provenanced data", async () => {
    const f = await localKnowledgeProvider.getSiteData("Tilford, River Wey", CTX);
    expect(f.report.status).toBe("ok");
    expect(f.waterBody).toBe("River Wey");
    for (const d of f.data ?? []) {
      expect(d.provenance).toBeDefined();
      expect(d.confidence).toBeDefined();
    }
  });

  it("returns no_data rather than inventing an entry for an unknown site", async () => {
    const f = await localKnowledgeProvider.getSiteData("Somewhere Nobody Curated", CTX);
    expect(f.report.status).toBe("no_data");
    expect(f.data).toBeUndefined();
    expect(findCuratedSite("Somewhere Nobody Curated")).toBeUndefined();
  });
});

describe("providers degrade gracefully", () => {
  const failing: typeof fetch = async () => {
    throw new Error("network down");
  };

  it("geocoding failure does not throw and is reported", async () => {
    const f = await geocodeProvider.getSiteData("Tilford", { ...CTX, fetchImpl: failing });
    expect(f.report.status).toBe("error");
    expect(f.latitude).toBeUndefined();
  });

  it("coordinate-dependent providers skip themselves without coordinates", async () => {
    for (const p of [eaFloodProvider, eaWaterQualityProvider]) {
      const f = await p.getSiteData("Tilford", { ...CTX, fetchImpl: failing });
      expect(f.report.status).toBe("skipped");
      expect(f.data ?? []).toHaveLength(0);
    }
  });

  it("a provider that throws is caught and the whole lookup still succeeds", async () => {
    const site = await getSiteData("Tilford, River Wey", {
      enableRemote: true,
      timeoutMs: 300,
      fetchImpl: failing,
    });
    expect(site.query).toBe("Tilford, River Wey");
    expect(site.providerReports.some((r) => r.status === "error" || r.status === "skipped")).toBe(true);
    expect(site.unknowns.length).toBeGreaterThan(0);
  });
});

describe("offline lookup", () => {
  it("works with remote data disabled and records that it did", async () => {
    const site = await getSiteData("Tilford, River Wey", { enableRemote: false });
    expect(site.waterBody).toBe("River Wey");
    expect(site.providerReports.some((r) => r.providerId === "remote" && r.status === "skipped")).toBe(true);
    expect(site.unknowns.join(" ")).toMatch(/No live open-data lookup/);
  });

  it("always records the unknowns that matter for the assessment", async () => {
    const site = await getSiteData("Tilford, River Wey", { enableRemote: false });
    const joined = site.unknowns.join(" ");
    expect(joined).toMatch(/particle-size distribution/i);
    expect(joined).toMatch(/flow rate and available feed pressure/i);
  });
});

describe("free-text interpretation", () => {
  it("reads the solids character out of the user's own words", () => {
    expect(particleCharacterFromText("Water appears to contain mostly sand.")).toBe("sand");
    expect(particleCharacterFromText("Actually the particles are mostly clay")).toBe("clay");
    expect(particleCharacterFromText("lots of algae in summer")).toBe("organic");
    expect(particleCharacterFromText("it is a river")).toBeUndefined();
  });

  it("carries a user description into the site record as an inference, not a measurement", async () => {
    const site = await getSiteData("Tilford, River Wey", {
      enableRemote: false,
      userNotes: "Water appears to contain mostly sand.",
    });
    expect(site.particleCharacter).toBe("sand");
    expect(site.particleCharacterProvenance).toBe("inferred");
    const datum = site.data.find((d) => d.parameter.startsWith("Solids character"));
    expect(datum?.provenance).toBe("inferred");
    expect(site.assumptions.some((a) => a.id === "particle-character")).toBe(true);
  });

  it("describes each character in plain language", () => {
    for (const c of Object.keys(ASSUMED_PSD_PROFILES) as (keyof typeof ASSUMED_PSD_PROFILES)[]) {
      expect(describeParticleCharacter(c).length).toBeGreaterThan(10);
    }
  });
});

describe("PSD resolution priority", () => {
  it("prefers an override, then site data, then a labelled placeholder", async () => {
    const site = await getSiteData("Tilford, River Wey", { enableRemote: false });

    const placeholder = resolvePSD(site, undefined, "sand");
    expect(placeholder.isPlaceholder).toBe(true);
    expect(placeholder.psd.provenance).toBe("assumed");
    expect(placeholder.psd.verified).toBe(false);
    expect(placeholder.psd.source).toMatch(/SCREENING PLACEHOLDER/);

    const override = resolvePSD(site, { ...placeholder.psd, provenance: "measured", verified: true }, "sand");
    expect(override.isPlaceholder).toBe(false);
    expect(override.psd.provenance).toBe("measured");
  });

  it("orders the placeholder profiles so finer characters give finer distributions", () => {
    expect(ASSUMED_PSD_PROFILES.clay.d50Um).toBeLessThan(ASSUMED_PSD_PROFILES.silt.d50Um);
    expect(ASSUMED_PSD_PROFILES.silt.d50Um).toBeLessThan(ASSUMED_PSD_PROFILES.sand.d50Um);
  });

  it("marks every placeholder profile as unverified screening material", async () => {
    const site = await getSiteData("Tilford, River Wey", { enableRemote: false });
    for (const c of Object.keys(ASSUMED_PSD_PROFILES) as (keyof typeof ASSUMED_PSD_PROFILES)[]) {
      const { psd } = resolvePSD(site, undefined, c);
      expect(psd.provenance).toBe("assumed");
      expect(psd.confidence).toBe("low");
      expect(psd.verified).toBe(false);
    }
  });
});

describe("critical test case 2, via the site form", () => {
  it("picks a PSD out of the optional notes box and uses it instead of a placeholder", async () => {
    const site = await getSiteData("Tilford, River Wey", {
      enableRemote: false,
      userNotes: "I have a PSD:\nD10 = 2 µm\nD50 = 25 µm\nD90 = 150 µm\nMostly sand.",
    });

    expect(site.psd?.d50Um).toBe(25);
    expect(site.particleCharacter).toBe("sand");

    const { psd, isPlaceholder } = resolvePSD(site, undefined, undefined);
    expect(isPlaceholder).toBe(false);
    expect(psd.d50Um).toBe(25);
    expect(psd.verified).toBe(false); // supplied, not verified

    const datum = site.data.find((d) => d.parameter.startsWith("Particle-size distribution"));
    expect(datum?.provenance).toBe("measured");
    expect(datum?.confidence).toBe("medium");
  });

  it("does not invent a PSD when the notes contain none", async () => {
    const site = await getSiteData("Tilford, River Wey", {
      enableRemote: false,
      userNotes: "The water looks dirty after rain.",
    });
    expect(site.psd).toBeUndefined();
    expect(resolvePSD(site, undefined, undefined).isPlaceholder).toBe(true);
  });
});
