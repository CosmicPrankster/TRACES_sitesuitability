import type { SiteDataFragment, SiteDataProvider, SiteLookupContext } from "@/types";
import { findCuratedSite } from "@/data/sites";

/**
 * Reads the hand-curated site store in `data/sites.ts`.
 *
 * This provider needs no network, so it is what makes the application usable
 * offline and in tests. It never invents anything: if the query does not match
 * a curated site it returns `no_data`.
 */
export const localKnowledgeProvider: SiteDataProvider = {
  id: "local-knowledge",
  name: "Curated site knowledge (data/sites.ts)",

  async getSiteData(location: string, _ctx: SiteLookupContext): Promise<SiteDataFragment> {
    const site = findCuratedSite(location);

    if (!site) {
      return {
        report: {
          providerId: "local-knowledge",
          providerName: localKnowledgeProvider.name,
          status: "no_data",
          message: `No curated entry matches "${location}". Add one in data/sites.ts to record what you already know.`,
        },
      };
    }

    return {
      report: {
        providerId: "local-knowledge",
        providerName: localKnowledgeProvider.name,
        status: "ok",
        message: `Matched curated entry "${site.name}" (${site.data.length} datum(s)).`,
      },
      resolvedName: site.name,
      waterBody: site.waterBody,
      waterBodyType: site.waterBodyType,
      catchment: site.catchment,
      geologyNotes: site.geologyNotes,
      landUseNotes: site.landUseNotes,
      particleCharacter: site.particleCharacter,
      particleCharacterProvenance: site.particleCharacterProvenance,
      data: site.data,
      unknowns: site.unknowns,
    };
  },
};
