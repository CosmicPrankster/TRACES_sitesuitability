import { describe, expect, it } from "vitest";
import {
  parseBgsFeatureInfo,
  readLithology,
  summariseGeology,
} from "@/lib/geology";
import {
  EMPTY_XML,
  TILFORD_BEDROCK_XML,
  TILFORD_SUPERFICIAL_XML,
} from "./fixtures/bgs-tilford";

describe("parsing real BGS responses", () => {
  it("reads the Tilford bedrock", () => {
    const u = parseBgsFeatureInfo(TILFORD_BEDROCK_XML)!;
    expect(u.lex).toBe("FO");
    expect(u.name).toBe("Folkestone Formation");
    expect(u.lithology).toBe("Sandstone");
    expect(u.lithologyCode).toBe("SDST");
    expect(u.group).toBe("Lower Greensand Group");
    expect(u.type).toBe("sedimentary bedrock");
    expect(u.lexiconUrl).toBe("https://webapps.bgs.ac.uk/lexicon/lexicon.cfm?pub=FO");
    expect(u.description).toMatch(/shallow-marine in origin/);
  });

  it("reads the Tilford superficial deposits", () => {
    const u = parseBgsFeatureInfo(TILFORD_SUPERFICIAL_XML)!;
    expect(u.lex).toBe("ALV");
    expect(u.name).toBe("Alluvium");
    expect(u.lithology).toBe("Clay, silt, sand and gravel");
    expect(u.type).toBe("superficial deposits");
    expect(u.lexiconUrl).toContain("pub=ALV");
  });

  it("treats BGS's placeholder strings as absent", () => {
    const u = parseBgsFeatureInfo(TILFORD_SUPERFICIAL_XML)!;
    // GP_EQ_D is "No Parent" for alluvium; that is not a group name.
    expect(u.group).toBeNull();
  });

  it("returns null where there is genuinely no feature", () => {
    expect(parseBgsFeatureInfo(EMPTY_XML)).toBeNull();
    expect(parseBgsFeatureInfo("")).toBeNull();
    expect(parseBgsFeatureInfo("<html>error</html>")).toBeNull();
  });
});

describe("reading a lithology", () => {
  it("rates sandstone coarse and mudstone fine", () => {
    expect(readLithology("Sandstone")!.coarseness).toBeGreaterThan(0.5);
    expect(readLithology("Mudstone")!.coarseness).toBeLessThan(-0.5);
  });

  it("treats a composite alluvium as mixed, not as its first word", () => {
    // "Clay, silt, sand and gravel" must not be read as clay.
    const alluvium = readLithology("Clay, silt, sand and gravel")!;
    expect(alluvium.coarseness).toBeGreaterThan(readLithology("Clay")!.coarseness);
    expect(alluvium.meaning).toMatch(/both a fine and a coarse fraction/i);
  });

  it("flags peat as a density problem, not merely a fine one", () => {
    const peat = readLithology("Peat")!;
    expect(peat.meaning).toMatch(/density/i);
  });

  it("returns null for a lithology it does not recognise", () => {
    expect(readLithology("Xenolithic breccia-tuff hybrid")).not.toBeNull(); // breccia matches
    expect(readLithology("Unclassified")).toBeNull();
    expect(readLithology(null)).toBeNull();
  });
});

describe("summarising the point", () => {
  const bedrock = parseBgsFeatureInfo(TILFORD_BEDROCK_XML);
  const superficial = parseBgsFeatureInfo(TILFORD_SUPERFICIAL_XML);

  it("names both units and cites the BGS Lexicon for each", () => {
    const s = summariseGeology({ bedrock, superficial })!;
    expect(s.statement).toContain("Alluvium");
    expect(s.statement).toContain("Folkestone Formation");
    expect(s.sources).toHaveLength(2);
    expect(s.sources.every((x) => x.url.includes("lexicon.cfm"))).toBe(true);
  });

  it("says outright that alluvium is partly circular evidence", () => {
    const s = summariseGeology({ bedrock, superficial })!;
    expect(s.reasoning.join(" ")).toMatch(/river's own deposit/i);
    expect(s.reasoning.join(" ")).toMatch(/circular/i);
  });

  it("leans on bedrock when the superficial is the river's own alluvium", () => {
    const s = summariseGeology({ bedrock, superficial })!;
    // Sandstone (+0.8) weighted 0.65 against alluvium (+0.1) weighted 0.35.
    expect(s.coarseness!).toBeGreaterThan(0.4);
  });

  it("leans on the superficial when it is not alluvium", () => {
    const till = parseBgsFeatureInfo(
      TILFORD_SUPERFICIAL_XML.replace('LEX_D="Alluvium"', 'LEX_D="Till"').replace(
        'RCS_D="Clay, silt, sand and gravel"', 'RCS_D="Diamicton"'),
    );
    const s = summariseGeology({ bedrock, superficial: till })!;
    // A clay-rich till at surface should pull the answer down despite sandstone below.
    expect(s.coarseness!).toBeLessThan(0.3);
  });

  it("copes with only one of the two present", () => {
    expect(summariseGeology({ bedrock, superficial: null })!.coarseness).toBeGreaterThan(0.5);
    expect(summariseGeology({ bedrock: null, superficial })!.coarseness).not.toBeNull();
    expect(summariseGeology({ bedrock: null, superficial: null })).toBeNull();
  });

  it("gives Tilford a coarse reading, agreeing with the NRFA inference", () => {
    const s = summariseGeology({ bedrock, superficial })!;
    expect(s.coarseness!).toBeGreaterThan(0);
    expect(s.reasoning.join(" ")).toMatch(/sand-grade quartz grains/i);
  });
});

describe("Highland lithologies (Spey, real data)", () => {
  it("reads psammite as coarse - it is metamorphosed sandstone", () => {
    const p = readLithology("Micaceous psammite")!;
    expect(p.coarseness).toBeGreaterThan(0.3);
    expect(p.meaning).toMatch(/metamorphosed sandstone/i);
    expect(p.meaning).toMatch(/coarser than its 'low permeability' classification suggests/i);
  });

  it("reads pelite as fine - it is metamorphosed mudstone", () => {
    const p = readLithology("Pelite")!;
    expect(p.coarseness).toBeLessThan(0);
  });

  it("distinguishes the two, which a single 'metamorphic' rule could not", () => {
    expect(readLithology("Psammite")!.coarseness)
      .toBeGreaterThan(readLithology("Pelite")!.coarseness);
  });

  it("reads the real Spey superficial deposit as coarse", () => {
    const s = readLithology("Sand, gravel and boulders")!;
    expect(s.coarseness).toBeGreaterThan(0.5);
  });
});
