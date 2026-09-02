import { wgs84ToBng } from "../scripts/lib/bng.mjs";
import {
  decideResolution,
  parseQuery,
  rankStations,
  type NrfaStation,
  type Resolution,
} from "./resolve";
import {
  fromNrfaRecord,
  inferCharacter,
  inferCharacterFromGeologyOnly,
  type CatchmentProperties,
  type CharacterInference,
  type GeologyCorroboration,
} from "./character";
import { isCrystallineBedrock, parseBgsFeatureInfo, readLithology, summariseGeology } from "./geology";

/**
 * BLOCK 6, site input - the live version of scripts/probe.mjs's data path,
 * wired to the actual (tested) resolve.ts / character.ts / geology.ts logic
 * instead of being re-implemented ad hoc. Server-only: uses fetch against
 * Nominatim, NRFA and BGS directly, so this must never run in the browser.
 *
 * Split into two steps on purpose - HANDOFF.md is explicit that the wrong
 * reach is the worst silent failure available, so the match must be shown
 * back to the user and CONFIRMED before any screening happens on it:
 *
 *   matchSite(query)      cheap: geocode + NRFA name/place match. Returns a
 *                         Resolution (candidates + confidence), never
 *                         auto-picks one.
 *   screenStation(station) expensive: the full NRFA record + BGS geology +
 *                          character inference, for a station the caller
 *                          (the UI, after the user confirms) has chosen.
 *
 * Every failure is a distinct, named state - never a silent default.
 */

const TIMEOUT_MS = 20000;
const USER_AGENT = "traces-site-suitability/0.2 (screening tool; see README)";

async function getText(url: string, accept: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: accept, "User-Agent": USER_AGENT } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(url: string): Promise<T | null> {
  const text = await getText(url, "application/json");
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const SETTLEMENT_TYPES = ["city", "town", "village", "hamlet", "suburb", "administrative", "locality"];

export interface GeocodeResult {
  displayName: string;
  lat: number;
  lon: number;
  matchedOn: string;
  candidateCount: number;
}

/** GB-restricted, prefers a populated place. See HANDOFF.md: "Geocoding silently changes the question." */
export async function geocodeAnchor(candidates: string[]): Promise<GeocodeResult | null> {
  for (const candidate of candidates) {
    const body = await getJson<{ display_name: string; lat: string; lon: string; type: string }[]>(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&countrycodes=gb&q=${encodeURIComponent(candidate)}`,
    );
    if (body && body.length > 0) {
      const best = body.find((r) => SETTLEMENT_TYPES.includes(r.type)) ?? body[0];
      return {
        displayName: best.display_name,
        lat: Number(best.lat),
        lon: Number(best.lon),
        matchedOn: candidate,
        candidateCount: body.length,
      };
    }
  }
  return null;
}

export async function fetchNrfaStations(): Promise<NrfaStation[] | null> {
  const body = await getJson<{ data: NrfaStation[] }>(
    "https://nrfaapps.ceh.ac.uk/nrfa/ws/station-info?format=json-object&station=*&fields=id,name,river,easting,northing,catchment-area",
  );
  return body?.data ?? null;
}

export async function fetchNrfaFullRecord(stationId: number): Promise<Record<string, unknown> | null> {
  const body = await getJson<{ data: Record<string, unknown>[] }>(
    `https://nrfaapps.ceh.ac.uk/nrfa/ws/station-info?format=json-object&station=${stationId}&fields=all`,
  );
  return body?.data?.[0] ?? null;
}

const BGS_WMS = "https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer";

async function fetchBgsLayer(layer: string, easting: number, northing: number) {
  const half = 500;
  const bbox = `${easting - half},${northing - half},${easting + half},${northing + half}`;
  const url =
    `${BGS_WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo&LAYERS=${layer}&QUERY_LAYERS=${layer}` +
    `&CRS=EPSG:27700&BBOX=${bbox}&WIDTH=101&HEIGHT=101&I=50&J=50&FORMAT=image/png` +
    `&INFO_FORMAT=text/xml&FEATURE_COUNT=10`;
  // text/xml is not a fallback - it is the only format BGS actually carries
  // data in (see lib/geology.ts's header comment).
  const xml = await getText(url, "text/xml");
  return xml ? parseBgsFeatureInfo(xml) : null;
}

async function fetchGeologyCorroboration(easting: number, northing: number): Promise<GeologyCorroboration | undefined> {
  const [bedrock, superficial] = await Promise.all([
    fetchBgsLayer("BGS.50k.Bedrock", easting, northing),
    fetchBgsLayer("BGS.50k.Superficial.deposits", easting, northing),
  ]);
  const geologySummary = bedrock || superficial ? summariseGeology({ bedrock, superficial }) : null;
  if (!geologySummary || geologySummary.coarseness === null) return undefined;

  const superficialSignal = readLithology(superficial?.lithology ?? null);
  return {
    coarseness: geologySummary.coarseness,
    statement: geologySummary.statement,
    bedrockIsCrystalline: isCrystallineBedrock(bedrock?.lithology ?? null),
    coarseSuperficial: (superficialSignal?.coarseness ?? 0) > 0.3,
  };
}

/* ------------------------------------------------------------------ */
/* Step 1: match - cheap, never commits to a station                   */
/* ------------------------------------------------------------------ */

export type SiteMatchFailure =
  | { ok: false; stage: "geocode"; message: string }
  | { ok: false; stage: "nrfa-list"; message: string };

export interface SiteMatchSuccess {
  ok: true;
  geocode: GeocodeResult;
  /** British National Grid coordinates of the geocoded point - what a geology-only fallback needs. */
  bng: { easting: number; northing: number };
  /** Carries .candidates, .confidence, .needsConfirmation - nothing is auto-picked. */
  resolution: Resolution;
}

export type SiteMatchResult = SiteMatchSuccess | SiteMatchFailure;

/** Geocodes and name-matches against NRFA. Returns candidates for the user to confirm - picks nothing. */
export async function matchSite(query: string): Promise<SiteMatchResult> {
  const parsed = parseQuery(query);
  const candidates = [parsed.settlement, parsed.waterbody, ...(parsed.anchorCandidates ?? []), query].filter(
    (v): v is string => Boolean(v),
  );

  const geocode = await geocodeAnchor(candidates);
  if (!geocode) {
    return {
      ok: false,
      stage: "geocode",
      message: `Could not geocode any part of "${query}" to a UK place. Check spelling, or that it names a real settlement.`,
    };
  }

  const bng = wgs84ToBng(geocode.lat, geocode.lon);
  const stations = await fetchNrfaStations();
  if (!stations) {
    return { ok: false, stage: "nrfa-list", message: "NRFA's station list did not respond. Try again shortly." };
  }

  const matches = rankStations(parsed, stations, 5, bng);
  const resolution = decideResolution(parsed, matches);
  return { ok: true, geocode, bng, resolution };
}

/* ------------------------------------------------------------------ */
/* Step 2: screen - only once the user has confirmed a specific station */
/* ------------------------------------------------------------------ */

export type StationScreenFailure = { ok: false; stage: "no-inference"; message: string };

export interface StationScreenSuccess {
  ok: true;
  station: NrfaStation;
  catchment: CatchmentProperties;
  geologyStatement: string | null;
  characterInference: CharacterInference;
}

export type StationScreenResult = StationScreenSuccess | StationScreenFailure;

/** Full catchment record + BGS geology + character inference for a CONFIRMED station. */
export async function screenStation(station: NrfaStation): Promise<StationScreenResult> {
  const [fullRecord, corroboration] = await Promise.all([
    fetchNrfaFullRecord(station.id),
    fetchGeologyCorroboration(station.easting, station.northing),
  ]);

  const catchment = fromNrfaRecord(fullRecord ?? { id: station.id, name: station.name });
  const characterInference = inferCharacter(catchment, corroboration);
  if (!characterInference) {
    return {
      ok: false,
      stage: "no-inference",
      message: `${station.name} matched, but NRFA has too little catchment data recorded to infer anything.`,
    };
  }

  return { ok: true, station, catchment, geologyStatement: corroboration?.statement ?? null, characterInference };
}

/* ------------------------------------------------------------------ */
/* Fallback: no NRFA gauge nearby - geology at the point alone          */
/* ------------------------------------------------------------------ */

export type PointGeologyFailure = { ok: false; stage: "no-geology-data"; message: string };

export interface PointGeologySuccess {
  ok: true;
  geologyStatement: string;
  characterInference: CharacterInference;
}

export type PointGeologyResult = PointGeologySuccess | PointGeologyFailure;

/**
 * The fallback promised by decideResolution's "none" case: normal for a
 * small or urban watercourse with no NRFA gauge nearby. Needs no
 * confirmation step (resolution.needsConfirmation is already false for
 * "none" - there is no candidate to choose between, only the presence or
 * absence of mapped geology at the one point already geocoded).
 */
export async function screenPointGeology(easting: number, northing: number): Promise<PointGeologyResult> {
  const corroboration = await fetchGeologyCorroboration(easting, northing);
  if (!corroboration) {
    return {
      ok: false,
      stage: "no-geology-data",
      message: "BGS has no mapped geology at this point either, so there is nothing to infer solids character from.",
    };
  }
  return {
    ok: true,
    geologyStatement: corroboration.statement,
    characterInference: inferCharacterFromGeologyOnly(corroboration),
  };
}
