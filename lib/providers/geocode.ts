import type { SiteDataFragment, SiteDataProvider, SiteLookupContext } from "@/types";
import { fetchJson } from "./http";

interface NominatimItem {
  lat: string;
  lon: string;
  display_name: string;
  type?: string;
  class?: string;
  addresstype?: string;
  address?: Record<string, string>;
}

/**
 * Resolves a free-text location to coordinates using OpenStreetMap Nominatim.
 *
 * Nominatim is free and requires no key, but its usage policy asks for an
 * identifiable User-Agent - set SITE_DATA_USER_AGENT in the environment.
 * This provider must run first: the others need coordinates.
 */
export const geocodeProvider: SiteDataProvider = {
  id: "nominatim",
  name: "OpenStreetMap Nominatim (geocoding)",

  async getSiteData(location: string, ctx: SiteLookupContext): Promise<SiteDataFragment> {
    const started = Date.now();
    const url =
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=" +
      encodeURIComponent(location);

    const res = await fetchJson<NominatimItem[]>(url, {
      timeoutMs: ctx.timeoutMs,
      userAgent: ctx.userAgent,
      fetchImpl: ctx.fetchImpl,
    });
    const durationMs = Date.now() - started;

    if (!res.ok) {
      return {
        report: {
          providerId: "nominatim",
          providerName: geocodeProvider.name,
          status: "error",
          message: `Could not geocode "${location}": ${res.error}. Coordinate-based lookups were skipped.`,
          sourceUrl: url,
          durationMs,
        },
        unknowns: ["Site coordinates could not be resolved, so no location-based data could be retrieved."],
      };
    }

    const item = res.data?.[0];
    if (!item) {
      return {
        report: {
          providerId: "nominatim",
          providerName: geocodeProvider.name,
          status: "no_data",
          message: `No geocoding match for "${location}".`,
          sourceUrl: url,
          durationMs,
        },
        unknowns: [`The location "${location}" could not be matched to a place, so no site data was retrieved.`],
      };
    }

    const latitude = Number.parseFloat(item.lat);
    const longitude = Number.parseFloat(item.lon);
    const country = item.address?.country;

    return {
      report: {
        providerId: "nominatim",
        providerName: geocodeProvider.name,
        status: "ok",
        message: `Resolved to ${item.display_name}.`,
        sourceUrl: url,
        durationMs,
      },
      resolvedName: item.display_name,
      latitude,
      longitude,
      country,
      data: [
        {
          parameter: "Resolved location",
          value: item.display_name,
          provenance: "published",
          confidence: "medium",
          source: "OpenStreetMap Nominatim geocoding",
          sourceUrl: "https://nominatim.openstreetmap.org/",
          date: new Date().toISOString().slice(0, 10),
          notes: "Geocoding matches a name to a point; it does not confirm the abstraction point.",
        },
        {
          parameter: "Coordinates",
          value: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
          unit: "WGS84",
          provenance: "published",
          confidence: "medium",
          source: "OpenStreetMap Nominatim geocoding",
          sourceUrl: "https://nominatim.openstreetmap.org/",
        },
      ],
    };
  },
};
