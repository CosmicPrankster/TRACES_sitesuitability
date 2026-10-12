import { bngToWgs84, wgs84ToBng } from "../../scripts/lib/bng.mjs";

/**
 * BLOCK 6, rebuild phase 3 - real, measured water quality near a site, from
 * the EA's Water Quality Archive. Proven live during source-probing (see
 * BUILD.md's "rebuild phase 3" section): a real geo search over real
 * sampling points, and real observation records for one of them, both
 * against the actual (not guessed) response shapes - `scripts/probe.mjs`'s
 * original five guessed URL forms for this source all failed; this is a
 * different, modern API surface, re-found and proven this session.
 *
 * Two things this deliberately does NOT do, and why:
 *
 * - It does not filter by a memorised determinand NOTATION code. Every
 *   observation record already self-describes its own determinand
 *   (observedProperty.prefLabel) and unit (hasResult.hasUnit.prefLabel) -
 *   classifying on that real, present-in-every-record label is more robust
 *   than trusting a short code fetched once and hardcoded, and sidesteps
 *   the host's flaky gateway block that two separate attempts to fetch the
 *   determinand codelist both hit (see BUILD.md) - nothing here depends on
 *   that codelist ever resolving.
 *
 * - It does not treat a turbidity reading (optical, NTU/FNU) as if it were
 *   a suspended-solids CONCENTRATION (gravimetric, mg/L) - they measure
 *   different things, and lib/baseline.ts's siteConcentrationMgL parameter
 *   specifically wants the latter. The two are returned as separate,
 *   honestly labelled reading lists; only a real suspended-solids mg/L
 *   reading is suitable to feed into the baseline-volume calibration.
 */

const BASE = "https://environment.data.gov.uk/water-quality";
const TIMEOUT_MS = 20000;
const USER_AGENT = "traces-site-suitability/0.2 (screening tool; see README)";

async function getJson<T>(url: string, accept: string): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: accept, "User-Agent": USER_AGENT } });
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

interface HydraCollection<T> {
  totalItems?: number;
  member?: T[];
}

export interface SamplingPointFeature {
  geometry: { type: "Point"; coordinates: [number, number] }; // [lon, lat]
  properties: { name: string; status: string; type: string; notation: string };
}

/**
 * Real type labels found for an ordinary river/stream reading - confirmed
 * from the sampling-point-type codelist and real nearby points (BUILD.md,
 * rebuild phase 3): "FRESHWATER - UNSPECIFIED" (the general case, what every
 * real point found near the project's reference site used) and "FRESHWATER
 * - RIVERS" (a more specific code that exists in the same codelist, for a
 * site that happens to use it). Deliberately excludes the other real codes
 * in the same codelist - lakes/ponds/reservoirs, canals, land drains,
 * bathing water, river transfer/augmentation/comparative-inlet points - a
 * different hydrology question, and groundwater/sewage/trade-discharge
 * points, which is what most of a naive nearby search actually turns up.
 */
const RIVER_POINT_TYPES = new Set(["FRESHWATER - UNSPECIFIED", "FRESHWATER - RIVERS"]);

export interface NearbyRiverPoint {
  notation: string;
  name: string;
  distanceKm: number;
}

/**
 * The pure part of the nearby-point search: filter a real sampling-point
 * search response down to ordinary river/stream points and rank by real
 * distance, in BNG (reusing lib/resolve.ts's own convention of a projected
 * Euclidean distance rather than a separate haversine formula). Exported so
 * it can be tested directly against a real captured response body, the
 * same way character.ts's fromNrfaRecord is tested against a real NRFA
 * record - without mocking fetch.
 */
export function pickNearbyRiverPoints(
  items: SamplingPointFeature[],
  easting: number,
  northing: number,
): NearbyRiverPoint[] {
  return items
    .filter((p) => RIVER_POINT_TYPES.has(p.properties?.type))
    .map((p) => {
      const [plon, plat] = p.geometry.coordinates;
      const pointBng = wgs84ToBng(plat, plon);
      const distanceKm = Math.hypot(pointBng.easting - easting, pointBng.northing - northing) / 1000;
      return { notation: p.properties.notation, name: p.properties.name, distanceKm };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Finds real ambient river/stream sampling points within radiusKm of a BNG point, nearest first. */
export async function findNearbyRiverPoints(
  easting: number,
  northing: number,
  radiusKm = 25,
  limit = 20,
): Promise<NearbyRiverPoint[]> {
  const { lat, lon } = bngToWgs84(easting, northing);
  const body = await getJson<HydraCollection<SamplingPointFeature>>(
    `${BASE}/sampling-point?latitude=${lat}&longitude=${lon}&radius=${radiusKm}&limit=${limit}`,
    "application/geo+json",
  );
  return pickNearbyRiverPoints(body?.member ?? [], easting, northing);
}

export interface WaterQualityReading {
  determinandNotation: string;
  determinandLabel: string;
  /** ISO phenomenonTime - when the sample was actually taken, not when it was published. */
  date: string;
  /** null for a censored result (see `censored`) - never a guessed point value. */
  value: number | null;
  /** A "less than"/"more than" result, e.g. "<3 mg/l" - real EA data includes these, not every reading is a clean point value. */
  censored: { bound: "upper" | "lower"; value: number } | null;
  unit: string;
}

export interface ObservationRecord {
  phenomenonTime?: string | null;
  observedProperty?: { notation?: string; prefLabel?: string };
  hasResult?: {
    numericValue?: number | null;
    upperBound?: number | null;
    lowerBound?: number | null;
    hasUnit?: { prefLabel?: string };
  } | null;
}

/**
 * Maps one real observation record onto this module's reading shape.
 * Exported for the same reason as pickNearbyRiverPoints: testable directly
 * against a real captured record, no fetch mocking.
 */
export function toReading(o: ObservationRecord): WaterQualityReading | null {
  const notation = o.observedProperty?.notation;
  if (!o.phenomenonTime || !notation) return null;
  const result = o.hasResult;
  const value = typeof result?.numericValue === "number" ? result.numericValue : null;
  const censored: WaterQualityReading["censored"] =
    typeof result?.upperBound === "number"
      ? { bound: "upper", value: result.upperBound }
      : typeof result?.lowerBound === "number"
        ? { bound: "lower", value: result.lowerBound }
        : null;
  return {
    determinandNotation: notation,
    determinandLabel: o.observedProperty?.prefLabel ?? "?",
    date: o.phenomenonTime,
    value,
    censored,
    unit: result?.hasUnit?.prefLabel ?? "?",
  };
}

export interface RiverWaterQuality {
  pointNotation: string;
  /** Newest first. Optical turbidity (NTU/FNU) - NOT a concentration. */
  turbidity: WaterQualityReading[];
  /** Newest first. Gravimetric suspended-solids concentration, mg/L - the one suitable for lib/baseline.ts's siteConcentrationMgL. */
  suspendedSolidsMgL: WaterQualityReading[];
}

/**
 * Splits a set of real readings into turbidity and suspended-solids-
 * concentration lists, each newest first, by each reading's own label and
 * unit - see the module header for why this classifies on the real,
 * self-describing text rather than a memorised notation code. Exported and
 * kept separate from the actual fetch so it's directly testable against
 * real captured records.
 */
export function classifyReadings(readings: WaterQualityReading[]): Omit<RiverWaterQuality, "pointNotation"> {
  const newestFirst = (a: WaterQualityReading, b: WaterQualityReading) => b.date.localeCompare(a.date);

  const turbidity = readings
    .filter((r) => r.determinandLabel.toLowerCase().includes("turbidity"))
    .sort(newestFirst);

  const suspendedSolidsMgL = readings
    .filter((r) => {
      const label = r.determinandLabel.toLowerCase();
      return label.includes("solid") && label.includes("suspend") && r.unit.toLowerCase().includes("milligram");
    })
    .sort(newestFirst);

  return { turbidity, suspendedSolidsMgL };
}

/**
 * Real observations for a point, within a recency window, classified
 * client-side by each record's own determinand label (see module header).
 * Neither list is guaranteed non-empty: EA ambient river monitoring is
 * sparse and declining at many points, and this project's rule is that
 * insufficient data is reported honestly, not papered over (HANDOFF.md) -
 * an empty list here is exactly that, not a bug.
 */
export async function fetchRiverWaterQuality(
  pointNotation: string,
  { yearsBack = 10, limit = 250 }: { yearsBack?: number; limit?: number } = {},
): Promise<RiverWaterQuality> {
  const dateFrom = new Date();
  dateFrom.setFullYear(dateFrom.getFullYear() - yearsBack);
  const body = await getJson<HydraCollection<ObservationRecord>>(
    `${BASE}/sampling-point/${encodeURIComponent(pointNotation)}/observation` +
      `?dateFrom=${dateFrom.toISOString().slice(0, 10)}&limit=${limit}`,
    "application/ld+json",
  );
  const readings = (body?.member ?? [])
    .map(toReading)
    .filter((r): r is WaterQualityReading => r !== null);

  return { pointNotation, ...classifyReadings(readings) };
}

export type RiverWaterQualityResult =
  | { ok: true; point: NearbyRiverPoint; data: RiverWaterQuality }
  | { ok: false; reason: "no-river-point-nearby" };

/** The whole tier in one call: nearest real river/stream point, then its recent readings. */
export async function screenRiverWaterQuality(
  easting: number,
  northing: number,
  radiusKm = 25,
): Promise<RiverWaterQualityResult> {
  const points = await findNearbyRiverPoints(easting, northing, radiusKm);
  if (points.length === 0) return { ok: false, reason: "no-river-point-nearby" };
  const nearest = points[0];
  const data = await fetchRiverWaterQuality(nearest.notation);
  return { ok: true, point: nearest, data };
}
