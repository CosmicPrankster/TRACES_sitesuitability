import { wgs84ToBng } from "../../scripts/lib/bng.mjs";

/**
 * BLOCK 6, rebuild phase 5 - tide state for estuarine sites, from the
 * Admiralty UK Tidal API (Discovery tier). Proven live during source-
 * probing (see BUILD.md): a real 607-station list, and real high/low-water
 * events (heights + times) for the nearest station.
 *
 * Per the rebuild plan, tide state does NOT say what the sediment is - it
 * says how much to trust ANY reading taken right now. It is reported
 * alongside the main result, the same way lib/flags.ts's algae/inhibition
 * flags are, never blended into the mineral-character verdict.
 *
 * One real quirk this module works around, found during probing: at the
 * Discovery tier, LowWater events carry a Date but NO DateTime or Height -
 * only HighWater events do. Every calculation here uses HighWater events
 * only, never invents a low-water time or height to fill the gap.
 *
 * Two more honesty notes, named here so they aren't rediscovered later:
 *
 * - "Nearby a real tide station" is used as the only available proxy for
 *   "this site is tidal" - there is no direct estuary/tidal-limit dataset
 *   wired into this tool. A site far from every real tide station is
 *   treated as non-estuarine and this tier is skipped entirely, not
 *   guessed at.
 * - Spring/neap is read relative to the heights seen in whatever window
 *   was actually fetched (typically 7 days), not a full 14-day cycle or a
 *   harmonic-constant calculation this API tier doesn't expose. It is
 *   deliberately coarse and says so in its own reasoning text.
 */

const BASE = "https://admiraltyapi.azure-api.net/uktidalapi";
const TIMEOUT_MS = 20000;
const USER_AGENT = "traces-site-suitability/0.2 (screening tool; see README)";

/** A site more than this far from every real tide station is treated as non-estuarine, not guessed either way. */
const NEARBY_STATION_KM = 5;

async function getJson<T>(url: string, apiKey: string): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, "Ocp-Apim-Subscription-Key": apiKey },
    });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface TideStationFeature {
  geometry: { type: "Point"; coordinates: [number, number] }; // [lon, lat]
  properties: { Id: string; Name: string; Country?: string };
}

export interface NearestTideStation {
  id: string;
  name: string;
  distanceKm: number;
}

/**
 * The pure part of the nearest-station search: rank real stations by real
 * distance (BNG, reusing lib/resolve.ts's own projected-Euclidean
 * convention), and gate on NEARBY_STATION_KM. Exported so it's directly
 * testable against a real captured station list.
 */
export function pickNearestTideStation(
  stations: TideStationFeature[],
  easting: number,
  northing: number,
): NearestTideStation | null {
  let nearest: NearestTideStation | null = null;
  for (const s of stations) {
    const [lon, lat] = s.geometry.coordinates;
    const stationBng = wgs84ToBng(lat, lon);
    const distanceKm = Math.hypot(stationBng.easting - easting, stationBng.northing - northing) / 1000;
    if (!nearest || distanceKm < nearest.distanceKm) {
      nearest = { id: s.properties.Id, name: s.properties.Name, distanceKm };
    }
  }
  if (!nearest || nearest.distanceKm > NEARBY_STATION_KM) return null;
  return nearest;
}

export async function findNearestTideStation(
  easting: number,
  northing: number,
  apiKey: string,
): Promise<NearestTideStation | null> {
  const body = await getJson<{ features: TideStationFeature[] }>(`${BASE}/api/V1/Stations`, apiKey);
  return pickNearestTideStation(body?.features ?? [], easting, northing);
}

export interface TidalEvent {
  EventType: "HighWater" | "LowWater";
  DateTime?: string;
  Height?: number;
  Date: string;
}

export type TidePhase = "flooding" | "ebbing" | "unknown";
export type SpringNeapReading = "closer-to-spring" | "closer-to-neap" | "mid-cycle" | "unknown";

/**
 * Brackets `now` between the two real HighWater times either side of it
 * (LowWater events carry no usable time at this API tier - see module
 * header) and reads which half of that roughly-12.5-hour interval `now`
 * falls in: the first half is still falling from the previous high (ebb),
 * the second half is rising toward the next one (flood). An approximation
 * of the real semi-diurnal cycle from the only real timestamps available,
 * not a harmonic calculation.
 */
export function determineTidePhase(events: TidalEvent[], now: Date): { phase: TidePhase; reasoning: string } {
  const highWaters = events
    .filter((e): e is TidalEvent & { DateTime: string } => e.EventType === "HighWater" && typeof e.DateTime === "string")
    .map((e) => ({ time: new Date(e.DateTime), height: e.Height }))
    .sort((a, b) => a.time.getTime() - b.time.getTime());

  let prev: (typeof highWaters)[number] | undefined;
  let next: (typeof highWaters)[number] | undefined;
  for (const hw of highWaters) {
    if (hw.time <= now) prev = hw;
    else if (!next) next = hw;
  }

  if (!prev || !next) {
    return {
      phase: "unknown",
      reasoning: "The fetched tidal-event window doesn't bracket the current time with two real high-water readings, so the flood/ebb state can't be read.",
    };
  }

  const fraction = (now.getTime() - prev.time.getTime()) / (next.time.getTime() - prev.time.getTime());
  if (fraction < 0.5) {
    return {
      phase: "ebbing",
      reasoning: `High water was at ${prev.time.toISOString().slice(11, 16)} - the tide has been falling since, heading toward the next low before it turns again at the next high water (${next.time.toISOString().slice(11, 16)}).`,
    };
  }
  return {
    phase: "flooding",
    reasoning: `The tide is rising toward the next high water at ${next.time.toISOString().slice(11, 16)}, having turned from the low some time after the previous high (${prev.time.toISOString().slice(11, 16)}).`,
  };
}

/**
 * Ranks the real HighWater height nearest `now` against the min/max HEIGHTS
 * actually seen in the fetched window - see the module header's honesty
 * note on why this is relative to the window, not a true 14-day spring/
 * neap phase.
 */
export function determineSpringNeap(events: TidalEvent[], now: Date): { reading: SpringNeapReading; reasoning: string } {
  const highWaters = events
    .filter((e): e is TidalEvent & { DateTime: string; Height: number } => e.EventType === "HighWater" && typeof e.DateTime === "string" && typeof e.Height === "number")
    .map((e) => ({ time: new Date(e.DateTime), height: e.Height }));

  if (highWaters.length < 2) {
    return { reading: "unknown", reasoning: "Too few real high-water heights in the fetched window to judge spring/neap state." };
  }

  const heights = highWaters.map((h) => h.height);
  const min = Math.min(...heights);
  const max = Math.max(...heights);

  const nearest = highWaters.reduce((best, h) => (Math.abs(h.time.getTime() - now.getTime()) < Math.abs(best.time.getTime() - now.getTime()) ? h : best));

  if (max - min < 0.05) {
    return {
      reading: "mid-cycle",
      reasoning: `High water has stayed close to ${nearest.height.toFixed(1)} m across the fetched window - too little spread to place this in the spring/neap cycle from this window alone.`,
    };
  }

  const position = (nearest.height - min) / (max - min);
  const windowNote = `(relative to the ${min.toFixed(1)}-${max.toFixed(1)} m range seen over the fetched window, not the full 14-day cycle)`;

  if (position >= 0.66) {
    return {
      reading: "closer-to-spring",
      reasoning: `Today's high water (${nearest.height.toFixed(1)} m) is toward the top of what's been seen recently ${windowNote} - bigger tides, stronger currents, more resuspension: treat any single reading taken now as less representative of a typical day than one taken nearer neap tide.`,
    };
  }
  if (position <= 0.33) {
    return {
      reading: "closer-to-neap",
      reasoning: `Today's high water (${nearest.height.toFixed(1)} m) is toward the bottom of what's been seen recently ${windowNote} - smaller tides, weaker currents: a reading taken now is likely more representative of calm conditions than one taken nearer spring tide.`,
    };
  }
  return {
    reading: "mid-cycle",
    reasoning: `Today's high water (${nearest.height.toFixed(1)} m) sits in the middle of what's been seen recently ${windowNote} - neither a spring nor a neap extreme.`,
  };
}

export interface TideState {
  station: NearestTideStation;
  phase: TidePhase;
  springNeap: SpringNeapReading;
  reasoning: string;
}

/**
 * The whole tier in one call: skips entirely (returns null) for a site
 * nowhere near a real tide station - see pickNearestTideStation. Needs a
 * real ADMIRALTY_TIDE_API_KEY; with none set, callers should treat this as
 * SKIPPED, the same distinct outcome scripts/probe-new-sources.mjs already
 * uses for a missing key, not a failure.
 */
export async function screenTideState(
  easting: number,
  northing: number,
  apiKey: string,
  now: Date = new Date(),
): Promise<TideState | null> {
  const station = await findNearestTideStation(easting, northing, apiKey);
  if (!station) return null;

  const events = await getJson<TidalEvent[]>(`${BASE}/api/V1/Stations/${encodeURIComponent(station.id)}/TidalEvents?duration=7`, apiKey);
  if (!events) return null;

  const { phase, reasoning: phaseReasoning } = determineTidePhase(events, now);
  const { reading: springNeap, reasoning: springNeapReasoning } = determineSpringNeap(events, now);

  return {
    station,
    phase,
    springNeap,
    reasoning: `${phaseReasoning} ${springNeapReasoning}`,
  };
}
