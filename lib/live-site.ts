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
 * Every failure is a distinct, named state - never a silent default. If
 * geocoding fails, or nothing on NRFA matches, or BGS has nothing at the
 * point, that is reported as exactly that, not smoothed over into a guess.
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

export type SiteResolutionFailure =
  | { ok: false; stage: "geocode"; message: string }
  | { ok: false; stage: "nrfa-list"; message: string }
  | { ok: false; stage: "no-match"; message: string; resolution: Resolution };

export interface SiteResolutionSuccess {
  ok: true;
  geocode: GeocodeResult;
  resolution: Resolution;
  station: NrfaStation;
  catchment: CatchmentProperties;
  geologyStatement: string | null;
  characterInference: CharacterInference;
}

export type SiteResolutionResult = SiteResolutionSuccess | SiteResolutionFailure;

/**
 * The full live pipeline: parse the query, geocode a settlement anchor,
 * match it against NRFA gauging stations, pull the full catchment record,
 * corroborate with BGS geology at the point, and infer solids character.
 *
 * Mirrors scripts/probe.mjs exactly, but calls the tested library functions
 * (parseQuery/rankStations/decideResolution/fromNrfaRecord/inferCharacter)
 * instead of re-deriving the logic.
 */
export async function resolveSite(query: string): Promise<SiteResolutionResult> {
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
  const top = matches[0];
  if (!top || resolution.confidence === "none" || resolution.confidence === "ambiguous") {
    return {
      ok: false,
      stage: "no-match",
      message: resolution.statement,
      resolution,
    };
  }

  const [fullRecord, bedrock, superficial] = await Promise.all([
    fetchNrfaFullRecord(top.station.id),
    fetchBgsLayer("BGS.50k.Bedrock", top.station.easting, top.station.northing),
    fetchBgsLayer("BGS.50k.Superficial.deposits", top.station.easting, top.station.northing),
  ]);

  const catchment = fromNrfaRecord(fullRecord ?? { id: top.station.id, name: top.station.name });
  const geologySummary = bedrock || superficial ? summariseGeology({ bedrock, superficial }) : null;

  let corroboration: GeologyCorroboration | undefined;
  if (geologySummary && geologySummary.coarseness !== null) {
    const superficialSignal = readLithology(superficial?.lithology ?? null);
    corroboration = {
      coarseness: geologySummary.coarseness,
      statement: geologySummary.statement,
      bedrockIsCrystalline: isCrystallineBedrock(bedrock?.lithology ?? null),
      coarseSuperficial: (superficialSignal?.coarseness ?? 0) > 0.3,
    };
  }

  const characterInference = inferCharacter(catchment, corroboration);
  if (!characterInference) {
    return {
      ok: false,
      stage: "no-match",
      message: `${top.station.name} matched, but NRFA has too little catchment data recorded to infer anything.`,
      resolution,
    };
  }

  return {
    ok: true,
    geocode,
    resolution,
    station: top.station,
    catchment,
    geologyStatement: geologySummary?.statement ?? null,
    characterInference,
  };
}
