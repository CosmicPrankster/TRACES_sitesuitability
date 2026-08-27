import type { SiteDatum, SiteDataFragment, SiteDataProvider, SiteLookupContext } from "@/types";
import { fetchJson, haversineKm } from "./http";

/**
 * Environment Agency real-time flood-monitoring API (England, open, no key).
 * https://environment.data.gov.uk/flood-monitoring/doc/reference
 *
 * Two checks are made, both of which bear directly on solids loading:
 *
 *  1. Nearest river-level/flow station and the trend of the last readings.
 *     Suspended-solids concentration is strongly stage-dependent, and a rising
 *     limb typically carries markedly more, and coarser, material than a
 *     recession. Screening on a falling limb can badly understate the duty.
 *
 *  2. Antecedent rainfall over the last 72 hours at the nearest rainfall gauge.
 *     A wet antecedent period indicates recent catchment washoff.
 *
 * Nothing is inferred numerically from these: they are reported as context with
 * their own provenance.
 */

const BASE = "https://environment.data.gov.uk/flood-monitoring";
const SEARCH_RADIUS_KM = 15;
const ANTECEDENT_HOURS = 72;
/** Rainfall over 72 h at or above this is treated as a "wet" antecedent period. */
export const WET_ANTECEDENT_THRESHOLD_MM = 10;

interface EaStation {
  "@id"?: string;
  label?: string | string[];
  riverName?: string | string[];
  catchmentName?: string | string[];
  stationReference?: string;
  notation?: string;
  lat?: number | number[];
  long?: number | number[];
  town?: string;
  measures?: { "@id"?: string; notation?: string; parameter?: string; unitName?: string }[];
}

interface EaReading {
  dateTime?: string;
  value?: number | number[];
  measure?: string;
}

const first = <T,>(v: T | T[] | undefined): T | undefined => (Array.isArray(v) ? v[0] : v);

export const eaFloodProvider: SiteDataProvider = {
  id: "ea-flood-monitoring",
  name: "Environment Agency real-time flood monitoring (England)",

  async getSiteData(_location: string, ctx: SiteLookupContext): Promise<SiteDataFragment> {
    const started = Date.now();

    if (ctx.latitude === undefined || ctx.longitude === undefined) {
      return {
        report: {
          providerId: "ea-flood-monitoring",
          providerName: eaFloodProvider.name,
          status: "skipped",
          message: "Skipped: no coordinates were available for a radial station search.",
          durationMs: Date.now() - started,
        },
      };
    }

    const opts = { timeoutMs: ctx.timeoutMs, userAgent: ctx.userAgent, fetchImpl: ctx.fetchImpl };
    const data: SiteDatum[] = [];
    const unknowns: string[] = [];
    const messages: string[] = [];
    let waterBody: string | undefined;
    let catchment: string | undefined;

    /* ---- 1. Nearest level/flow station -------------------------------- */
    const stationsUrl =
      `${BASE}/id/stations?lat=${ctx.latitude}&long=${ctx.longitude}&dist=${SEARCH_RADIUS_KM}&_limit=50`;
    const stations = await fetchJson<{ items?: EaStation[] }>(stationsUrl, opts);

    if (stations.ok && stations.data?.items?.length) {
      const withCoords = stations.data.items
        .map((s) => ({ s, lat: first(s.lat), long: first(s.long) }))
        .filter((x) => typeof x.lat === "number" && typeof x.long === "number")
        .map((x) => ({
          ...x,
          km: haversineKm(ctx.latitude!, ctx.longitude!, x.lat as number, x.long as number),
        }))
        .sort((a, b) => a.km - b.km);

      const nearest = withCoords[0];
      if (nearest) {
        const label = first(nearest.s.label) ?? nearest.s.stationReference ?? "unnamed station";
        const river = first(nearest.s.riverName);
        const catch_ = first(nearest.s.catchmentName);
        waterBody = river;
        catchment = catch_;

        data.push({
          parameter: "Nearest EA monitoring station",
          value: `${label} (${nearest.km.toFixed(1)} km from the resolved point)`,
          provenance: "published",
          confidence: "high",
          source: "Environment Agency real-time flood-monitoring API",
          sourceUrl: stationsUrl,
          date: new Date().toISOString().slice(0, 10),
        });
        if (river) {
          data.push({
            parameter: "River",
            value: river,
            provenance: "published",
            confidence: "high",
            source: `Environment Agency station record: ${label}`,
            sourceUrl: stationsUrl,
          });
        }
        if (catch_) {
          data.push({
            parameter: "Catchment",
            value: catch_,
            provenance: "published",
            confidence: "high",
            source: `Environment Agency station record: ${label}`,
            sourceUrl: stationsUrl,
          });
        }

        /* ---- Stage trend --------------------------------------------- */
        const ref = nearest.s.stationReference ?? nearest.s.notation;
        if (ref) {
          const readingsUrl = `${BASE}/id/stations/${encodeURIComponent(ref)}/readings?_sorted&_limit=48`;
          const readings = await fetchJson<{ items?: EaReading[] }>(readingsUrl, opts);
          const items = readings.ok ? (readings.data?.items ?? []) : [];
          const series = items
            .map((r) => ({ t: r.dateTime, v: first(r.value) }))
            .filter((r): r is { t: string; v: number } => typeof r.v === "number" && !!r.t);

          if (series.length >= 4) {
            // API returns newest first when _sorted is used.
            const newest = series[0].v;
            const older = series[Math.min(series.length - 1, 11)].v;
            const delta = newest - older;
            const trend =
              Math.abs(delta) < 0.01 ? "stable" : delta > 0 ? "rising" : "falling";
            data.push({
              parameter: "River level trend (recent readings)",
              value: trend,
              provenance: "measured",
              confidence: "medium",
              source: `Environment Agency station ${ref}, latest ${series.length} readings`,
              sourceUrl: readingsUrl,
              date: series[0].t,
              notes:
                "Trend is derived from the most recent readings at the nearest station, which " +
                "may be some distance from the abstraction point. Suspended-solids " +
                "concentration is strongly stage-dependent: a rising limb usually carries " +
                "more, and coarser, material than a recession.",
            });
            messages.push(`level trend ${trend}`);
          } else {
            unknowns.push("Recent river-level readings were unavailable, so the hydrograph limb is unknown.");
          }
        }
      }
    } else {
      unknowns.push(
        "No Environment Agency river station was found within " +
          `${SEARCH_RADIUS_KM} km (this API covers England only).`,
      );
    }

    /* ---- 2. Antecedent rainfall --------------------------------------- */
    const rainStationsUrl =
      `${BASE}/id/stations?parameter=rainfall&lat=${ctx.latitude}&long=${ctx.longitude}` +
      `&dist=${SEARCH_RADIUS_KM}&_limit=20`;
    const rainStations = await fetchJson<{ items?: EaStation[] }>(rainStationsUrl, opts);
    const rainStation = rainStations.ok ? rainStations.data?.items?.[0] : undefined;
    const rainRef = rainStation?.stationReference ?? rainStation?.notation;

    if (rainRef) {
      const since = new Date(Date.now() - ANTECEDENT_HOURS * 3600 * 1000).toISOString();
      const rainUrl =
        `${BASE}/id/stations/${encodeURIComponent(rainRef)}/readings` +
        `?since=${encodeURIComponent(since)}&_limit=2000`;
      const rain = await fetchJson<{ items?: EaReading[] }>(rainUrl, opts);
      const values = (rain.ok ? (rain.data?.items ?? []) : [])
        .map((r) => first(r.value))
        .filter((v): v is number => typeof v === "number" && v >= 0);

      if (values.length > 0) {
        const totalMm = values.reduce((a, b) => a + b, 0);
        const wet = totalMm >= WET_ANTECEDENT_THRESHOLD_MM;
        data.push({
          parameter: `Antecedent rainfall (last ${ANTECEDENT_HOURS} h)`,
          value: Number(totalMm.toFixed(1)),
          unit: "mm",
          provenance: "measured",
          confidence: "medium",
          source: `Environment Agency rainfall gauge ${first(rainStation?.label) ?? rainRef}`,
          sourceUrl: rainUrl,
          date: new Date().toISOString().slice(0, 10),
          notes: wet
            ? `At or above the ${WET_ANTECEDENT_THRESHOLD_MM} mm/72 h screening threshold: recent ` +
              "catchment washoff is likely, so solids loading at the time of sampling may be " +
              "elevated relative to baseflow."
            : `Below the ${WET_ANTECEDENT_THRESHOLD_MM} mm/72 h screening threshold: conditions are ` +
              "closer to baseflow, so a sample taken now may understate the storm-event duty.",
        });
        messages.push(`${totalMm.toFixed(1)} mm rain in ${ANTECEDENT_HOURS} h`);
      }
    } else {
      unknowns.push("No Environment Agency rainfall gauge was found nearby, so antecedent rainfall is unknown.");
    }

    const durationMs = Date.now() - started;
    if (data.length === 0) {
      return {
        report: {
          providerId: "ea-flood-monitoring",
          providerName: eaFloodProvider.name,
          status: stations.ok ? "no_data" : "error",
          message: stations.ok
            ? "No Environment Agency stations returned usable data for this location."
            : `Lookup failed: ${stations.error}`,
          sourceUrl: stationsUrl,
          durationMs,
        },
        unknowns,
      };
    }

    return {
      report: {
        providerId: "ea-flood-monitoring",
        providerName: eaFloodProvider.name,
        status: "ok",
        message: `Retrieved ${data.length} datum(s)${messages.length ? `: ${messages.join(", ")}` : ""}.`,
        sourceUrl: stationsUrl,
        durationMs,
      },
      waterBody,
      waterBodyType: waterBody ? "river" : undefined,
      catchment,
      data,
      unknowns,
    };
  },
};
