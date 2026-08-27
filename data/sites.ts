import type { ParticleCharacter, Provenance, SiteDatum, WaterBodyType } from "@/types";

/**
 * CURATED SITE KNOWLEDGE
 * ======================
 *
 * A small, hand-maintained store of things a researcher already knows about
 * specific sites. It is consulted alongside the live open-data providers.
 *
 * RULES
 *  - Record only what you can point at a source for, or clearly label as an
 *    inference. Every datum carries its own provenance.
 *  - Prefer descriptive facts over numbers. If you have a number, cite it.
 *  - `matches` are lower-cased substrings tested against the user's query.
 */

export interface CuratedSite {
  id: string;
  name: string;
  /** Lower-case substrings that identify this site in a free-text query. */
  matches: string[];
  waterBody?: string;
  waterBodyType?: WaterBodyType;
  catchment?: string;
  particleCharacter?: ParticleCharacter;
  particleCharacterProvenance?: Provenance;
  /** Why that character - shown to the user as the audit trail. */
  particleCharacterBasis?: string;
  geologyNotes?: string[];
  landUseNotes?: string[];
  data: SiteDatum[];
  unknowns?: string[];
}

export const curatedSites: CuratedSite[] = [
  {
    id: "tilford-river-wey",
    name: "Tilford, River Wey (Surrey, England)",
    matches: ["tilford"],
    waterBody: "River Wey",
    waterBodyType: "river",
    geologyNotes: [
      "The Tilford reach lies in the Lower Greensand outcrop of west Surrey, an area " +
        "characterised by sandy formations. This is recorded here as an INFERENCE from " +
        "general regional geology and must be confirmed against BGS GeoIndex for the " +
        "specific abstraction point before it is relied on.",
    ],
    particleCharacter: "sand",
    particleCharacterProvenance: "inferred",
    particleCharacterBasis:
      "The Tilford reach sits in the Lower Greensand outcrop of west Surrey, a sandy " +
      "formation, and the Wey here is a sand-bed river. A sand-dominated mineral fraction is " +
      "therefore the most likely character of its mineral load. This is an INFERENCE from " +
      "regional geology, not a measurement or a site-specific citation, and it must be " +
      "confirmed against BGS GeoIndex for the actual abstraction point. Note also that the " +
      "suspended load of a sand-bed river is normally much finer than its bed material.",
    data: [
      {
        parameter: "Water body",
        value: "River Wey",
        provenance: "published",
        confidence: "high",
        source: "Tilford is a village on the River Wey in Surrey, England; the river's two " +
          "branches meet at Tilford.",
        notes: "Widely documented geography. Confirm the exact reach and bank at the intended access point.",
      },
      {
        parameter: "Water body type",
        value: "Lowland river",
        provenance: "inferred",
        confidence: "medium",
        source: "Inferred from location and river character; not taken from a cited classification.",
      },
    ],
    unknowns: [
      "No site-specific particle-size distribution is held for this site.",
      "No site-specific settled-solids or turbidity measurement taken at the intended " +
        "abstraction point is held.",
      "Whether abstraction would be near-surface or near-bed is unknown, and it strongly " +
        "affects the size distribution presented to the plant.",
    ],
  },
];

export function findCuratedSite(query: string): CuratedSite | undefined {
  const q = query.toLowerCase();
  return curatedSites.find((s) => s.matches.some((m) => q.includes(m)));
}
