import { wgs84ToBng } from "../scripts/lib/bng.mjs";
import {
  COORDINATE_MATCH_DISTANCE_KM,
  decideResolution,
  deriveSiteIdentity,
  nearestStations,
  parseCoordinates,
  parseQuery,
  rankStations,
  type NrfaStation,
  type Resolution,
} from "./resolve";
import {
  fromNrfaRecord,
  inferCharacter,
  inferCharacterFromGeologyOnly,
  worthCorroboratingWithGeology,
  type CatchmentProperties,
  type CharacterInference,
  type GeologyCorroboration,
} from "./character";
import { isCrystallineBedrock, parseBgsFeatureInfo, readLithology, summariseGeology } from "./geology";
import { screenRiverWaterQuality } from "./sources/water-quality";
import type { SiteConcentration } from "./baseline";
import { assessSiteFlags, type SiteFlags } from "./flags";
import { screenTideState, type TideState } from "./sources/tide";
import { screenSatelliteTurbidity, type SatelliteTurbidity } from "./sources/satellite-turbidity";

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
    bedrockLithology: bedrock?.lithology ?? null,
    superficialLithology: superficial?.lithology ?? null,
  };
}

/**
 * Real measured solids concentration near the site, from the EA Water
 * Quality Archive's nearest ordinary river/stream point (lib/sources/
 * water-quality.ts, rebuild phase 3) - undefined, not a guess, whenever no
 * such point exists nearby, or none of its recent readings are a
 * suspended-solids concentration (ambient monitoring is sparse; an empty
 * result here is a real, honest outcome, not a failure).
 *
 * Takes the single most recent suspended-solids-concentration reading
 * found. A "less than" censored result (e.g. "<3 mg/L") uses its upper
 * bound - the conservative direction for this tool: that can only ever
 * make the predicted baseline volume LOWER than the true figure, never
 * overclaim performance on a site this tool has under-read.
 */
async function fetchSiteConcentration(easting: number, northing: number): Promise<SiteConcentration | undefined> {
  const result = await screenRiverWaterQuality(easting, northing);
  if (!result.ok) return undefined;
  const latest = result.data.suspendedSolidsMgL[0];
  if (!latest) return undefined;
  const mgL = latest.value ?? latest.censored?.value;
  if (!(mgL! > 0)) return undefined;
  const censoredNote = latest.censored ? " (a \"less than\" result, used at its upper bound)" : "";
  return {
    mgL: mgL!,
    source: `EA Water Quality Archive, ${result.point.name}, ${latest.date.slice(0, 10)}${censoredNote}`,
  };
}

/**
 * Tide state near the site (lib/sources/tide.ts, rebuild phase 5) -
 * undefined whenever there's nothing to report: no ADMIRALTY_TIDE_API_KEY
 * set (skipped, not failed - matches scripts/probe-new-sources.mjs's own
 * vocabulary for a missing key), or no real tide station close enough to
 * treat the site as estuarine. Gated to estuarine sites per the rebuild
 * plan - never fetched or reported for an ordinary inland river site.
 */
async function fetchTideState(easting: number, northing: number): Promise<TideState | undefined> {
  const apiKey = process.env.ADMIRALTY_TIDE_API_KEY;
  if (!apiKey) return undefined;
  const state = await screenTideState(easting, northing, apiKey);
  return state ?? undefined;
}

/**
 * Satellite turbidity (lib/sources/satellite-turbidity.ts, rebuild phase 6
 * - proven live 2026-10-12 after three real probe rounds, see HANDOFF.md)
 * - undefined whenever there's nothing to report: no
 * COPERNICUS_CLIENT_ID/SECRET set, or (checked first, cheaper) no nearby
 * tide station. Deliberately gated behind `tideState` rather than fetched
 * independently: the Statistical API aggregates NDTI across an entire
 * ~2.2 km box, which only means something when that box is plausibly
 * water-dominated - this reuses the already-proven "nearby a real tide
 * station" signal as that proxy, rather than inventing a second, unproven
 * land/water classifier (see lib/sources/satellite-turbidity.ts's header).
 * This also keeps the extra OAuth2 round-trip off the common case: most
 * sites this tool screens are inland and never reach this call at all.
 */
async function fetchSatelliteTurbidity(
  easting: number,
  northing: number,
  tideState: TideState | undefined,
): Promise<SatelliteTurbidity | undefined> {
  if (!tideState) return undefined;
  const clientId = process.env.COPERNICUS_CLIENT_ID;
  const clientSecret = process.env.COPERNICUS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  const result = await screenSatelliteTurbidity(easting, northing, clientId, clientSecret);
  return result ?? undefined;
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

/**
 * Geocodes and name-matches against NRFA. Returns candidates for the user
 * to confirm - picks nothing.
 *
 * If `query` is a bare "lat, lon" pair instead of a typed place, geocoding
 * is skipped entirely - there is nothing to look up, the anchor is already
 * exact - and NRFA stations are found by distance alone (nearestStations),
 * not name matching, since there is no name to match against. This is for
 * exactly the case a typed name struggles with: a small feature with no
 * good name match (or none at all, like a pond edge with no settlement
 * nearby), where the caller already knows the coordinates.
 */
export async function matchSite(query: string): Promise<SiteMatchResult> {
  const coords = parseCoordinates(query);
  if (coords) {
    const bng = wgs84ToBng(coords.lat, coords.lon);
    const stations = await fetchNrfaStations();
    if (!stations) {
      return { ok: false, stage: "nrfa-list", message: "NRFA's station list did not respond. Try again shortly." };
    }
    const nearby = nearestStations(bng, stations);
    const geocode: GeocodeResult = {
      displayName: `${coords.lat}, ${coords.lon}`,
      lat: coords.lat,
      lon: coords.lon,
      matchedOn: "coordinates",
      candidateCount: nearby.length,
    };
    const resolution: Resolution = nearby.length
      ? {
          confidence: "ambiguous",
          statement:
            `${nearby.length} NRFA gauging station${nearby.length > 1 ? "s" : ""} within ` +
            `${COORDINATE_MATCH_DISTANCE_KM} km of that point. There is no name to match against ` +
            "for coordinates, so confirm one below, or none if it is on a different watercourse to " +
            "the one you mean.",
          needsConfirmation: true,
          candidates: nearby,
        }
      : {
          confidence: "none",
          statement:
            `No NRFA gauging station within ${COORDINATE_MATCH_DISTANCE_KM} km of that point. The ` +
            "geology will be read from the map at the exact coordinates given.",
          needsConfirmation: false,
          candidates: [],
        };
    return { ok: true, geocode, bng, resolution };
  }

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
  /**
   * Whether BGS's point geology (tier 6) was actually fetched for this site.
   * False means the catchment-only (tier 5) reading was clear enough on its
   * own that the extra call was skipped - see character.ts's
   * worthCorroboratingWithGeology. Distinct from geologyStatement being
   * null for the other reason: BGS was asked and had nothing mapped there.
   */
  geologyConsulted: boolean;
  /**
   * A real measured solids concentration near the site (tier 2: EA Water
   * Quality Archive), if one was found - undefined is a real, honest
   * outcome (no nearby river point, or no recent suspended-solids
   * reading), not a failure. See fetchSiteConcentration.
   */
  siteConcentration?: SiteConcentration;
  /** Algae/inhibition risk flags (lib/flags.ts, rebuild phase 4) - independent of characterInference, never blended into it. */
  flags: SiteFlags;
  /** Tide state (lib/sources/tide.ts, rebuild phase 5) - undefined for an ordinary inland site, or when no API key is set. See fetchTideState. */
  tideState?: TideState;
  /** Satellite turbidity (lib/sources/satellite-turbidity.ts, rebuild phase 6) - undefined for an ordinary inland site (no tideState to gate on), or when no Copernicus credentials are set. See fetchSatelliteTurbidity. */
  satelliteTurbidity?: SatelliteTurbidity;
  characterInference: CharacterInference;
  /**
   * This station's own siteId/waterbodyId (lib/resolve.ts's
   * deriveSiteIdentity), for matching an exact-site trial (lib/trials.ts).
   * Only derived here, where a real confirmed NRFA station exists to derive
   * it from - the no-gauge geology-only fallback (screenPointGeology below)
   * has no station name to work from, so it has none.
   */
  site: { siteId: string; waterbodyId: string };
}

export type StationScreenResult = StationScreenSuccess | StationScreenFailure;

/**
 * Full catchment record + character inference for a CONFIRMED station. Two
 * independent things happen alongside the catchment record: the real
 * measured-water-quality tier (fetchSiteConcentration) runs in parallel
 * with it, since it doesn't depend on anything the catchment record says -
 * it's a different tier in the hierarchy entirely (BUILD.md's rebuild-
 * phase reasoning), not a fallback from it. BGS point geology (tier 6) is
 * different again: it only gets fetched when the catchment-only (tier 5)
 * reading is actually worth corroborating (see character.ts's
 * worthCorroboratingWithGeology), which needs the catchment record first -
 * so that one call stays sequential, paying its cost only when it can
 * actually change the answer.
 */
export async function screenStation(station: NrfaStation): Promise<StationScreenResult> {
  const [fullRecord, siteConcentration, tideState] = await Promise.all([
    fetchNrfaFullRecord(station.id),
    fetchSiteConcentration(station.easting, station.northing),
    fetchTideState(station.easting, station.northing),
  ]);
  const catchment = fromNrfaRecord(fullRecord ?? { id: station.id, name: station.name });

  const [corroboration, satelliteTurbidity] = await Promise.all([
    worthCorroboratingWithGeology(catchment)
      ? fetchGeologyCorroboration(station.easting, station.northing)
      : Promise.resolve(undefined),
    fetchSatelliteTurbidity(station.easting, station.northing, tideState),
  ]);

  const characterInference = inferCharacter(catchment, corroboration);
  if (!characterInference) {
    return {
      ok: false,
      stage: "no-inference",
      message: `${station.name} matched, but NRFA has too little catchment data recorded to infer anything.`,
    };
  }

  const flags = assessSiteFlags(
    { cropland: catchment.cropland, builtUp: catchment.builtUp },
    { bedrock: corroboration?.bedrockLithology ?? null, superficial: corroboration?.superficialLithology ?? null },
  );

  return {
    ok: true,
    station,
    catchment,
    geologyStatement: corroboration?.statement ?? null,
    geologyConsulted: Boolean(corroboration),
    siteConcentration,
    flags,
    tideState,
    satelliteTurbidity,
    characterInference,
    site: deriveSiteIdentity(station),
  };
}

/* ------------------------------------------------------------------ */
/* Fallback: no NRFA gauge nearby - geology at the point alone          */
/* ------------------------------------------------------------------ */

export type PointGeologyFailure = { ok: false; stage: "no-geology-data"; message: string };

export interface PointGeologySuccess {
  ok: true;
  geologyStatement: string;
  siteConcentration?: SiteConcentration;
  /** Algae flag is always insufficient-data here - no catchment land cover without an NRFA gauge. Inhibition flag uses the real geology just read. */
  flags: SiteFlags;
  /** Tide state (lib/sources/tide.ts) - this no-NRFA-gauge path is exactly where a tidal/estuarine site tends to land, since NRFA gauges exclude tidal reaches by design. */
  tideState?: TideState;
  /** Satellite turbidity (lib/sources/satellite-turbidity.ts) - gated on tideState above; see fetchSatelliteTurbidity. */
  satelliteTurbidity?: SatelliteTurbidity;
  characterInference: CharacterInference;
}

export type PointGeologyResult = PointGeologySuccess | PointGeologyFailure;

/**
 * The fallback promised by decideResolution's "none" case: normal for a
 * small or urban watercourse with no NRFA gauge nearby. Needs no
 * confirmation step (resolution.needsConfirmation is already false for
 * "none" - there is no candidate to choose between, only the presence or
 * absence of mapped geology at the one point already geocoded). The real
 * measured-water-quality and tide-state tiers are independent of whether a
 * gauge exists, so both are fetched here too, in parallel with the BGS
 * lookup.
 */
export async function screenPointGeology(easting: number, northing: number): Promise<PointGeologyResult> {
  const [corroboration, siteConcentration, tideState] = await Promise.all([
    fetchGeologyCorroboration(easting, northing),
    fetchSiteConcentration(easting, northing),
    fetchTideState(easting, northing),
  ]);
  if (!corroboration) {
    return {
      ok: false,
      stage: "no-geology-data",
      message: "BGS has no mapped geology at this point either, so there is nothing to infer solids character from.",
    };
  }
  const flags = assessSiteFlags(
    null, // no NRFA catchment at all on this path - algae flag is honestly insufficient-data
    { bedrock: corroboration.bedrockLithology ?? null, superficial: corroboration.superficialLithology ?? null },
  );
  const satelliteTurbidity = await fetchSatelliteTurbidity(easting, northing, tideState);

  return {
    ok: true,
    geologyStatement: corroboration.statement,
    siteConcentration,
    flags,
    tideState,
    satelliteTurbidity,
    characterInference: inferCharacterFromGeologyOnly(corroboration),
  };
}
