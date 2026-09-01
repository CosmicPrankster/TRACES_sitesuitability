import { describe, expect, it } from "vitest";
import {
  loadFieldObservations,
  loadHydrocyclones,
  loadMembranes,
  loadQueryLog,
  loadTrials,
  logKey,
  validateData,
  validate,
  loadAll,
} from "@/lib/data";

describe("data files are valid", () => {
  it("passes every validation rule", () => {
    const issues = validateData();
    // Print them all, rather than failing on the first.
    expect(issues.map((i) => `${i.file}/${i.id}: ${i.problem}`)).toEqual([]);
  });
});

describe("hydrocyclones", () => {
  const cyclones = loadHydrocyclones();

  it("holds the 4 mm and 10 mm units", () => {
    expect(cyclones.map((h) => h.id).sort()).toEqual(["10mm", "4mm"]);
  });

  it("labels its performance values as guesses, because they are", () => {
    for (const h of cyclones) {
      expect(h.status.cut).toBe("guessed");
      expect(h.status.operating).toBe("guessed");
      // The diameter is the one thing actually known.
      expect(h.status.diameterMm).toBe("measured");
    }
  });

  it("keeps cut sizes in ascending order within a unit", () => {
    for (const h of cyclones) {
      expect(h.cut.d20Um).toBeLessThan(h.cut.d50Um);
      expect(h.cut.d50Um).toBeLessThan(h.cut.d90Um);
    }
  });

  it("gives the smaller body the finer cut", () => {
    const four = cyclones.find((h) => h.id === "4mm")!;
    const ten = cyclones.find((h) => h.id === "10mm")!;
    expect(four.diameterMm).toBeLessThan(ten.diameterMm);
    expect(four.cut.d50Um).toBeLessThan(ten.cut.d50Um);
  });

  it("has an empty revision history to start from", () => {
    for (const h of cyclones) expect(Array.isArray(h.revisions)).toBe(true);
  });
});

describe("membranes", () => {
  const membranes = loadMembranes();

  it("screens the five requested ratings", () => {
    expect(membranes.map((m) => m.poreSizeUm)).toEqual([0.45, 1.2, 5, 10, 20]);
  });

  it("returns them in ascending pore size", () => {
    for (let i = 1; i < membranes.length; i += 1) {
      expect(membranes[i].poreSizeUm).toBeGreaterThan(membranes[i - 1].poreSizeUm);
    }
  });

  it("starts with every product block empty and marked unpopulated", () => {
    for (const m of membranes) {
      expect(m.product.populated).toBe(false);
      expect(m.product.manufacturer).toBeNull();
      expect(m.product.retentionUm).toBeNull();
      expect(m.product.rating).toBe("unstated");
    }
  });
});

describe("field observations", () => {
  const observations = loadFieldObservations();

  it("holds the Tilford separation result", () => {
    const o = observations.find((x) => x.siteId === "tilford");
    expect(o).toBeDefined();
    expect(o!.kind).toBe("separation-confirmed");
    expect(o!.hydrocycloneIds.sort()).toEqual(["10mm", "4mm"]);
  });

  it("qualifies the Tilford result as a disturbed-bed feed, not normal running", () => {
    const o = observations.find((x) => x.siteId === "tilford")!;
    expect(o.feed).toBe("disturbed-bed");
  });

  it("states what each observation does NOT show", () => {
    for (const o of observations) {
      expect(o.doesNotShow.length).toBeGreaterThan(0);
      // Specifically: seeing separation is not a cut size.
      if (o.kind === "separation-confirmed") {
        expect(o.doesNotShow.join(" ")).toMatch(/cut size/i);
      }
    }
  });

  it("ties every observation to both a site and a waterbody", () => {
    for (const o of observations) {
      expect(o.siteId).toBeTruthy();
      expect(o.waterbodyId).toBeTruthy();
    }
  });
});

describe("trials", () => {
  const trials = loadTrials();

  it("holds the 10 recorded Oct24-Nov10 bench trials", () => {
    expect(trials.length).toBe(10);
    expect(trials.every((t) => t.status === "recorded")).toBe(true);
  });

  it("has not silently filled in numbers without flipping the status", () => {
    for (const t of trials) {
      if (t.status === "awaiting-data") {
        expect(t.volumeBeforeMl).toBeNull();
        expect(t.volumeAfterMl).toBeNull();
      }
    }
  });

  it("keeps every trial's feed honestly marked as a bench feed, not a natural water", () => {
    // All 10 are crushed-soil-in-water bench trials - none are evidence
    // about any particular site until a natural feed is run.
    for (const t of trials) {
      expect(t.siteId).toBeNull();
      expect(t.feed.note).toMatch(/not a natural water/i);
    }
  });

  it("records the 10mm-alone and 10mm+10mm cascade as distinct treatment stages", () => {
    const single = trials.filter((t) => t.hydrocycloneIds.length === 1);
    const cascade = trials.filter((t) => t.hydrocycloneIds.length === 2);
    expect(single.length).toBe(5);
    expect(cascade.length).toBe(5);
    expect(cascade.every((t) => t.hydrocycloneIds.join() === "10mm,10mm")).toBe(true);
  });

  it("shows the cascade outperforming a single pass at every concentration", () => {
    // Same baseline, same concentration series - the second hydrocyclone
    // stage should only add further removal, never make things worse.
    const pairs: [string, string][] = [
      ["aquarium-soil-bench-001", "oct24nov10-10mm-cascade-0p5gL"],
      ["oct24nov10-10mm-1gL", "oct24nov10-10mm-cascade-1gL"],
      ["oct24nov10-10mm-2gL", "oct24nov10-10mm-cascade-2gL"],
      ["oct24nov10-10mm-5gL", "oct24nov10-10mm-cascade-5gL"],
      ["oct24nov10-10mm-10gL", "oct24nov10-10mm-cascade-10gL"],
    ];
    const ratio = (id: string) => {
      const t = trials.find((x) => x.id === id)!;
      return t.volumeAfterMl! / t.volumeBeforeMl!;
    };
    for (const [singleId, cascadeId] of pairs) {
      expect(ratio(cascadeId)).toBeGreaterThan(ratio(singleId));
    }
  });
});

describe("query log", () => {
  it("starts empty", () => {
    expect(loadQueryLog()).toEqual([]);
  });

  it("keys on site plus waterbody, not on typed text", () => {
    expect(logKey("tilford", "river-wey-tilford")).toBe("tilford::river-wey-tilford");
    // Different waterbodies at one site are different entries.
    expect(logKey("a", "b")).not.toBe(logKey("a", "c"));
  });
});

describe("the validator actually rejects bad data", () => {
  // A validator nobody has seen reject anything is not a validator. Each case
  // deliberately breaks one rule and asserts it is caught.
  const good = loadAll();
  const problems = (d: Parameters<typeof validate>[0]) =>
    validate(d).map((i) => i.problem).join(" | ");

  it("catches cut sizes that do not increase", () => {
    const h = structuredClone(good);
    h.hydrocyclones[0].cut = { d20Um: 40, d50Um: 20, d90Um: 10 };
    expect(problems(h)).toMatch(/cut sizes must increase/);
  });

  it("catches a bigger cyclone given a finer cut than a smaller one", () => {
    const h = structuredClone(good);
    const ten = h.hydrocyclones.find((x) => x.id === "10mm")!;
    ten.cut = { d20Um: 1, d50Um: 2, d90Um: 3 };
    expect(problems(h)).toMatch(/backwards/);
  });

  it("catches a duplicate hydrocyclone id", () => {
    const h = structuredClone(good);
    h.hydrocyclones.push(structuredClone(h.hydrocyclones[0]));
    expect(problems(h)).toMatch(/duplicate id/);
  });

  it("catches an observation with no stated limits", () => {
    const h = structuredClone(good);
    h.observations[0].doesNotShow = [];
    expect(problems(h)).toMatch(/doesNotShow must not be empty/);
  });

  it("catches an observation pointing at equipment that does not exist", () => {
    const h = structuredClone(good);
    h.observations[0].hydrocycloneIds = ["99mm"];
    expect(problems(h)).toMatch(/unknown hydrocyclone "99mm"/);
  });

  it("catches an observation missing its waterbody", () => {
    const h = structuredClone(good);
    h.observations[0].waterbodyId = "";
    expect(problems(h)).toMatch(/both siteId and waterbodyId/);
  });

  it("catches a membrane claiming to be populated with no source", () => {
    const h = structuredClone(good);
    h.membranes[0].product.populated = true;
    expect(problems(h)).toMatch(/populated but has no sourceUrl/);
  });

  it("catches two log entries for the same site and waterbody", () => {
    const h = structuredClone(good);
    const entry = {
      siteId: "tilford", waterbodyId: "river-wey-tilford", siteName: "T",
      waterbodyName: "W", firstScreenedAt: "", lastScreenedAt: "", runs: 1, lastResult: null,
    };
    h.log = [entry, structuredClone(entry)];
    expect(problems(h)).toMatch(/duplicate site \+ waterbody/);
  });

  it("catches a recorded trial with no volumes", () => {
    const h = structuredClone(good);
    // h.trials[0] is already a fully-valid recorded trial - break only the
    // one rule under test, leaving everything else intact.
    h.trials[0].volumeBeforeMl = null;
    h.trials[0].volumeAfterMl = null;
    expect(problems(h)).toMatch(/positive volumeBeforeMl and volumeAfterMl/);
  });

  it("catches a recorded trial with no terminal condition - the field most often forgotten", () => {
    const h = structuredClone(good);
    h.trials[0].terminalCondition = null;
    expect(problems(h)).toMatch(/terminalCondition/);
  });

  it("catches a recorded trial with no hydrocycloneIds at all", () => {
    const h = structuredClone(good);
    h.trials[0].hydrocycloneIds = [];
    expect(problems(h)).toMatch(/at least one hydrocycloneId/);
  });

  it("catches a trial referencing an unknown hydrocyclone", () => {
    const h = structuredClone(good);
    h.trials[0].hydrocycloneIds = ["99mm"];
    expect(problems(h)).toMatch(/unknown hydrocyclone "99mm"/);
  });

  it("catches a duplicate trial id", () => {
    const h = structuredClone(good);
    h.trials.push(structuredClone(h.trials[0]));
    expect(problems(h)).toMatch(/duplicate id/);
  });

  it("accepts the real data unchanged", () => {
    expect(validate(good)).toEqual([]);
  });
});
