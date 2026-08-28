import { describe, expect, it } from "vitest";
import {
  describeCharacter,
  fromNrfaRecord,
  hasEnoughToInfer,
  inferCharacter,
  type CatchmentProperties,
} from "@/lib/character";

/**
 * Fixtures are the REAL NRFA records returned by the probe for the two test
 * sites. Nothing here is invented.
 */

/** NRFA 39011, Wey at Tilford. Greensand catchment, groundwater-fed. */
const WEY_AT_TILFORD = {
  id: 39011,
  name: "Wey at Tilford",
  "catchment-area": 396.3,
  "high-perm-bedrock": 0.7778,
  "moderate-perm-bedrock": 0.0926,
  "low-perm-bedrock": 0.0001,
  "mixed-perm-bedrock": 0.1295,
  "high-perm-superficial": 0.0391,
  "low-perm-superficial": 0.1831,
  "mixed-perm-superficial": 0.0002,
  bfihost: 0.795,
  bfihost19: 0.773,
  "lcm2023-cropland": 0.2614,
  "lcm2023-built-up-areas": 0.123,
  "saar-1991-2020": 929,
};

/** NRFA 14005, Motray Water at St Michaels. Impermeable, heavily arable. */
const MOTRAY_AT_ST_MICHAELS = {
  id: 14005,
  name: "Motray Water at St Michaels",
  "catchment-area": 60,
  "high-perm-bedrock": null,
  "moderate-perm-bedrock": 0.2624,
  "low-perm-bedrock": 0.7376,
  "mixed-perm-bedrock": null,
  "high-perm-superficial": 0.2623,
  "low-perm-superficial": null,
  "mixed-perm-superficial": 0.4054,
  bfihost: 0.634,
  bfihost19: 0.573,
  "lcm2023-cropland": 0.5679,
  "lcm2023-built-up-areas": 0.0181,
  "saar-1991-2020": 754,
};

describe("mapping a real NRFA record", () => {
  it("reads the Tilford record without loss", () => {
    const p = fromNrfaRecord(WEY_AT_TILFORD);
    expect(p.stationId).toBe(39011);
    expect(p.highPermBedrock).toBeCloseTo(0.7778, 4);
    expect(p.bfihost).toBeCloseTo(0.773, 3); // prefers bfihost19
    expect(p.cropland).toBeCloseTo(0.2614, 4);
    expect(p.catchmentAreaKm2).toBe(396.3);
  });

  it("treats NRFA's nulls as absent, not as zero-confidence", () => {
    const p = fromNrfaRecord(MOTRAY_AT_ST_MICHAELS);
    expect(p.highPermBedrock).toBeNull();
    expect(p.lowPermBedrock).toBeCloseTo(0.7376, 4);
  });
});

describe("the two real sites come out differently", () => {
  const wey = inferCharacter(fromNrfaRecord(WEY_AT_TILFORD))!;
  const motray = inferCharacter(fromNrfaRecord(MOTRAY_AT_ST_MICHAELS))!;

  it("infers a coarser load for the Greensand, groundwater-fed Wey", () => {
    expect(["sand", "mixed_mineral"]).toContain(wey.character);
  });

  it("infers a finer load for the impermeable, heavily arable Motray", () => {
    expect(["silt", "clay"]).toContain(motray.character);
  });

  it("does not give the same answer for both, which was the old failure", () => {
    expect(wey.character).not.toBe(motray.character);
  });

  it("cites the permeable bedrock for the Wey", () => {
    const prose = wey.reasoning.join(" ");
    expect(prose).toMatch(/high-permeability bedrock/i);
    expect(prose).toMatch(/sandstone, chalk or greensand/i);
    expect(prose).toMatch(/base flow index of 0\.77/);
  });

  it("cites both the impermeable bedrock and the arable land for the Motray", () => {
    const prose = motray.reasoning.join(" ");
    expect(prose).toMatch(/low-permeability bedrock/i);
    expect(prose).toMatch(/57 % of the catchment is arable/i);
  });

  it("never claims to have measured anything", () => {
    for (const r of [wey, motray]) {
      expect(r.confidence).not.toBe("high");
      expect(r.reasoning.join(" ")).toMatch(/inferred from catchment properties, not measured/i);
    }
  });

  it("names what would overturn the inference", () => {
    for (const r of [wey, motray]) {
      expect(r.wouldChangeThis.join(" ")).toMatch(/particle-size distribution/i);
      expect(r.wouldChangeThis.join(" ")).toMatch(/settle-bottle/i);
    }
  });

  it("keeps an evidence trail of the numbers it used", () => {
    expect(wey.evidence.map((e) => e.field)).toContain("high-perm-bedrock");
    expect(wey.evidence.map((e) => e.field)).toContain("bfihost");
    expect(motray.evidence.map((e) => e.field)).toContain("low-perm-bedrock");
    expect(motray.evidence.map((e) => e.field)).toContain("cropland");
  });
});

describe("the drivers behave as the physics says they should", () => {
  const base: CatchmentProperties = { highPermBedrock: 1, bfihost: 0.8 };

  it("permeable bedrock gives a coarser answer than impermeable", () => {
    const permeable = inferCharacter({ highPermBedrock: 1, bfihost: 0.6 })!;
    const impermeable = inferCharacter({ lowPermBedrock: 1, bfihost: 0.6 })!;
    const order = ["clay", "silt", "mixed_mineral", "sand"];
    expect(order.indexOf(permeable.character)).toBeGreaterThan(order.indexOf(impermeable.character));
  });

  it("heavy arable shifts a permeable catchment finer", () => {
    const clean = inferCharacter({ ...base })!;
    const arable = inferCharacter({ ...base, cropland: 0.7 })!;
    const order = ["clay", "silt", "mixed_mineral", "sand"];
    expect(order.indexOf(arable.character)).toBeLessThanOrEqual(order.indexOf(clean.character));
  });

  it("a low base flow index shifts the answer finer", () => {
    const stable = inferCharacter({ moderatePermBedrock: 1, bfihost: 0.85 })!;
    const flashy = inferCharacter({ moderatePermBedrock: 1, bfihost: 0.3 })!;
    const order = ["clay", "silt", "mixed_mineral", "sand"];
    expect(order.indexOf(flashy.character)).toBeLessThan(order.indexOf(stable.character));
  });

  it("raises confidence only when bedrock and base flow agree", () => {
    const agreeing = inferCharacter({ highPermBedrock: 1, bfihost: 0.8 })!;
    const conflicting = inferCharacter({ highPermBedrock: 1, bfihost: 0.3 })!;
    expect(agreeing.confidence).toBe("medium");
    expect(conflicting.confidence).toBe("low");
  });
});

describe("refusing to guess", () => {
  it("returns null when there is nothing to reason from", () => {
    expect(inferCharacter({})).toBeNull();
    expect(inferCharacter({ catchmentAreaKm2: 100, saarMm: 800 })).toBeNull();
    expect(hasEnoughToInfer({})).toBe(false);
  });

  it("will infer from base flow index alone, saying so", () => {
    const r = inferCharacter({ bfihost: 0.85 });
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe("low");
  });

  it("describes every character in plain language", () => {
    for (const ch of ["sand", "mixed_mineral", "silt", "clay"] as const) {
      expect(describeCharacter(ch).length).toBeGreaterThan(15);
    }
  });
});

describe("geology corroboration", () => {
  const WEY = {
    "high-perm-bedrock": 0.7778, "moderate-perm-bedrock": 0.0926,
    "low-perm-bedrock": 0.0001, "mixed-perm-bedrock": 0.1295,
    bfihost19: 0.773, "lcm2023-cropland": 0.2614, "lcm2023-built-up-areas": 0.123,
  };

  it("reports agreement when BGS and the catchment point the same way", () => {
    const r = inferCharacter(fromNrfaRecord(WEY), {
      coarseness: 0.56, // sandstone-led, from the real Tilford geology
      statement: "At this point BGS maps superficial deposits of Alluvium, over Folkestone Formation bedrock (Sandstone).",
    })!;
    expect(r.reasoning.join(" ")).toMatch(/agrees with the catchment properties/i);
    expect(r.reasoning.join(" ")).toMatch(/two independent datasets/i);
    expect(r.confidence).toBe("medium");
  });

  it("reports a disagreement rather than averaging it away, and drops confidence", () => {
    const r = inferCharacter(fromNrfaRecord(WEY), {
      coarseness: -0.7, // as if the site sat on a clay lens
      statement: "At this point BGS maps London Clay Formation bedrock (Clay).",
    })!;
    expect(r.reasoning.join(" ")).toMatch(/does NOT agree/);
    expect(r.reasoning.join(" ")).toMatch(/one polygon at the abstraction point/i);
    expect(r.confidence).toBe("low");
    expect(r.wouldChangeThis.join(" ")).toMatch(/disagreement/i);
  });

  it("keeps the catchment-wide reading when the two conflict", () => {
    const withoutGeology = inferCharacter(fromNrfaRecord(WEY))!;
    const withConflict = inferCharacter(fromNrfaRecord(WEY), {
      coarseness: -0.7, statement: "x",
    })!;
    // The conflicting polygon does not flip the answer.
    expect(withConflict.character).toBe(withoutGeology.character);
  });

  it("records the geology in the evidence trail", () => {
    const r = inferCharacter(fromNrfaRecord(WEY), { coarseness: 0.56, statement: "x" })!;
    expect(r.evidence.map((e) => e.field)).toContain("bgs-geology");
  });
});

describe("the permeability trap (Spey at Boat of Garten, real data)", () => {
  /**
   * NRFA 8005: low-perm-bedrock 1.0, bfihost19 0.412, arable 0.0013.
   * On those figures alone the catchment reads as fine-grained.
   *
   * BGS at the point: bedrock "Micaceous psammite" (Grampian Group,
   * metamorphic), superficial "Sand, gravel and boulders" (Glaciofluvial sheet
   * deposits, Devensian).
   *
   * The Spey is in fact a famously sandy, gravelly river. NRFA's permeability
   * class is misleading here because it describes water movement through rock,
   * not the grain size of what that rock weathers to.
   */
  const SPEY = {
    id: 8005,
    name: "Spey at Boat of Garten",
    "catchment-area": 1267.8,
    "high-perm-bedrock": null,
    "moderate-perm-bedrock": null,
    "low-perm-bedrock": 1,
    "mixed-perm-bedrock": null,
    bfihost: 0.47,
    bfihost19: 0.412,
    "lcm2023-cropland": 0.0013,
    "lcm2023-built-up-areas": 0.0044,
    "saar-1991-2020": 1439,
  };

  it("reads fine from the catchment figures alone, which is the trap", () => {
    const r = inferCharacter(fromNrfaRecord(SPEY))!;
    expect(["silt", "clay"]).toContain(r.character);
  });

  it("comes out coarse once the mapped geology is taken into account", () => {
    const r = inferCharacter(fromNrfaRecord(SPEY), {
      coarseness: 0.72, // sand, gravel and boulders over psammite
      statement:
        "At this point BGS maps superficial deposits of Glaciofluvial sheet deposits, Devensian " +
        "(Sand, gravel and boulders), over Grampian Group bedrock (Micaceous psammite).",
      bedrockIsCrystalline: true,
      coarseSuperficial: true,
    })!;
    expect(["sand", "mixed_mineral"]).toContain(r.character);
  });

  it("explains the override in terms of what permeability actually means", () => {
    const r = inferCharacter(fromNrfaRecord(SPEY), {
      coarseness: 0.72, statement: "x", bedrockIsCrystalline: true, coarseSuperficial: true,
    })!;
    const prose = r.reasoning.join(" ");
    expect(prose).toMatch(/permeability describes how water moves through rock, not the size of the grains/i);
    expect(prose).toMatch(/impermeable and still weathers to coarse sand/i);
    expect(r.wouldChangeThis.join(" ")).toMatch(/overriding the catchment permeability class/i);
  });

  it("does not fire the override on a genuinely fine sedimentary catchment", () => {
    // Mudstone is impermeable AND fine. Nothing to override.
    const r = inferCharacter(
      { lowPermBedrock: 1, bfihost: 0.4, cropland: 0.5 },
      { coarseness: -0.7, statement: "x", bedrockIsCrystalline: false, coarseSuperficial: false },
    )!;
    expect(["silt", "clay"]).toContain(r.character);
    expect(r.reasoning.join(" ")).not.toMatch(/permeability describes how water moves/i);
  });

  it("does not fire it when the superficial deposits are fine too", () => {
    const r = inferCharacter(fromNrfaRecord(SPEY), {
      coarseness: -0.6, statement: "x", bedrockIsCrystalline: true, coarseSuperficial: false,
    })!;
    expect(["silt", "clay"]).toContain(r.character);
  });
});
