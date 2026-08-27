import type { SiteDataFragment, SiteDataProvider, SiteLookupContext } from "@/types";
import { fetchJson } from "./http";

/**
 * Resolves a free-text location to coordinates.
 *
 * THIS IS THE MOST LOAD-BEARING PROVIDER IN THE APPLICATION. Every other
 * lookup - river gauges, water quality, geology - needs coordinates, so if this
 * fails they all skip, the solids character stays unknown, and every site
 * collapses to the same default matrix.
 *
 * It therefore tries several independent backends in turn rather than trusting
 * any single one:
 *
 *   1. Open-Meteo geocoding. No key, no User-Agent policy, no rate limit worth
 *      worrying about. Tried FIRST precisely because it is the least likely to
 *      refuse us.
 *   2. OpenStreetMap Nominatim. Better at full descriptive strings
 *      ("Tilford, River Wey"), but it blocks generic User-Agents and rate-limits
 *      aggressively, so it cannot be the only option.
 *
 * Each backend is tried with the full query and then, if that fails, with just
 * the first comma-separated part - "Kinness Burn, St Andrews" becomes
 * "Kinness Burn" - because gazetteers often hold the place but not the phrase.
 */

interface Candidate {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  via: string;
}

interface OpenMeteoResponse {
  results?: {
    name?: string;
    latitude?: number;
    longitude?: number;
    country?: string;
    admin1?: string;
    admin2?: string;
  }[];
}

interface NominatimItem {
  lat: string;
  lon: string;
  display_name: string;
  address?: Record<string, string>;
}

/** Query variants to try, most specific first. */
function queryVariants(location: string): string[] {
  const trimmed = location.trim();
  const parts = trimmed
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const variants = [trimmed];
  // "Kinness Burn, St Andrews" -> try the settlement, then the feature.
  if (parts.length > 1) {
    variants.push(parts[parts.length - 1]);
    variants.push(parts[0]);
  }
  return [...new Set(variants)].filter((v) => v.length > 1);
}

async function tryOpenMeteo(
  query: string,
  ctx: SiteLookupContext,
): Promise<{ candidate?: Candidate; url: string; error?: string }> {
  const url =
    "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=" +
    encodeURIComponent(query);
  const res = await fetchJson<OpenMeteoResponse>(url, {
    timeoutMs: ctx.timeoutMs,
    userAgent: ctx.userAgent,
    fetchImpl: ctx.fetchImpl,
  });
  if (!res.ok) return { url, error: res.error };

  const r = res.data?.results?.[0];
  if (!r || typeof r.latitude !== "number" || typeof r.longitude !== "number") {
    return { url, error: "no match" };
  }
  return {
    url,
    candidate: {
      name: [r.name, r.admin2, r.admin1, r.country].filter(Boolean).join(", "),
      latitude: r.latitude,
      longitude: r.longitude,
      country: r.country,
      via: "Open-Meteo geocoding",
    },
  };
}

async function tryNominatim(
  query: string,
  ctx: SiteLookupContext,
): Promise<{ candidate?: Candidate; url: string; error?: string }> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=" +
    encodeURIComponent(query);
  const res = await fetchJson<NominatimItem[]>(url, {
    timeoutMs: ctx.timeoutMs,
    userAgent: ctx.userAgent,
    fetchImpl: ctx.fetchImpl,
  });
  if (!res.ok) {
    const hint =
      res.status === 403
        ? " (Nominatim rejects generic User-Agents - set SITE_DATA_USER_AGENT to something " +
          "identifiable with a contact address)"
        : res.status === 429
          ? " (rate limited)"
          : "";
    return { url, error: `${res.error}${hint}` };
  }

  const item = res.data?.[0];
  if (!item) return { url, error: "no match" };
  const latitude = Number.parseFloat(item.lat);
  const longitude = Number.parseFloat(item.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { url, error: "match had no usable coordinates" };
  }
  return {
    url,
    candidate: {
      name: item.display_name,
      latitude,
      longitude,
      country: item.address?.country,
      via: "OpenStreetMap Nominatim",
    },
  };
}

const BACKENDS = [
  { id: "open-meteo", run: tryOpenMeteo },
  { id: "nominatim", run: tryNominatim },
];

export const geocodeProvider: SiteDataProvider = {
  id: "geocode",
  name: "Geocoding (Open-Meteo, then OpenStreetMap Nominatim)",

  async getSiteData(location: string, ctx: SiteLookupContext): Promise<SiteDataFragment> {
    const started = Date.now();
    const attempts: string[] = [];
    let lastUrl: string | undefined;

    for (const variant of queryVariants(location)) {
      for (const backend of BACKENDS) {
        const result = await backend.run(variant, ctx);
        lastUrl = result.url;

        if (result.candidate) {
          const c = result.candidate;
          const exact = variant === location.trim();
          return {
            report: {
              providerId: "geocode",
              providerName: geocodeProvider.name,
              status: "ok",
              message:
                `Resolved "${variant}" to ${c.name} via ${c.via}` +
                (exact ? "." : ` (the full query "${location}" did not match, so it was shortened).`) +
                (attempts.length ? ` Earlier attempts: ${attempts.join("; ")}.` : ""),
              sourceUrl: result.url,
              durationMs: Date.now() - started,
            },
            resolvedName: c.name,
            latitude: c.latitude,
            longitude: c.longitude,
            country: c.country,
            data: [
              {
                parameter: "Resolved location",
                value: c.name,
                provenance: "published",
                confidence: "medium",
                source: c.via,
                sourceUrl: result.url,
                date: new Date().toISOString().slice(0, 10),
                notes:
                  "Geocoding matches a name to a point. It does not confirm the abstraction " +
                  "point, and for a long river the point may be far from where you intend to work.",
              },
              {
                parameter: "Coordinates",
                value: `${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`,
                unit: "WGS84",
                provenance: "published",
                confidence: "medium",
                source: c.via,
                sourceUrl: result.url,
              },
            ],
          };
        }

        attempts.push(`${backend.id}("${variant}") ${result.error ?? "failed"}`);
      }
    }

    return {
      report: {
        providerId: "geocode",
        providerName: geocodeProvider.name,
        status: "error",
        message:
          `Could not resolve "${location}" to coordinates, so every location-based lookup ` +
          `(river gauges, water quality, geology) was skipped. Tried: ${attempts.join("; ")}.`,
        sourceUrl: lastUrl,
        durationMs: Date.now() - started,
      },
      unknowns: [
        `The location "${location}" could not be resolved to coordinates, so no site data ` +
          "could be retrieved at all. Try a simpler place name, e.g. a town rather than a " +
          "river reach.",
      ],
    };
  },
};
