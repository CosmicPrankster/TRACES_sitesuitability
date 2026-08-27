import type { SiteDataProvider } from "@/types";
import { geocodeProvider } from "./geocode";
import { localKnowledgeProvider } from "./local-knowledge";
import { eaFloodProvider } from "./ea-flood";
import { eaWaterQualityProvider } from "./ea-water-quality";
import { bgsGeologyProvider } from "./bgs-geology";

export { geocodeProvider, localKnowledgeProvider, eaFloodProvider, eaWaterQualityProvider, bgsGeologyProvider };

/**
 * Providers that need no network. Always run.
 */
export const offlineProviders: SiteDataProvider[] = [localKnowledgeProvider];

/**
 * Providers that need coordinates. Run after geocoding, and only when remote
 * lookups are enabled.
 *
 * To add a source: implement `SiteDataProvider`, then append it here. Nothing
 * else in the application needs to change.
 */
export const remoteProviders: SiteDataProvider[] = [
  eaFloodProvider,
  eaWaterQualityProvider,
  bgsGeologyProvider,
];
