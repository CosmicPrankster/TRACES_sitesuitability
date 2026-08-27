import type {
  ParticleCharacter,
  SiteDatum,
  SiteDataFragment,
  SiteDataProvider,
  SiteLookupContext,
} from "@/types";
import { fetchJson } from "./http";

/**
 * British Geological Survey bedrock and superficial deposits.
 *
 * Catchment geology is the strongest available predictor of what a river's
 * mineral suspended load is made of, which is why this matters: it is the one
 * lookup that can determine the solids character for a river without anyone
 * having to go and look at the water.
 *
 * IMPLEMENTATION NOTE - please read before trusting this
 * ------------------------------------------------------
 * This queries a BGS ArcGIS MapServer using the standard Esri `identify`
 * operation. The operation itself is a stable, well-documented Esri API; what
 * is NOT verified is the exact service URL and the attribute names BGS uses in
 * its response, because the development environment had no outbound access to
 * map.bgs.ac.uk.
 *
 * The parser is therefore written defensively: it looks for lithology and
 * formation information under any of several plausible attribute names, and if
 * it finds nothing it recognises, it returns `no_data` with the raw attribute
 * keys it DID see, plus a link to check manually. It will never emit a geology
 * datum it did not actually read from the response.
 *
 * If this returns `no_data` on your first run, open the report's "Data lookups
 * performed" panel: the message lists the attribute keys the service actually
 * returned, and adding them to ATTRIBUTE_KEYS below is a two-minute fix.
 *
 * Override the endpoint with BGS_MAPSERVER_URL if BGS moves the service.
 */

const DEFAULT_MAPSERVER =
  "https://map.bgs.ac.uk/arcgis/rest/services/BGS_Detailed_Geology/MapServer";

/** Attribute names to look under, in order of preference. Case-insensitive. */
const ATTRIBUTE_KEYS = {
  lithology: ["RCS_D", "RCS_ORIGIN", "LITHOLOGY", "LEX_RCS_D", "RCS_X", "DESCRIPTION"],
  formation: ["LEX_D", "LEX", "BGSREF", "NAME", "FORMATION", "MAPCODE"],
};

interface IdentifyResult {
  layerId?: number;
  layerName?: string;
  value?: string;
  attributes?: Record<string, unknown>;
}

/**
 * Lithology keyword to particle character.
 *
 * The reasoning is straightforward and standard: a catchment weathering sand
 * and gravel yields a sandy mineral load; one weathering mudstone and clay
 * yields a clay load. It is an INFERENCE from the geology to the suspended
 * sediment, and it is labelled as one - a catchment's sediment also depends on
 * land use, channel character and how far the material has travelled.
 *
 * Order matters: the first match wins, so the more specific terms come first.
 */
const LITHOLOGY_RULES: { pattern: RegExp; character: ParticleCharacter; why: string }[] = [
  {
    pattern: /\b(peat|lignite|organic)\b/i,
    character: "organic",
    why: "peat and organic deposits weather to low-density organic particles",
  },
  {
    pattern: /\b(clay|mudstone|claystone|till|boulder clay|diamicton)\b/i,
    character: "clay",
    why: "argillaceous rocks and tills weather to cohesive clay-sized material",
  },
  {
    pattern: /\b(silt|siltstone|loess|alluvium|brickearth)\b/i,
    character: "silt",
    why: "silt-grade deposits weather to silt-sized mineral particles",
  },
  {
    pattern: /\b(sand|sandstone|gravel|arenite|greensand|grit|conglomerate)\b/i,
    character: "sand",
    why: "arenaceous rocks and sand or gravel deposits weather to sand-sized quartz grains",
  },
  {
    pattern: /\b(chalk|limestone|dolomite|carbonate|marl)\b/i,
    character: "mixed_mineral",
    why: "carbonate rocks weather to a fine carbonate load, often with a coarser insoluble residue",
  },
  {
    pattern: /\b(granite|basalt|schist|gneiss|slate|igneous|metamorphic|volcanic)\b/i,
    character: "mixed_mineral",
    why: "crystalline rocks weather to a mixed mineral assemblage spanning silt into fine sand",
  },
];

function pick(attrs: Record<string, unknown>, keys: string[]): string | undefined {
  const lower = new Map(Object.keys(attrs).map((k) => [k.toLowerCase(), k]));
  for (const key of keys) {
    const actual = lower.get(key.toLowerCase());
    if (!actual) continue;
    const v = attrs[actual];
    if (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null") return v.trim();
  }
  return undefined;
}

/** True when the layer name suggests superficial rather than bedrock geology. */
function isSuperficial(name: string | undefined): boolean {
  return /superficial|quaternary|drift|artificial/i.test(name ?? "");
}

export const bgsGeologyProvider: SiteDataProvider = {
  id: "bgs-geology",
  name: "British Geological Survey - bedrock and superficial deposits",

  async getSiteData(_location: string, ctx: SiteLookupContext): Promise<SiteDataFragment> {
    const started = Date.now();
    const manualUrl = "https://mapapps2.bgs.ac.uk/geoindex/home.html";

    if (ctx.latitude === undefined || ctx.longitude === undefined) {
      return {
        report: {
          providerId: "bgs-geology",
          providerName: bgsGeologyProvider.name,
          status: "skipped",
          message: "Skipped: no coordinates were available for a geology lookup.",
          sourceUrl: manualUrl,
          durationMs: Date.now() - started,
        },
      };
    }

    const base = process.env.BGS_MAPSERVER_URL?.trim() || DEFAULT_MAPSERVER;
    const { latitude: lat, longitude: lon } = ctx;
    // Esri `identify` needs a map extent and an image size to scale its
    // tolerance against. A small window centred on the point is what we want.
    const d = 0.002;
    const url =
      `${base}/identify?f=json&geometryType=esriGeometryPoint` +
      `&geometry=${encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }))}` +
      `&sr=4326&layers=all&tolerance=3&returnGeometry=false` +
      `&mapExtent=${lon - d},${lat - d},${lon + d},${lat + d}&imageDisplay=400,400,96`;

    const res = await fetchJson<{ results?: IdentifyResult[]; error?: unknown }>(url, {
      timeoutMs: ctx.timeoutMs,
      userAgent: ctx.userAgent,
      fetchImpl: ctx.fetchImpl,
    });
    const durationMs = Date.now() - started;

    if (!res.ok) {
      return {
        report: {
          providerId: "bgs-geology",
          providerName: bgsGeologyProvider.name,
          status: "error",
          message:
            `Geology lookup failed: ${res.error}. Catchment geology is unknown; check it ` +
            "manually in BGS GeoIndex. If this keeps failing, the service URL may have moved - " +
            "set BGS_MAPSERVER_URL.",
          sourceUrl: manualUrl,
          durationMs,
        },
        unknowns: ["Catchment geology could not be retrieved, so the mineral character of the load is unknown."],
      };
    }

    const results = res.data?.results ?? [];
    if (results.length === 0) {
      return {
        report: {
          providerId: "bgs-geology",
          providerName: bgsGeologyProvider.name,
          status: "no_data",
          message:
            "The geology service returned no features at this point. This is expected outside " +
            "Great Britain, and can also happen offshore or on made ground.",
          sourceUrl: manualUrl,
          durationMs,
        },
        unknowns: ["No geology was returned for this location."],
      };
    }

    /* --- Parse, preferring superficial deposits ------------------------ */
    // Superficial deposits matter more than bedrock here: a river's sediment
    // comes overwhelmingly from what is at surface in the catchment, not from
    // the rock beneath it.
    const parsed = results
      .map((r) => ({
        layer: r.layerName ?? `layer ${r.layerId ?? "?"}`,
        superficial: isSuperficial(r.layerName),
        lithology: pick(r.attributes ?? {}, ATTRIBUTE_KEYS.lithology),
        formation: pick(r.attributes ?? {}, ATTRIBUTE_KEYS.formation) ?? r.value,
        keys: Object.keys(r.attributes ?? {}),
      }))
      .filter((p) => p.lithology || p.formation);

    if (parsed.length === 0) {
      const seen = [...new Set(results.flatMap((r) => Object.keys(r.attributes ?? {})))];
      return {
        report: {
          providerId: "bgs-geology",
          providerName: bgsGeologyProvider.name,
          status: "no_data",
          message:
            `The service returned ${results.length} feature(s), but none of their attributes were ` +
            "recognised, so no geology was recorded rather than guessing. Attribute keys seen: " +
            `${seen.slice(0, 20).join(", ") || "none"}. Add the relevant ones to ATTRIBUTE_KEYS in ` +
            "lib/providers/bgs-geology.ts to make this work.",
          sourceUrl: manualUrl,
          durationMs,
        },
        unknowns: ["Geology was returned but could not be interpreted, so it was not used."],
      };
    }

    parsed.sort((a, b) => Number(b.superficial) - Number(a.superficial));
    const primary = parsed[0];
    const descriptor = `${primary.formation ?? ""} ${primary.lithology ?? ""}`.trim();

    const data: SiteDatum[] = parsed.slice(0, 3).map((p) => ({
      parameter: p.superficial ? "Superficial deposits" : "Bedrock geology",
      value: [p.formation, p.lithology].filter(Boolean).join(" - "),
      provenance: "published",
      confidence: "high",
      source: `British Geological Survey, ${p.layer}`,
      sourceUrl: url,
      date: new Date().toISOString().slice(0, 10),
      notes: p.superficial
        ? "Superficial deposits are what is at surface in the catchment, and are the dominant " +
          "control on a river's suspended sediment."
        : "Bedrock beneath the site. Relevant where superficial cover is thin or absent.",
    }));

    const rule = LITHOLOGY_RULES.find((r) => r.pattern.test(descriptor));

    const geologyNotes = [
      `BGS records ${primary.superficial ? "superficial deposits" : "bedrock"} at this point as ` +
        `${descriptor || "an unnamed unit"}.` +
        (parsed.length > 1
          ? ` ${parsed.length - 1} further unit(s) were returned and are listed in the sources.`
          : ""),
    ];

    if (!rule) {
      geologyNotes.push(
        `No lithology keyword in "${descriptor}" matched a known weathering behaviour, so the ` +
          "geology was recorded but not used to characterise the solids.",
      );
      return {
        report: {
          providerId: "bgs-geology",
          providerName: bgsGeologyProvider.name,
          status: "ok",
          message: `Retrieved geology (${descriptor}), but its lithology was not recognised.`,
          sourceUrl: url,
          durationMs,
        },
        geologyNotes,
        data,
      };
    }

    const basis =
      `BGS records the ${primary.superficial ? "superficial deposits" : "bedrock"} here as ` +
      `${descriptor}. Because ${rule.why}, the mineral fraction of the suspended load is taken to ` +
      `be predominantly ${rule.character.replace(/_/g, " ")}. This is an INFERENCE from catchment ` +
      "geology to suspended sediment, not a measurement of the water: the load also depends on " +
      "land use, channel character and how far the material has travelled, and a river's " +
      "suspended load is normally finer than the material its catchment is made of.";

    return {
      report: {
        providerId: "bgs-geology",
        providerName: bgsGeologyProvider.name,
        status: "ok",
        message: `Retrieved geology: ${descriptor}. Solids character inferred as ${rule.character}.`,
        sourceUrl: url,
        durationMs,
      },
      geologyNotes,
      particleCharacter: rule.character,
      particleCharacterProvenance: "inferred",
      particleCharacterBasis: basis,
      data,
    };
  },
};
