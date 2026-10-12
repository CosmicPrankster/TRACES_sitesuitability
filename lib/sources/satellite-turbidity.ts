import { bngToWgs84 } from "../../scripts/lib/bng.mjs";

/**
 * BLOCK 6, rebuild phase 6 - satellite turbidity, from the Copernicus Data
 * Space Ecosystem's Sentinel Hub-compatible Statistical API. The LAST
 * source this project ever guessed at, and the one that took the most
 * rounds to get right - three real, different HTTP errors, one proven
 * success (see HANDOFF.md for the full blow-by-blow):
 *
 *   v1  bbox in EPSG:4326 (degrees)        -> HTTP 400, pixel size too
 *       with bare resx/resy: 10               large: resx/resy read in the
 *                                              bbox's own CRS units (10
 *                                              DEGREES, not 10 metres)
 *   v2  bbox switched to EPSG:3857 (metres) -> HTTP 400, "Output dataMask
 *                                               requested but missing from
 *                                               function setup()" - the
 *                                               Statistical API needs an
 *                                               EXPLICIT dataMask output,
 *                                               not just a dataMask input
 *   v3  explicit data+dataMask outputs      -> HTTP 200, real NDTI stats
 *
 * What this tier IS: a real, live, 30-day NDTI (Normalized Difference
 * Turbidity Index, Lacaux et al. 1996 - a real published Sentinel-2
 * red/green turbidity proxy) aggregate over a ~2.2 km box around the site.
 *
 * What this tier is NOT, and never claims to be:
 *   - A point reading. The Statistical API aggregates every valid pixel in
 *     the whole bbox into one mean/min/max/stDev - useful only when that
 *     box is dominated by open water. A small river's few-metres-wide
 *     channel is a sliver of a 2.2 km box; the reading would mostly
 *     describe the surrounding land, not the water. This is exactly the
 *     plan's own gating rule: "gated to estuaries/large rivers where the
 *     pixel size is actually meaningful; not used on small watercourses."
 *   - A concentration. NDTI is a relative index (roughly: higher = more
 *     turbid), not a measured mg/L figure - Lacaux et al.'s own published
 *     calibration is for specific African rivers and sensors, and no
 *     general NDTI->mg/L conversion is wired in here, because none is
 *     defensible without site-specific calibration this project doesn't
 *     have. The raw index and its real sample/noData counts are reported
 *     as context, the same discipline lib/field-update.ts applies to a
 *     turbidity-tube reading - never converted into a number this tool
 *     scores on.
 *
 * Gating: this tier is only fetched for a site that ALREADY has a nearby
 * real tide station (lib/sources/tide.ts) - reusing that already-proven
 * "wide tidal water nearby" signal as the proxy for "the aggregation box
 * is plausibly water-dominated," rather than inventing a second, unproven
 * land/water classifier. An inland site with no nearby tide station skips
 * this tier entirely, the same as tide state itself. This also keeps the
 * extra OAuth2 round-trip off the common case: most sites this tool
 * screens are inland.
 */

const TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const STATISTICS_URL = "https://sh.dataspace.copernicus.eu/api/v1/statistics";
const TIMEOUT_MS = 20000;

/** Web Mercator sphere radius, metres - the real, proven CRS the Statistical API needs for a metres-based bbox+resolution (see module header, v1->v2). */
const MERCATOR_R = 6378137;
/** Half-width of the aggregation box, metres - same real-world scale as the probe script that proved this shape. */
const HALF_BOX_M = 1100;
/** The window the aggregate covers - 30 days, to smooth over Sentinel-2's ~5-day (cloud-dependent) revisit rather than demand one single clear pass. */
const WINDOW_DAYS = 30;

export function toWebMercator(lonDeg: number, latDeg: number): { x: number; y: number } {
  return {
    x: (lonDeg * Math.PI * MERCATOR_R) / 180,
    y: MERCATOR_R * Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360)),
  };
}

async function fetchCopernicusToken(clientId: string, clientSecret: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
    return body?.access_token ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The proven v3 evalscript: NDTI from B04 (red) / B03 (green), with the Statistical API's required explicit dataMask output. */
const EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B03", "dataMask"] }],
    output: [
      { id: "data", bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(s) {
  return {
    data: [(s.B04 - s.B03) / (s.B04 + s.B03 + 1e-6)],
    dataMask: [s.dataMask]
  };
}`;

/** The proven v3 request body shape. Exported so it's directly testable without a network call. */
export function buildStatisticsRequestBody(centerX: number, centerY: number, from: Date, to: Date) {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    input: {
      bounds: {
        bbox: [centerX - HALF_BOX_M, centerY - HALF_BOX_M, centerX + HALF_BOX_M, centerY + HALF_BOX_M],
        properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/3857" },
      },
      data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from: `${iso(from)}T00:00:00Z`, to: `${iso(to)}T23:59:59Z` }, maxCloudCoverage: 60 } }],
    },
    aggregation: {
      timeRange: { from: `${iso(from)}T00:00:00Z`, to: `${iso(to)}T23:59:59Z` },
      aggregationInterval: { of: `P${WINDOW_DAYS}D` },
      evalscript: EVALSCRIPT,
      resx: 10,
      resy: 10,
    },
  };
}

/** The real response shape proven live 2026-10-12 (see HANDOFF.md) - this interface matches that body exactly. */
export interface SentinelStatisticsResponse {
  data: {
    interval: { from: string; to: string };
    outputs: {
      data: {
        bands: {
          B0: {
            stats: { min: number; max: number; mean: number; stDev: number; sampleCount: number; noDataCount: number };
          };
        };
      };
    };
  }[];
  status: string;
}

export interface SatelliteTurbidity {
  /** NDTI mean over the aggregation window and box - a relative index, not a concentration. Higher is more turbid. */
  ndtiMean: number;
  ndtiMin: number;
  ndtiMax: number;
  stDev: number;
  sampleCount: number;
  noDataCount: number;
  windowFrom: string;
  windowTo: string;
  reasoning: string;
}

/**
 * Pure parse of a real Statistical API response into the plain-English-
 * ready shape above. Returns null for a response with no usable interval
 * (e.g. zero cloud-free pixels across the whole window) - insufficient
 * data, not a guessed reading.
 */
export function parseStatisticsResponse(body: SentinelStatisticsResponse): SatelliteTurbidity | null {
  const first = body.data?.[0];
  const stats = first?.outputs?.data?.bands?.B0?.stats;
  if (!first || !stats || !(stats.sampleCount > 0)) return null;

  const validFraction = stats.sampleCount / (stats.sampleCount + stats.noDataCount);
  const reasoning =
    `Sentinel-2 NDTI (Normalized Difference Turbidity Index) averaged over a ~${((2 * HALF_BOX_M) / 1000).toFixed(1)} km box ` +
    `around the site, ${first.interval.from.slice(0, 10)} to ${first.interval.to.slice(0, 10)}: mean ${stats.mean.toFixed(3)} ` +
    `(range ${stats.min.toFixed(3)} to ${stats.max.toFixed(3)}, ${stats.sampleCount} of ${stats.sampleCount + stats.noDataCount} ` +
    `pixels cloud-free (${(validFraction * 100).toFixed(0)}%)). This is a RELATIVE index, not a measured concentration - no ` +
    `general NDTI-to-mg/L conversion is used here, because none is defensible without site-specific calibration this tool ` +
    `doesn't have. It also averages across the whole box, most of which is land unless the water here is wide - read as ` +
    `rough context alongside the main result, never as an input to it.`;

  return {
    ndtiMean: stats.mean,
    ndtiMin: stats.min,
    ndtiMax: stats.max,
    stDev: stats.stDev,
    sampleCount: stats.sampleCount,
    noDataCount: stats.noDataCount,
    windowFrom: first.interval.from,
    windowTo: first.interval.to,
    reasoning,
  };
}

/**
 * The whole tier in one call. Returns null (skipped, not failed) whenever:
 * no OAuth2 token could be obtained (missing/invalid credentials), the
 * Statistical API itself errors, or the response has no usable pixels.
 * Callers should gate calling this at all behind an already-known-nearby
 * tide station - see the module header's gating rationale.
 */
export async function screenSatelliteTurbidity(
  easting: number,
  northing: number,
  clientId: string,
  clientSecret: string,
  now: Date = new Date(),
): Promise<SatelliteTurbidity | null> {
  const accessToken = await fetchCopernicusToken(clientId, clientSecret);
  if (!accessToken) return null;

  const { lat, lon } = bngToWgs84(easting, northing);
  const center = toWebMercator(lon, lat);
  const from = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const statsBody = buildStatisticsRequestBody(center.x, center.y, from, now);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(STATISTICS_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(statsBody),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as SentinelStatisticsResponse | null;
    return body ? parseStatisticsResponse(body) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
