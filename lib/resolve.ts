/**
 * Turning what someone typed into one specific stretch of water.
 *
 * The problem this solves: "Tilford, River Wey" means the Wey WHERE IT RUNS
 * THROUGH TILFORD. Geocoding the whole phrase matches nothing, and geocoding
 * "River Wey" alone returns a generic point on a 70 km river - about 4 km from
 * Tilford, as the probe showed. Either way the screening would be for the wrong
 * reach, with no indication.
 *
 * So: generalise to the neighbourhood, then name the exact point back to the
 * user and let them confirm it.
 *
 * Note that the two parts arrive in either order:
 *   "Tilford, River Wey"        settlement, waterbody
 *   "Kinness Burn, St Andrews"  waterbody, settlement
 *
 * Everything in this file is pure, so it is tested without a network.
 */

/** Words that mark a phrase as naming water rather than a place. */
const WATERBODY_WORDS = [
  "river", "burn", "beck", "brook", "stream", "water", "creek", "canal",
  "loch", "lake", "reservoir", "lough", "mere", "tarn", "estuary", "afon",
  "nant", "allt", "rivulet", "dike", "dyke", "drain", "cut", "sike", "gill",
];

/** Noise words that carry no matching signal. */
const STOP_WORDS = new Set(["the", "at", "on", "near", "by", "of", "in", "and", "upper", "lower"]);

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(text: string): string[] {
  return normalise(text)
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

export interface ParsedQuery {
  raw: string;
  /** The part naming the water, if one could be told apart. */
  waterbody?: string;
  /** The part naming the place. */
  settlement?: string;
  /** Every meaningful token, whichever part it came from. */
  allTokens: string[];
  /** True when the two parts could not be told apart. */
  ambiguous: boolean;
  /**
   * Parts to try as the geocoding anchor, in order, when `settlement` could not
   * be identified. Whichever resolves to a populated place is the settlement.
   */
  anchorCandidates?: string[];
}

/**
 * Splits "Tilford, River Wey" or "Kinness Burn, St Andrews" into its parts,
 * whichever order they arrive in. A part is the waterbody if it contains a
 * water word; the other part is the settlement.
 */
export function parseQuery(raw: string): ParsedQuery {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const allTokens = tokens(raw);

  const looksLikeWater = (part: string) =>
    tokens(part).some((t) => WATERBODY_WORDS.includes(t));

  if (parts.length >= 2) {
    const waterParts = parts.filter(looksLikeWater);
    const otherParts = parts.filter((p) => !looksLikeWater(p));

    if (waterParts.length === 1 && otherParts.length >= 1) {
      return {
        raw,
        waterbody: waterParts[0],
        // Prefer the part adjacent to the waterbody; for "Kinness Burn, St
        // Andrews, Fife" that is "St Andrews" rather than the county.
        settlement: otherParts[0],
        allTokens,
        ambiguous: false,
      };
    }
    // Neither part carries a water word - "Bedford, Great Ouse" is the case that
    // matters. We cannot tell them apart from the words alone, so both are
    // offered as anchor candidates and the caller decides by what each one
    // actually geocodes to: a settlement resolves to a town, a river does not.
    return { raw, allTokens, ambiguous: true, anchorCandidates: parts };
  }

  // A single part: is it water, or a place?
  if (parts.length === 1) {
    return looksLikeWater(parts[0])
      ? { raw, waterbody: parts[0], allTokens, ambiguous: false }
      : { raw, settlement: parts[0], allTokens, ambiguous: false };
  }

  return { raw, allTokens, ambiguous: true };
}

/* -------------------------------------------------------------------- */
/* Matching against NRFA gauging stations                                */
/* -------------------------------------------------------------------- */

/**
 * NRFA names its stations "<River> at <Place>" - "Wey at Tilford", "Motray
 * Water at St Michaels". That is exactly the shape of the query, which makes
 * the station list an excellent resolver for any gauged river: it gives a
 * precise, authoritative point AND the catchment properties in one step.
 */
export interface NrfaStation {
  id: number;
  name: string;
  river: string;
  easting: number;
  northing: number;
  "catchment-area"?: number;
}

export interface StationMatch {
  station: NrfaStation;
  /** 0..1. 1.0 means every token in the query was accounted for. */
  score: number;
  /** Why it matched, for showing the user. */
  reason: string;
  matchedRiver: boolean;
  matchedPlace: boolean;
  /** Distance from the geocoded anchor, when one was supplied. */
  distanceKm?: number;
}

/**
 * Scores one station against a parsed query.
 *
 * A station only scores when BOTH halves line up: the river name and the place.
 * Matching a river alone would put us anywhere along it - the exact failure
 * this is here to prevent.
 */
export function scoreStation(parsed: ParsedQuery, station: NrfaStation): StationMatch {
  const stationRiverTokens = new Set(tokens(station.river ?? ""));
  const stationNameTokens = new Set(tokens(station.name ?? ""));
  // "Wey at Tilford" -> place tokens are the name minus the river.
  const placeTokens = new Set([...stationNameTokens].filter((t) => !stationRiverTokens.has(t)));

  const queryWaterTokens = parsed.waterbody
    ? tokens(parsed.waterbody).filter((t) => !WATERBODY_WORDS.includes(t))
    : [];
  const querySettlementTokens = parsed.settlement ? tokens(parsed.settlement) : [];

  const matchedRiver =
    queryWaterTokens.length > 0 && queryWaterTokens.every((t) => stationRiverTokens.has(t));
  const matchedPlace =
    querySettlementTokens.length > 0 && querySettlementTokens.some((t) => placeTokens.has(t));

  // Fall back to whole-query overlap when the query could not be split.
  const overlap = parsed.allTokens.filter(
    (t) => !WATERBODY_WORDS.includes(t) && (stationNameTokens.has(t) || stationRiverTokens.has(t)),
  );
  const meaningful = parsed.allTokens.filter((t) => !WATERBODY_WORDS.includes(t));

  let score = 0;
  let reason: string;

  if (matchedRiver && matchedPlace) {
    score = 1;
    reason = `"${station.name}" matches both the river and the place you named.`;
  } else if (matchedRiver) {
    score = 0.5;
    reason = `"${station.name}" is on the right river, but gauges it at a different place.`;
  } else if (matchedPlace) {
    score = 0.45;
    reason = `"${station.name}" is at the right place, but on a different watercourse.`;
  } else if (meaningful.length > 0 && overlap.length > 0) {
    // Fallback for a query that could not be split, e.g. "Bedford, Great Ouse"
    // where neither part carries a water word. Scaled to top out just below a
    // place-only match, so a partial overlap is a candidate but never outranks
    // a real river or place match.
    score = 0.45 * (overlap.length / meaningful.length);
    reason = `"${station.name}" partly matches (${overlap.join(", ")}).`;
  } else {
    reason = "No match.";
  }

  return { station, score, reason, matchedRiver, matchedPlace };
}

/**
 * How far a name match may sit from the geocoded anchor before it is rejected.
 *
 * Without this, "Bedford, Great Ouse" geocoded to Bedford County, Pennsylvania
 * and still name-matched "Bedford Ouse at Thornborough Mill" - 7,048 km away.
 * A name that matches on the wrong continent is not a match.
 */
export const MAX_MATCH_DISTANCE_KM = 40;

export interface Anchor {
  easting: number;
  northing: number;
}

/** Straight-line distance in km between a station and the anchor. */
export function distanceKm(station: NrfaStation, anchor: Anchor): number {
  return Math.hypot(station.easting - anchor.easting, station.northing - anchor.northing) / 1000;
}

/**
 * Best station matches, strongest first.
 *
 * When an anchor is given, matches further than MAX_MATCH_DISTANCE_KM are
 * dropped outright, and distance breaks ties between equal name scores - which
 * is what picks "Test at Timsbury" over an identically-named reach elsewhere.
 */
export function rankStations(
  parsed: ParsedQuery,
  stations: NrfaStation[],
  limit = 5,
  anchor?: Anchor,
): StationMatch[] {
  return stations
    .map((s) => {
      const m = scoreStation(parsed, s);
      const km = anchor ? distanceKm(s, anchor) : undefined;
      return { ...m, distanceKm: km };
    })
    .filter((m) => m.score >= 0.3)
    .filter((m) => m.distanceKm === undefined || m.distanceKm <= MAX_MATCH_DISTANCE_KM)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.distanceKm ?? 0) - (b.distanceKm ?? 0) ||
        (a.station.name ?? "").localeCompare(b.station.name ?? ""),
    )
    .slice(0, limit);
}

/* -------------------------------------------------------------------- */
/* The decision                                                          */
/* -------------------------------------------------------------------- */

export type ResolutionConfidence = "confirmed" | "likely" | "ambiguous" | "none";

export interface Resolution {
  confidence: ResolutionConfidence;
  /** What to tell the user we think they meant. */
  statement: string;
  /** Whether to ask before proceeding. */
  needsConfirmation: boolean;
  candidates: StationMatch[];
}

/**
 * Decides whether we know which water is meant, or must ask.
 *
 * The rule is deliberately cautious: a single unambiguous match is proposed for
 * confirmation, not assumed. Screening the wrong reach silently is the worst
 * outcome available, and it is the one that already happened once.
 */
export function decideResolution(parsed: ParsedQuery, matches: StationMatch[]): Resolution {
  const exact = matches.filter((m) => m.score === 1);

  if (exact.length === 1) {
    const s = exact[0].station;
    return {
      confidence: "likely",
      statement:
        `That looks like ${s.name} — NRFA gauging station ${s.id}` +
        (s["catchment-area"] ? `, catchment area ${s["catchment-area"]} km²` : "") +
        ". Is that the right stretch of water?",
      needsConfirmation: true,
      candidates: matches,
    };
  }

  if (exact.length > 1) {
    return {
      confidence: "ambiguous",
      statement:
        `More than one gauged reach matches that. Which did you mean?`,
      needsConfirmation: true,
      candidates: exact,
    };
  }

  if (matches.length > 0) {
    return {
      confidence: "ambiguous",
      statement:
        parsed.waterbody && parsed.settlement
          ? `No gauged reach matches "${parsed.waterbody}" at "${parsed.settlement}" exactly. ` +
            "The closest are below — or say so and the geology will be read straight from the map " +
            "at the place you named."
          : "Nothing matched exactly. The closest gauged reaches are below.",
      needsConfirmation: true,
      candidates: matches,
    };
  }

  return {
    confidence: "none",
    statement:
      "No gauged river matches that, which is normal for a small or urban watercourse. " +
      "The place will be geocoded and the geology read from the map there instead.",
    needsConfirmation: false,
    candidates: [],
  };
}
