import type {
  Assumption,
  ParticleCharacter,
  PSD,
  Provenance,
  SiteData,
  SiteDatum,
  SiteDataFragment,
  SiteDataProvider,
  SiteLookupContext,
  WaterBodyType,
} from "@/types";
import { offlineProviders, remoteProviders, geocodeProvider } from "./providers";
import { parsePSDFromText, psdFromPercentiles } from "./psd";

/**
 * Builds the site picture by running the providers and merging their fragments.
 *
 * Two rules govern everything here:
 *  1. Nothing is invented. A datum exists only because a provider returned it.
 *  2. Where the analysis needs a value nobody supplied, an explicit `Assumption`
 *     is recorded rather than a silent default.
 */

export interface GetSiteDataOptions {
  enableRemote?: boolean;
  timeoutMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  /** Free-text the user typed alongside the location. */
  userNotes?: string;
}

/* -------------------------------------------------------------------------- */
/* Screening assumption profiles                                               */
/* -------------------------------------------------------------------------- */

/**
 * PLACEHOLDER particle-size distributions, used only when no measured or
 * published PSD is available for the site.
 *
 * These are NOT data. They exist so that the matrix can be produced at all, and
 * every report that relies on one says so and caps its confidence at "low".
 * The single highest-value thing a user can do is supply a real PSD.
 */
export const ASSUMED_PSD_PROFILES: Record<
  ParticleCharacter,
  { d10Um: number; d50Um: number; d90Um: number; rationale: string }
> = {
  sand: {
    d10Um: 8,
    d50Um: 60,
    d90Um: 250,
    rationale:
      "Placeholder for a sand-dominated suspended load. Note that suspended load is " +
      "normally much finer than the bed material of the same river; a sandy bed does " +
      "not mean sandy suspended solids.",
  },
  mixed_mineral: {
    d10Um: 3,
    d50Um: 25,
    d90Um: 120,
    rationale: "Placeholder for a mixed mineral suspended load spanning silt into fine sand.",
  },
  silt: {
    d10Um: 2,
    d50Um: 15,
    d90Um: 60,
    rationale: "Placeholder for a silt-dominated suspended load.",
  },
  clay: {
    d10Um: 0.6,
    d50Um: 3,
    d90Um: 15,
    rationale:
      "Placeholder for a clay-dominated suspended load. Clay is additionally cohesive " +
      "and may be present as flocs whose effective density is far below the mineral " +
      "density, which reduces the centrifugal driving force further than size alone suggests.",
  },
  organic: {
    d10Um: 2,
    d50Um: 20,
    d90Um: 100,
    rationale:
      "Placeholder for an organic-dominated load. Organic particles have a density close " +
      "to water, so size alone overstates what a hydrocyclone can achieve.",
  },
  unknown: {
    d10Um: 2,
    d50Um: 20,
    d90Um: 100,
    rationale:
      "Placeholder used when the solids character is unknown. Deliberately broad; it " +
      "spans silt into fine sand and should not be read as a prediction.",
  },
};

/** Effective particle density used per character, for the assessment narrative. */
export const ASSUMED_PARTICLE_DENSITY_KG_M3: Record<ParticleCharacter, { value: number; note: string; provenance: Provenance }> = {
  sand: {
    value: 2650,
    provenance: "published",
    note: "Density of quartz, the dominant mineral in most river sands. A standard textbook constant.",
  },
  mixed_mineral: {
    value: 2650,
    provenance: "published",
    note: "Taken as quartz density; a mixed mineral assemblage will vary somewhat around this.",
  },
  silt: {
    value: 2650,
    provenance: "published",
    note: "Taken as quartz density. Discrete silt grains behave as dense mineral particles.",
  },
  clay: {
    value: 1300,
    provenance: "assumed",
    note:
      "PLACEHOLDER effective density for clay flocs rather than the ~2600 kg/m3 of the dry " +
      "mineral. Flocs entrain water, so their effective density is much lower. The value is " +
      "a screening placeholder, not a measurement.",
  },
  organic: {
    value: 1100,
    provenance: "assumed",
    note: "PLACEHOLDER effective density for waterlogged organic material. Not a measurement.",
  },
  unknown: {
    value: 2000,
    provenance: "assumed",
    note:
      "PLACEHOLDER used when the solids character is unknown; deliberately between mineral " +
      "and organic values. Not a measurement.",
  },
};

/* -------------------------------------------------------------------------- */
/* Free-text interpretation                                                    */
/* -------------------------------------------------------------------------- */

const PARTICLE_KEYWORDS: { character: ParticleCharacter; words: string[] }[] = [
  { character: "clay", words: ["clay", "cohesive", "colloid", "flocc"] },
  { character: "organic", words: ["organic", "algae", "algal", "peat", "humic", "leaf"] },
  { character: "sand", words: ["sand", "sandy", "grit", "gritty"] },
  { character: "silt", words: ["silt", "silty"] },
  { character: "mixed_mineral", words: ["mineral", "mixed", "sediment"] },
];

/**
 * Reads a particle character out of free text. Returns `undefined` rather than
 * guessing when nothing matches. Order matters: the more specific and more
 * consequential characters are tested first.
 */
export function particleCharacterFromText(text: string): ParticleCharacter | undefined {
  const t = text.toLowerCase();
  for (const { character, words } of PARTICLE_KEYWORDS) {
    if (words.some((w) => t.includes(w))) return character;
  }
  return undefined;
}

export function describeParticleCharacter(c: ParticleCharacter): string {
  switch (c) {
    case "sand":
      return "predominantly sand-sized dense mineral particles";
    case "mixed_mineral":
      return "a mixed mineral population spanning silt into fine sand";
    case "silt":
      return "predominantly silt-sized mineral particles";
    case "clay":
      return "predominantly clay-sized, cohesive material";
    case "organic":
      return "predominantly organic material of near-neutral buoyancy";
    default:
      return "solids of unknown character";
  }
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                 */
/* -------------------------------------------------------------------------- */

function mergeFragment(site: SiteData, f: SiteDataFragment): void {
  site.providerReports.push(f.report);
  if (f.resolvedName && !site.resolvedName) site.resolvedName = f.resolvedName;
  if (f.latitude !== undefined && site.latitude === undefined) site.latitude = f.latitude;
  if (f.longitude !== undefined && site.longitude === undefined) site.longitude = f.longitude;
  if (f.country && !site.country) site.country = f.country;
  if (f.waterBody && !site.waterBody) site.waterBody = f.waterBody;
  if (f.waterBodyType && site.waterBodyType === "unknown") site.waterBodyType = f.waterBodyType;
  if (f.catchment && !site.catchment) site.catchment = f.catchment;
  if (f.geologyNotes) site.geologyNotes.push(...f.geologyNotes);
  if (f.landUseNotes) site.landUseNotes.push(...f.landUseNotes);
  if (f.data) site.data.push(...f.data);
  if (f.psd && !site.psd) site.psd = f.psd;
  if (f.unknowns) site.unknowns.push(...f.unknowns);
  if (f.assumptions) site.assumptions.push(...f.assumptions);
  if (f.particleCharacter && site.particleCharacter === "unknown") {
    site.particleCharacter = f.particleCharacter;
    site.particleCharacterProvenance = f.particleCharacterProvenance ?? "inferred";
  }
}

async function runProvider(
  provider: SiteDataProvider,
  location: string,
  ctx: SiteLookupContext,
): Promise<SiteDataFragment> {
  try {
    return await provider.getSiteData(location, ctx);
  } catch (err) {
    return {
      report: {
        providerId: provider.id,
        providerName: provider.name,
        status: "error",
        message: `Provider threw: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

export async function getSiteData(
  location: string,
  options: GetSiteDataOptions = {},
): Promise<SiteData> {
  const timeoutMs = options.timeoutMs ?? 6000;
  const userAgent = options.userAgent ?? "traces-site-suitability";
  const enableRemote = options.enableRemote ?? true;

  const site: SiteData = {
    query: location,
    waterBodyType: "unknown",
    geologyNotes: [],
    landUseNotes: [],
    particleCharacter: "unknown",
    particleCharacterProvenance: "assumed",
    data: [],
    providerReports: [],
    unknowns: [],
    assumptions: [],
  };

  let ctx: SiteLookupContext = { timeoutMs, userAgent, fetchImpl: options.fetchImpl };

  // 1. Offline providers first - they may already know the site.
  for (const p of offlineProviders) {
    mergeFragment(site, await runProvider(p, location, ctx));
  }

  // 2. Geocode, then run the coordinate-dependent providers.
  if (enableRemote) {
    const geo = await runProvider(geocodeProvider, location, ctx);
    mergeFragment(site, geo);
    ctx = {
      ...ctx,
      latitude: site.latitude,
      longitude: site.longitude,
      resolvedName: site.resolvedName,
    };
    for (const p of remoteProviders) {
      mergeFragment(site, await runProvider(p, location, ctx));
    }
  } else {
    site.providerReports.push({
      providerId: "remote",
      providerName: "Remote open-data providers",
      status: "skipped",
      message:
        "Remote lookups are disabled (ENABLE_REMOTE_SITE_DATA=false). The assessment " +
        "used only curated knowledge and declared assumptions.",
    });
    site.unknowns.push("No live open-data lookup was performed for this site.");
  }

  // 3. Interpret the user's own free text. This is the user's own statement, so
  //    it outranks anything the engine would otherwise infer.
  if (options.userNotes?.trim()) {
    const stated = particleCharacterFromText(options.userNotes);
    if (stated) {
      site.particleCharacter = stated;
      site.particleCharacterProvenance = "inferred";
      site.data.push({
        parameter: "Solids character (as described by the user)",
        value: describeParticleCharacter(stated),
        provenance: "inferred",
        confidence: "medium",
        source: "Interpreted from the free text supplied with the site query.",
        notes:
          "This is the user's description, not a measurement. It sets the scenario " +
          "assumption used for the particle population.",
      });
    }
    // A PSD typed into the notes box is real information; use it rather than a
    // placeholder. It is not verified, so confidence stays capped at medium.
    const statedPsd = parsePSDFromText(
      options.userNotes,
      "User-supplied PSD, entered with the site query",
    );
    if (statedPsd) {
      site.psd = statedPsd;
      site.data.push({
        parameter: "Particle-size distribution (as supplied by the user)",
        value:
          `D10 ${statedPsd.d10Um ?? "?"}, D50 ${statedPsd.d50Um}, D90 ${statedPsd.d90Um ?? "?"}`,
        unit: "µm",
        provenance: "measured",
        confidence: "medium",
        source: "Supplied by the user with the site query; not independently verified.",
        notes:
          "The measurement method, sampling point and date are unknown, so this is treated " +
          "as an unverified measurement rather than a site record.",
      });
    }

    site.data.push({
      parameter: "User-supplied site notes",
      value: options.userNotes.trim().slice(0, 500),
      provenance: "inferred",
      confidence: "low",
      source: "Entered by the user.",
    });
  }

  finaliseSite(site);
  return site;
}

/** Adds the derived characterisation, assumptions and unknowns. */
export function finaliseSite(site: SiteData): SiteData {
  // Water body type: fall back to an inference only where evidence supports it.
  if (site.waterBodyType === "unknown" && site.waterBody) {
    site.waterBodyType = "river";
    site.data.push({
      parameter: "Water body type",
      value: "River",
      provenance: "inferred",
      confidence: "medium",
      source: `Inferred from the presence of a named river ("${site.waterBody}") in the retrieved records.`,
    });
  }

  // Particle character: if still unknown, record it as an explicit assumption.
  if (site.particleCharacter === "unknown") {
    site.assumptions.push({
      id: "particle-character",
      statement:
        "The character of the suspended solids is unknown, so a deliberately broad " +
        "screening placeholder spanning silt into fine sand has been used.",
      basis:
        "No measured, published or user-supplied description of the solids was available " +
        "from any provider.",
      confidence: "low",
      affects: ["Particle-size distribution", "Every cell of the configuration matrix"],
    });
  } else if (site.particleCharacterProvenance !== "measured") {
    site.assumptions.push({
      id: "particle-character",
      statement: `For screening purposes the analysis assumes ${describeParticleCharacter(site.particleCharacter)}.`,
      basis:
        site.particleCharacterProvenance === "inferred"
          ? "Inferred from the site description and retrieved records, not measured."
          : "A screening placeholder; no site measurement supports it.",
      confidence: "low",
      affects: ["Particle-size distribution", "Every cell of the configuration matrix"],
    });
  }

  if (!site.psd) {
    site.unknowns.push(
      "No site-specific particle-size distribution was found. This is the single largest " +
        "source of uncertainty in the assessment.",
    );
  }

  site.unknowns.push(
    "Feed flow rate and available feed pressure at the intended installation are unknown, " +
      "so hydraulic compatibility with any hydrocyclone cannot be confirmed.",
  );

  // Deduplicate while preserving order.
  site.unknowns = [...new Set(site.unknowns)];
  site.geologyNotes = [...new Set(site.geologyNotes)];
  return site;
}

/**
 * Returns the PSD the assessment should use, in priority order:
 *   1. a user/AI override,
 *   2. a PSD retrieved for the site,
 *   3. a clearly-labelled screening placeholder for the particle character.
 */
export function resolvePSD(
  site: SiteData,
  override: PSD | undefined,
  characterOverride: ParticleCharacter | undefined,
): { psd: PSD; isPlaceholder: boolean; character: ParticleCharacter } {
  const character = characterOverride ?? site.particleCharacter;

  if (override) return { psd: override, isPlaceholder: false, character };
  if (site.psd) return { psd: site.psd, isPlaceholder: false, character };

  const profile = ASSUMED_PSD_PROFILES[character];
  const psd = psdFromPercentiles({
    ...profile,
    label: `Screening placeholder PSD for ${describeParticleCharacter(character)}`,
    provenance: "assumed",
    confidence: "low",
    source:
      "SCREENING PLACEHOLDER - not measured, published or site-specific data. " +
      "Present only so that the configuration matrix can be produced.",
    verified: false,
    notes: [profile.rationale],
  });
  return { psd, isPlaceholder: true, character };
}

/** All auditable data, in a stable order, for the "sources" section. */
export function collectSources(site: SiteData): SiteDatum[] {
  const rank: Record<Provenance, number> = {
    measured: 0,
    published: 1,
    calculated: 2,
    inferred: 3,
    assumed: 4,
  };
  return [...site.data].sort((a, b) => rank[a.provenance] - rank[b.provenance]);
}

export type { WaterBodyType, Assumption };
