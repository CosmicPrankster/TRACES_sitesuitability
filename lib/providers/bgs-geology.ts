import type { SiteDataFragment, SiteDataProvider, SiteLookupContext } from "@/types";

/**
 * Placeholder for a BGS bedrock/superficial-deposits lookup.
 *
 * Catchment geology is the strongest available predictor of the mineral
 * fraction of a river's suspended load, so this is the highest-value source
 * still to be wired in. It is deliberately NOT implemented against a guessed
 * endpoint: returning invented geology would be worse than returning nothing.
 *
 * To implement it, replace the body below with a call to a BGS service you have
 * confirmed the response schema of, and emit `SiteDatum` records with
 * `provenance: "published"` and the real service URL. Until then this provider
 * reports honestly that the datum is missing and hands the user a link to check
 * it manually.
 */
export const bgsGeologyProvider: SiteDataProvider = {
  id: "bgs-geology",
  name: "British Geological Survey - bedrock and superficial deposits",

  async getSiteData(_location: string, ctx: SiteLookupContext): Promise<SiteDataFragment> {
    const hasCoords = ctx.latitude !== undefined && ctx.longitude !== undefined;
    const where = hasCoords
      ? ` for ${ctx.latitude?.toFixed(5)}, ${ctx.longitude?.toFixed(5)}`
      : "";

    return {
      report: {
        providerId: "bgs-geology",
        providerName: bgsGeologyProvider.name,
        status: "skipped",
        message:
          "Not implemented. An automated geology lookup is not wired in, so catchment " +
          `geology${where} has not been retrieved. Check it manually in BGS GeoIndex.`,
        sourceUrl: "https://mapapps2.bgs.ac.uk/geoindex/home.html",
      },
      unknowns: [
        "Catchment bedrock and superficial geology have not been retrieved automatically. " +
          "Geology is the strongest available indicator of the mineral fraction and likely " +
          "coarseness of the suspended load, so confirming it would materially improve confidence.",
      ],
    };
  },
};
