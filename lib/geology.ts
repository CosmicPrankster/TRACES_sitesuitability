/**
 * Reading BGS geology at a point.
 *
 * The BGS WMS is queried with INFO_FORMAT=text/xml. Note that
 * application/json returns an empty FeatureCollection from this service - it
 * responds 200 with no features, at every location - so XML is not a fallback
 * here, it is the only format that carries the data.
 *
 * The response is a single <FIELDS .../> element whose attributes hold
 * everything. The ones that matter:
 *
 *   RCS_D     rock composition, e.g. "Sandstone", "Clay, silt, sand and gravel"
 *             -> this is what determines particle character
 *   LEX_D     the named unit, e.g. "Folkestone Formation", "Alluvium"
 *   LEX_WEB   a citable BGS Lexicon page for that unit -> provenance
 *   TYPE_D    "sedimentary bedrock" / "superficial deposits"
 *   GP_EQ_D   parent group, e.g. "Lower Greensand Group"
 *
 * BGS corroborates and NAMES the geology; NRFA catchment properties drive the
 * particle-character inference, because a river integrates its whole catchment
 * rather than the one polygon it happens to flow over.
 */

export interface BgsUnit {
  /** Lexicon code, e.g. "FO", "ALV". */
  lex: string | null;
  /** Named unit, e.g. "Folkestone Formation". */
  name: string | null;
  /** Rock composition, e.g. "Sandstone". The field that matters most. */
  lithology: string | null;
  /** Composition code, e.g. "SDST", "XCZSV". */
  lithologyCode: string | null;
  origin: string | null;
  /** "sedimentary bedrock" / "superficial deposits". */
  type: string | null;
  group: string | null;
  /** Citable BGS Lexicon page for this unit. */
  lexiconUrl: string | null;
  /** BGS's own plain description of the depositional setting. */
  description: string | null;
}

const ATTR = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g;

const clean = (v: string | undefined): string | null => {
  if (v === undefined) return null;
  const t = v.trim();
  if (!t || t === "Not Entered" || t === "Not Applicable" || t === "No Parent") return null;
  return t;
};

/**
 * Parses one BGS WMS GetFeatureInfo XML response.
 * Returns null when the service reports no feature at the point, which is a
 * normal answer - most places have no artificial ground or landslip.
 */
export function parseBgsFeatureInfo(xml: string): BgsUnit | null {
  if (!xml || !xml.includes("<FIELDS")) return null;

  const fields = xml.slice(xml.indexOf("<FIELDS"));
  const attrs: Record<string, string> = {};
  for (const [, k, v] of fields.matchAll(ATTR)) attrs[k] = v;

  const lex = clean(attrs.LEX);
  const lithology = clean(attrs.RCS_D);
  if (!lex && !lithology) return null;

  return {
    lex,
    name: clean(attrs.LEX_D),
    lithology,
    lithologyCode: clean(attrs.RCS) ?? clean(attrs.RCS_X),
    origin: clean(attrs.RCS_ORIGIN),
    type: clean(attrs.TYPE_D),
    group: clean(attrs.GP_EQ_D),
    lexiconUrl: clean(attrs.LEX_WEB),
    description: clean(attrs.ENVIRONM_D) ?? clean(attrs.BROAD_D),
  };
}

/* -------------------------------------------------------------------- */

export interface LithologySignal {
  /** -1 (wholly fine, cohesive) to +1 (wholly coarse, granular). */
  coarseness: number;
  /** Plain-language reading of what this rock weathers to. */
  meaning: string;
}

/**
 * What a lithology weathers to, in terms that matter to a hydrocyclone.
 *
 * Order matters: the first pattern that matches wins, so the more specific and
 * more consequential rock types are tested first. A composite description like
 * "Clay, silt, sand and gravel" is deliberately treated as mixed rather than
 * matched on its first word.
 */
const LITHOLOGY_RULES: { pattern: RegExp; coarseness: number; meaning: string }[] = [
  { pattern: /\bpeat\b/i, coarseness: -0.9,
    meaning: "peat, which yields low-density organic particles that a hydrocyclone struggles with, because separation depends on density difference and peat has almost none" },
  { pattern: /clay,?\s*(and\s*)?silt,?\s*(and\s*)?sand,?\s*(and\s*)?gravel|clay, silt, sand and gravel/i, coarseness: 0.1,
    meaning: "a mixed alluvial sediment spanning clay through gravel, so both a fine and a coarse fraction are present" },
  { pattern: /\b(mudstone|claystone|siltstone|shale)\b/i, coarseness: -0.7,
    meaning: "argillaceous rock, weathering to cohesive clay- and silt-grade material" },
  { pattern: /^clay\b|\bclay and silt\b|\bboulder clay\b|\btill\b|\bdiamicton\b/i, coarseness: -0.6,
    meaning: "clay-rich material, cohesive and fine, which tends to stay in suspension" },
  { pattern: /\bsilt\b/i, coarseness: -0.3,
    meaning: "silt-grade material, fine but not cohesive" },
  { pattern: /\b(sandstone|sand and gravel|gravel|arenite|grit|conglomerate|breccia)\b/i, coarseness: 0.8,
    meaning: "arenaceous rock, weathering to sand-grade quartz grains that are dense, discrete and readily separated" },
  { pattern: /\bsand\b/i, coarseness: 0.7,
    meaning: "sand, giving dense discrete grains well suited to centrifugal separation" },
  { pattern: /\b(chalk|limestone|dolomite|dolostone)\b/i, coarseness: 0.0,
    meaning: "carbonate rock, which weathers to a fine carbonate load, often with a coarser insoluble residue" },
  { pattern: /\b(granite|basalt|dolerite|gabbro|andesite|rhyolite|tuff|igneous|volcanic)\b/i, coarseness: 0.2,
    meaning: "crystalline igneous rock, weathering to a mixed assemblage of dense mineral grains" },
  { pattern: /\b(schist|gneiss|slate|phyllite|metamorphic|quartzite)\b/i, coarseness: 0.1,
    meaning: "metamorphic rock, weathering to a mixed assemblage spanning silt into sand" },
];

export function readLithology(lithology: string | null): LithologySignal | null {
  if (!lithology) return null;
  const rule = LITHOLOGY_RULES.find((r) => r.pattern.test(lithology));
  return rule ? { coarseness: rule.coarseness, meaning: rule.meaning } : null;
}

/* -------------------------------------------------------------------- */

export interface GeologyAtPoint {
  bedrock: BgsUnit | null;
  superficial: BgsUnit | null;
}

export interface GeologySummary {
  /** One or two sentences naming what is there, with the lexicon links. */
  statement: string;
  /** -1..+1, or null when neither unit could be read. */
  coarseness: number | null;
  /** Every source used, for the audit trail. */
  sources: { label: string; url: string }[];
  reasoning: string[];
}

/**
 * Summarises the geology at a point.
 *
 * Superficial deposits are weighted above bedrock where present, because they
 * are what is physically at the surface for the river to rework. But at a river
 * site the superficial deposit is very often Alluvium - which is the river's own
 * sediment, so it is somewhat circular - and the bedrock then tells you more
 * about what the catchment is actually shedding. Both are reported, and the
 * report says which is which.
 */
export function summariseGeology(g: GeologyAtPoint): GeologySummary | null {
  const reasoning: string[] = [];
  const sources: { label: string; url: string }[] = [];
  const parts: string[] = [];

  const sup = g.superficial;
  const bed = g.bedrock;
  if (!sup && !bed) return null;

  const supSignal = readLithology(sup?.lithology ?? null);
  const bedSignal = readLithology(bed?.lithology ?? null);

  if (sup) {
    parts.push(`superficial deposits of ${sup.name ?? "an unnamed unit"} (${sup.lithology ?? "composition not stated"})`);
    if (sup.lexiconUrl) sources.push({ label: `BGS Lexicon: ${sup.name ?? sup.lex}`, url: sup.lexiconUrl });
    if (supSignal) {
      reasoning.push(
        `At the surface the map shows ${sup.name ?? "an unnamed unit"} — ${sup.lithology}. ` +
          `That is ${supSignal.meaning}.`,
      );
    }
    if (/alluvium/i.test(sup.name ?? "")) {
      reasoning.push(
        "Alluvium is the river's own deposit, so it describes what this river has already been " +
          "carrying. That is useful, but it is partly circular: the catchment bedrock is the " +
          "better guide to what is being supplied.",
      );
    }
  }

  if (bed) {
    parts.push(`${bed.name ?? "unnamed"} bedrock (${bed.lithology ?? "composition not stated"})`);
    if (bed.lexiconUrl) sources.push({ label: `BGS Lexicon: ${bed.name ?? bed.lex}`, url: bed.lexiconUrl });
    if (bedSignal) {
      reasoning.push(
        `The bedrock is ${bed.name ?? "unnamed"}${bed.group ? ` of the ${bed.group}` : ""} — ` +
          `${bed.lithology}. That is ${bedSignal.meaning}.`,
      );
    }
  }

  // Superficial leads where it is not simply the river's own alluvium.
  const supIsAlluvium = /alluvium/i.test(sup?.name ?? "");
  let coarseness: number | null = null;
  if (supSignal && bedSignal) {
    coarseness = supIsAlluvium
      ? 0.35 * supSignal.coarseness + 0.65 * bedSignal.coarseness
      : 0.65 * supSignal.coarseness + 0.35 * bedSignal.coarseness;
  } else {
    coarseness = supSignal?.coarseness ?? bedSignal?.coarseness ?? null;
  }

  return {
    statement: `At this point BGS maps ${parts.join(", over ")}.`,
    coarseness,
    sources,
    reasoning,
  };
}
