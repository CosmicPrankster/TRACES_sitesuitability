import { describe, expect, it } from "vitest";
import {
  decideResolution,
  nearestStations,
  parseCoordinates,
  parseQuery,
  rankStations,
  scoreStation,
  tokens,
  type NrfaStation,
} from "@/lib/resolve";

/**
 * Fixtures taken from the real NRFA station list returned by the probe, plus
 * decoys chosen to be genuinely confusable.
 */
const STATIONS: NrfaStation[] = [
  { id: 39011, name: "Wey at Tilford", river: "Wey", easting: 487300, northing: 143400, "catchment-area": 396.3 },
  { id: 39007, name: "Wey at Weybridge", river: "Wey", easting: 507000, northing: 165000, "catchment-area": 1010 },
  { id: 14005, name: "Motray Water at St Michaels", river: "Motray Water", easting: 344000, northing: 720000, "catchment-area": 60 },
  { id: 39001, name: "Thames at Kingston", river: "Thames", easting: 517700, northing: 169800, "catchment-area": 9948 },
  { id: 28009, name: "Trent at Colwick", river: "Trent", easting: 462100, northing: 339500, "catchment-area": 7486 },
  { id: 21009, name: "Tweed at Norham", river: "Tweed", easting: 389800, northing: 647200, "catchment-area": 4390 },
];

describe("splitting the query", () => {
  it("reads settlement-then-waterbody", () => {
    const p = parseQuery("Tilford, River Wey");
    expect(p.waterbody).toBe("River Wey");
    expect(p.settlement).toBe("Tilford");
    expect(p.ambiguous).toBe(false);
  });

  it("reads waterbody-then-settlement, the other way round", () => {
    const p = parseQuery("Kinness Burn, St Andrews");
    expect(p.waterbody).toBe("Kinness Burn");
    expect(p.settlement).toBe("St Andrews");
    expect(p.ambiguous).toBe(false);
  });

  it("recognises the many words British watercourses go by", () => {
    for (const q of [
      "Foo, River Bar", "Foo, Bar Burn", "Foo, Bar Beck", "Foo, Bar Water",
      "Foo, Afon Bar", "Foo, Bar Brook", "Foo, Loch Bar", "Foo, Bar Pond", "Foo, Bar Pool",
    ]) {
      expect(parseQuery(q).waterbody, q).toBeDefined();
    }
  });

  it("keeps the settlement nearest the waterbody when a county follows", () => {
    const p = parseQuery("Kinness Burn, St Andrews, Fife");
    expect(p.waterbody).toBe("Kinness Burn");
    expect(p.settlement).toBe("St Andrews");
  });

  it("handles a lone place or a lone river", () => {
    expect(parseQuery("Tilford").settlement).toBe("Tilford");
    expect(parseQuery("River Wey").waterbody).toBe("River Wey");
  });

  it("drops noise words but keeps real ones", () => {
    expect(tokens("The River at Tilford")).toEqual(["river", "tilford"]);
  });
});

describe("matching against NRFA stations", () => {
  it("resolves 'Tilford, River Wey' to the Tilford gauge, not the Weybridge one", () => {
    const parsed = parseQuery("Tilford, River Wey");
    const ranked = rankStations(parsed, STATIONS);
    expect(ranked[0].station.id).toBe(39011);
    expect(ranked[0].score).toBe(1);
    expect(ranked[0].matchedRiver).toBe(true);
    expect(ranked[0].matchedPlace).toBe(true);
  });

  it("still lists the same river elsewhere, but below the exact match", () => {
    const ranked = rankStations(parseQuery("Tilford, River Wey"), STATIONS);
    const weybridge = ranked.find((m) => m.station.id === 39007);
    expect(weybridge).toBeDefined();
    expect(weybridge!.score).toBeLessThan(1);
    expect(weybridge!.reason).toMatch(/right river.*different place/i);
  });

  it("will not match a river alone, which would put us anywhere along it", () => {
    const ranked = rankStations(parseQuery("River Wey"), STATIONS);
    expect(ranked.every((m) => m.score < 1)).toBe(true);
  });

  it("returns nothing for an ungauged burn rather than forcing a match", () => {
    const ranked = rankStations(parseQuery("Kinness Burn, St Andrews"), STATIONS);
    expect(ranked.every((m) => m.score < 1)).toBe(true);
  });

  it("tolerates a misspelling of the water word itself", () => {
    const parsed = parseQuery("Tilford, Wey");
    const ranked = rankStations(parsed, STATIONS);
    expect(ranked[0].station.id).toBe(39011);
  });

  it("is case and punctuation insensitive", () => {
    const a = rankStations(parseQuery("TILFORD, RIVER WEY"), STATIONS);
    const b = rankStations(parseQuery("tilford , river  wey"), STATIONS);
    expect(a[0].station.id).toBe(39011);
    expect(b[0].station.id).toBe(39011);
  });

  it("does not match unrelated rivers at all", () => {
    const ranked = rankStations(parseQuery("Tilford, River Wey"), STATIONS);
    expect(ranked.map((m) => m.station.id)).not.toContain(28009);
    expect(ranked.map((m) => m.station.id)).not.toContain(21009);
  });

  it("scores a place-only match below a river-and-place match", () => {
    const parsed = parseQuery("Kingston, River Wey");
    const m = scoreStation(parsed, STATIONS[3]); // Thames at Kingston
    expect(m.matchedPlace).toBe(true);
    expect(m.matchedRiver).toBe(false);
    expect(m.score).toBeLessThan(1);
    expect(m.reason).toMatch(/different watercourse/i);
  });
});

describe("the Kings Pond false match (real bug: 'pond' was not a water word)", () => {
  // "Frensham Great Pond" had no waterbody word recognised at all, so "pond"
  // fell into the settlement/place tokens instead - and coincidentally
  // token-matched an entirely unrelated station, "Wey at Kings Pond
  // (Alton)", scoring it a false "right place" candidate that had nothing
  // to do with the actual pond being searched for.
  const KINGS_POND: NrfaStation = {
    id: 99999, name: "Wey at Kings Pond (Alton)", river: "Wey",
    easting: 471000, northing: 138000, "catchment-area": 45.9,
  };

  it("recognises 'pond' as a waterbody word", () => {
    const p = parseQuery("frensham great pond");
    expect(p.waterbody).toBe("frensham great pond");
  });

  it("no longer coincidentally matches an unrelated station also named '...Pond...'", () => {
    const parsed = parseQuery("frensham great pond");
    const m = scoreStation(parsed, KINGS_POND);
    expect(m.matchedPlace).toBe(false);
    expect(m.score).toBe(0);
    expect(m.reason).toBe("No match.");
  });
});

describe("parseCoordinates - the lat/lon direct-input path", () => {
  it("reads real coordinates for Frensham Great Pond", () => {
    expect(parseCoordinates("51.154565, -0.791587")).toEqual({ lat: 51.154565, lon: -0.791587 });
  });

  it("accepts space-separated as well as comma-separated", () => {
    expect(parseCoordinates("51.154565 -0.791587")).toEqual({ lat: 51.154565, lon: -0.791587 });
  });

  it("rejects a plain place name", () => {
    expect(parseCoordinates("Tilford, River Wey")).toBeNull();
  });

  it("rejects coordinates outside the UK's rough bounding box", () => {
    expect(parseCoordinates("40.7128, -74.0060")).toBeNull(); // New York
  });

  it("rejects two bare numbers that are not a lat/lon pair, e.g. a postcode-shaped string", () => {
    expect(parseCoordinates("GU10 3RD")).toBeNull();
  });
});

describe("nearestStations - distance alone, for a coordinate anchor with no name to match", () => {
  it("finds the closest station within range, nearest first", () => {
    const anchor = { easting: 487300, northing: 143400 }; // exactly Wey at Tilford
    const ranked = nearestStations(anchor, STATIONS);
    expect(ranked[0].station.id).toBe(39011);
    expect(ranked[0].distanceKm).toBeCloseTo(0, 3);
  });

  it("excludes anything beyond the (tighter) coordinate match radius", () => {
    const anchor = { easting: 487300, northing: 143400 }; // Tilford
    const ranked = nearestStations(anchor, STATIONS);
    expect(ranked.map((m) => m.station.id)).not.toContain(39001); // Thames at Kingston, ~35km off
  });

  it("returns nothing rather than a distant guess when nothing is close", () => {
    const middleOfNowhere = { easting: 400000, northing: 400000 };
    expect(nearestStations(middleOfNowhere, STATIONS)).toEqual([]);
  });

  it("never claims a name match - there is no name here", () => {
    const anchor = { easting: 487300, northing: 143400 };
    for (const m of nearestStations(anchor, STATIONS)) {
      expect(m.matchedRiver).toBe(false);
      expect(m.matchedPlace).toBe(false);
      expect(m.score).toBe(0);
    }
  });
});

describe("deciding whether to ask", () => {
  it("proposes a single exact match for confirmation, never assumes it", () => {
    const parsed = parseQuery("Tilford, River Wey");
    const r = decideResolution(parsed, rankStations(parsed, STATIONS));
    expect(r.confidence).toBe("likely");
    expect(r.needsConfirmation).toBe(true);
    expect(r.statement).toContain("Wey at Tilford");
    expect(r.statement).toContain("396.3 km²");
  });

  it("asks which, when several reaches match equally", () => {
    const twins: NrfaStation[] = [
      { id: 1, name: "Avon at Bath", river: "Avon", easting: 1, northing: 1 },
      { id: 2, name: "Avon at Bath", river: "Avon", easting: 2, northing: 2 },
    ];
    const parsed = parseQuery("Bath, River Avon");
    const r = decideResolution(parsed, rankStations(parsed, twins));
    expect(r.confidence).toBe("ambiguous");
    expect(r.candidates).toHaveLength(2);
  });

  it("falls back cleanly for an ungauged watercourse, without asking", () => {
    const parsed = parseQuery("Kinness Burn, St Andrews");
    const r = decideResolution(parsed, []);
    expect(r.confidence).toBe("none");
    expect(r.needsConfirmation).toBe(false);
    expect(r.statement).toMatch(/normal for a small or urban watercourse/i);
    expect(r.statement).toMatch(/geology will be read|geology read from the map/i);
  });

  it("offers near misses rather than silently picking one", () => {
    const parsed = parseQuery("Tilford, River Wey");
    const nearMisses = rankStations(parsed, STATIONS.filter((s) => s.id !== 39011));
    const r = decideResolution(parsed, nearMisses);
    expect(r.confidence).toBe("ambiguous");
    expect(r.needsConfirmation).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(0);
  });
});

describe("distance sanity (the Bedford/Pennsylvania failure)", () => {
  const BEDFORD_OUSE: NrfaStation[] = [
    { id: 33005, name: "Bedford Ouse at Thornborough Mill", river: "Bedford Ouse",
      easting: 473000, northing: 233000, "catchment-area": 388.5 },
  ];

  it("rejects a name match on the wrong continent", () => {
    // Anchored in Pennsylvania, as the probe actually did: BNG is meaningless
    // there and the station sits ~7,000 km away.
    const parsed = parseQuery("Bedford, Great Ouse");
    const wrongAnchor = { easting: -6034632, northing: 2941720 };
    expect(rankStations(parsed, BEDFORD_OUSE, 5, wrongAnchor)).toHaveLength(0);
  });

  it("accepts the same match from the right anchor", () => {
    const parsed = parseQuery("Bedford, Great Ouse");
    const rightAnchor = { easting: 474000, northing: 234000 };
    expect(rankStations(parsed, BEDFORD_OUSE, 5, rightAnchor).length).toBeGreaterThan(0);
  });

  it("offers both parts as anchors when neither carries a water word", () => {
    // "Great Ouse" contains no river/burn/beck, so the split cannot be made
    // from the words alone.
    const p = parseQuery("Bedford, Great Ouse");
    expect(p.ambiguous).toBe(true);
    expect(p.anchorCandidates).toEqual(["Bedford", "Great Ouse"]);
  });

  it("breaks ties on distance, picking the nearer reach", () => {
    const twoReaches: NrfaStation[] = [
      { id: 1, name: "Test at Timsbury", river: "Test", easting: 435000, northing: 124000 },
      { id: 2, name: "Test at Broadlands", river: "Test", easting: 435000, northing: 119000 },
    ];
    const anchor = { easting: 435197, northing: 121201 }; // Romsey, real BNG
    const ranked = rankStations(parseQuery("Romsey, River Test"), twoReaches, 5, anchor);
    expect(ranked[0].distanceKm!).toBeLessThan(ranked[1].distanceKm!);
  });
});
