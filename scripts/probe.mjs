#!/usr/bin/env node
/**
 * DATA SOURCE PROBE  (v3 - narrowed)
 * ==================================
 *
 * v2 answered the question. This version stops asking it.
 *
 * DROPPED, having comprehensively failed on both test sites:
 *   EA Water Quality Archive     5 URL forms, all 404/403. API has moved or gone.
 *   EA Catchment Data Explorer   5 URL forms, all 404. Same.
 *   BGS REST identify            6 variants, all empty. WMS works instead.
 *   SEPA river levels            DNS failure (ENOTFOUND).
 *   Open-Meteo geocoding         0 items on every query - it is a settlement
 *                                gazetteer and does not hold river names.
 *
 * KEPT, because they returned real data on both sites:
 *   Nominatim geocoding
 *   BGS geology via WMS GetFeatureInfo   <- the foundation
 *   NRFA catchment properties            <- UK-wide, works in Scotland
 *   EA real-time level/rainfall          <- England only, context
 *
 * This run exists to extract the exact CONTENT of those responses, so the
 * providers can be written against real field names rather than guesses.
 *
 *   node scripts/probe.mjs "Kinness Burn, St Andrews"
 */

import { writeFile, mkdir } from "node:fs/promises";
import { wgs84ToBng } from "./lib/bng.mjs";

const TIMEOUT_MS = 30000;
const UA = process.env.SITE_DATA_USER_AGENT ||
  "traces-site-suitability-probe/0.4 (research prototype; set SITE_DATA_USER_AGENT)";

const query = process.argv.slice(2).join(" ").trim();
if (!query) { console.error('Usage: node scripts/probe.mjs "Kinness Burn, St Andrews"'); process.exit(1); }

const c = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
            green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m" };
const raw = [];

async function get(name, url, accept = "application/json") {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: accept, "User-Agent": UA } });
    const text = await res.text();
    const ms = Date.now() - started;
    let body = text;
    if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
      try { body = JSON.parse(text); } catch { /* keep text */ }
    }
    raw.push({ name, url, httpStatus: res.status, ms, bytes: text.length, body });
    console.log(`  ${res.ok ? c.green + "ok  " : c.red + "FAIL"}${c.reset} ${name} ${c.dim}${res.status}, ${ms} ms, ${text.length} b${c.reset}`);
    return res.ok ? body : null;
  } catch (err) {
    raw.push({ name, url, error: err.message });
    console.log(`  ${c.red}FAIL${c.reset} ${name} ${c.dim}${err.message}${c.reset}`);
    return null;
  } finally { clearTimeout(timer); }
}

console.log(`\n${c.bold}Probing (v3, narrowed) for:${c.reset} ${query}\n`);

/* ---- 1. Resolve to ONE stretch of water ---------------------------- */
// "Tilford, River Wey" means the Wey WHERE IT RUNS THROUGH TILFORD. Geocoding
// the whole phrase matches nothing; geocoding "River Wey" alone lands anywhere
// along 70 km of river. So: split the query, geocode the SETTLEMENT, and use
// that as the anchor. The full scoring logic lives in lib/resolve.ts, which is
// unit-tested; this is just enough to prove the data path.
console.log(`${c.cyan}1. Resolving to one stretch of water${c.reset}`);

const WATER_WORDS = ["river", "burn", "beck", "brook", "stream", "water", "creek",
  "canal", "loch", "lake", "reservoir", "afon", "nant", "mere", "tarn"];
const parts = query.split(",").map((p) => p.trim()).filter(Boolean);
const isWater = (p) => WATER_WORDS.some((w) => p.toLowerCase().split(/[\s-]+/).includes(w));
const waterbodyPart = parts.find(isWater) ?? null;
const settlementPart = parts.find((p) => !isWater(p)) ?? null;

console.log(`  ${c.dim}waterbody:  ${waterbodyPart ?? "(none detected)"}${c.reset}`);
console.log(`  ${c.dim}settlement: ${settlementPart ?? "(none detected)"}${c.reset}`);

// Anchor on the settlement: a town is a point, a river is a line.
// Two hard-won constraints:
//  - countrycodes=gb. Without it "Bedford" resolved to Bedford County,
//    Pennsylvania, and every lookup downstream was for the wrong continent.
//  - prefer a POPULATED PLACE. Where the query carries no water word
//    ("Bedford, Great Ouse") either part might be the settlement, so both are
//    tried and whichever resolves to a town or village wins.
const SETTLEMENT_TYPES = ["city", "town", "village", "hamlet", "suburb", "administrative", "locality"];
const anchorQueries = [settlementPart, waterbodyPart, query].filter(Boolean);
let lat = null, lon = null, resolvedName = null, matchedVariant = null, allMatches = [];

for (const v of anchorQueries) {
  const body = await get(`geocode "${v}" (GB only)`,
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1` +
    `&countrycodes=gb&q=${encodeURIComponent(v)}`);
  if (Array.isArray(body) && body.length) {
    const settlement = body.find((r) => SETTLEMENT_TYPES.includes(r.type)) ?? body[0];
    allMatches = body.map((r) => ({ name: r.display_name, type: r.type, class: r.class, lat: +r.lat, lon: +r.lon }));
    lat = +settlement.lat; lon = +settlement.lon;
    resolvedName = settlement.display_name; matchedVariant = v;
    break;
  }
}
if (lat === null) { console.log(`\n${c.red}Geocoding failed entirely.${c.reset}\n`); process.exit(1); }

const bng = wgs84ToBng(lat, lon);
console.log(`  ${c.green}→ anchored on "${matchedVariant}": ${resolvedName}${c.reset}`);
console.log(`  ${c.dim}→ BNG E${bng.easting} N${bng.northing}${c.reset}`);
if (allMatches.length > 1) {
  console.log(`  ${c.yellow}→ ${allMatches.length} candidates; the user must confirm which:${c.reset}`);
  allMatches.forEach((m, i) => console.log(`     ${c.dim}${i + 1}. ${m.name} [${m.class}/${m.type}]${c.reset}`));
}
console.log();

/* ---- 2. BGS geology via WMS - THE FOUNDATION ----------------------- */
// JSON returned a constant 441 bytes at both test sites: an empty
// FeatureCollection. text/xml returned 1595 b at Tilford and 1821 b at St
// Andrews - different content per location - so the query IS hitting real data
// and only the JSON writer is empty. This run finds which format carries it and
// prints the body verbatim.
console.log(`${c.cyan}2. BGS geology via WMS  ${c.dim}(JSON came back empty - trying other formats)${c.reset}`);

const WMS = "https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer";
const half = 500;
const bbox = `${bng.easting - half},${bng.northing - half},${bng.easting + half},${bng.northing + half}`;
const wmsUrl = (layer, fmt) =>
  `${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo&LAYERS=${layer}&QUERY_LAYERS=${layer}` +
  `&CRS=EPSG:27700&BBOX=${bbox}&WIDTH=101&HEIGHT=101&I=50&J=50&FORMAT=image/png` +
  `&INFO_FORMAT=${encodeURIComponent(fmt)}&FEATURE_COUNT=10`;

const FORMATS = [
  "text/xml",
  "text/html",
  "application/vnd.ogc.gml",
  "application/vnd.esri.wms_featureinfo_xml",
  "text/plain",
];

console.log(`  ${c.dim}Finding a format that carries the data (bedrock layer):${c.reset}`);
let bestFormat = null;
for (const fmt of FORMATS) {
  const body = await get(`bedrock as ${fmt}`, wmsUrl("BGS.50k.Bedrock", fmt), fmt);
  if (typeof body === "string" && body.length > 500) {
    if (!bestFormat) bestFormat = fmt;
    console.log(`\n${c.green}${c.bold}----- RAW BODY (${fmt}, ${body.length} b) -----${c.reset}`);
    console.log(body.slice(0, 2500));
    console.log(`${c.green}${c.bold}----- END -----${c.reset}\n`);
    break; // one full body is enough to write a parser against
  }
}

// Now every layer in whichever format carried the data.
const geology = {};
if (bestFormat) {
  console.log(`  ${c.dim}All layers as ${bestFormat}:${c.reset}`);
  for (const [layer, label] of [
    ["BGS.50k.Bedrock", "bedrock"],
    ["BGS.50k.Superficial.deposits", "superficial"],
    ["BGS.50k.Artificial.ground", "artificial"],
    ["BGS.50k.Mass.movement", "mass movement"],
  ]) {
    const body = await get(`${label}`, wmsUrl(layer, bestFormat), bestFormat);
    if (typeof body === "string" && body.includes("<FIELDS")) {
      geology[label] = body;
      // The fields that actually matter, matching lib/geology.ts.
      const attr = (k) => (body.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1];
      const show = [
        ["unit", attr("LEX_D")], ["lithology", attr("RCS_D")], ["code", attr("RCS")],
        ["group", attr("GP_EQ_D")], ["type", attr("TYPE_D")], ["lexicon", attr("LEX_WEB")],
      ].filter(([, v]) => v && !["Not Applicable", "No Parent", "Not Entered", " "].includes(v));
      show.forEach(([k, v]) => console.log(`       ${c.green}${String(k).padEnd(10)} ${v}${c.reset}`));
    } else if (typeof body === "string") {
      console.log(`       ${c.dim}no feature here (normal for artificial ground / landslip)${c.reset}`);
    }
  }
}
console.log();

/* ---- 3. What else is in GeoIndex_Onshore? -------------------------- */
console.log(`${c.cyan}3. BGS GeoIndex_Onshore services  ${c.dim}(21 found - what are they?)${c.reset}`);
const gi = await get("folder listing", "https://map.bgs.ac.uk/arcgis/rest/services/GeoIndex_Onshore?f=json");
if (gi?.services) gi.services.forEach((s) => console.log(`     ${c.dim}${s.name} (${s.type})${c.reset}`));
console.log();

/* ---- 4. NRFA catchment properties ---------------------------------- */
// NRFA names stations "<River> at <Place>" - exactly the shape of the query -
// so a name match is a strong, authoritative resolution for any gauged river.
console.log(`${c.cyan}4. NRFA catchment properties  ${c.dim}(UK-wide)${c.reset}`);
const list = await get("all stations",
  "https://nrfaapps.ceh.ac.uk/nrfa/ws/station-info?format=json-object&station=*&fields=id,name,river,easting,northing,catchment-area");
let nearest = null;
if (list?.data) {
  const qTokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !WATER_WORDS.includes(t));
  const withDist = list.data
    .filter((s) => typeof s.easting === "number")
    .map((s) => {
      const nameTokens = String(s.name ?? "").toLowerCase().split(/[^a-z0-9]+/);
      const hits = qTokens.filter((t) => nameTokens.includes(t));
      return { ...s, km: Math.hypot(s.easting - bng.easting, s.northing - bng.northing) / 1000, hits };
    });

  // A name that matches 7,000 km away is not a match. This is what let
  // "Bedford Ouse at Thornborough Mill" pass while anchored in Pennsylvania.
  const MAX_MATCH_KM = 40;
  const named = withDist
    .filter((s) => s.hits.length >= 2 && s.km <= MAX_MATCH_KM)
    .sort((a, b) => a.km - b.km);
  const rejected = withDist.filter((s) => s.hits.length >= 2 && s.km > MAX_MATCH_KM);
  if (rejected.length) {
    console.log(`  ${c.yellow}→ ${rejected.length} name match(es) REJECTED as too far from the anchor ` +
      `(nearest ${rejected.sort((a, b) => a.km - b.km)[0].km.toFixed(0)} km) — the anchor is probably wrong${c.reset}`);
  }

  // A river-only match still beats nearest-by-distance: at Romsey the nearest
  // gauge is Tadburn Lake, a 19 km2 tributary, not the Test.
  const riverTokens = (waterbodyPart ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !WATER_WORDS.includes(t));
  const onRiver = riverTokens.length
    ? withDist.filter((s) => s.km <= MAX_MATCH_KM &&
        riverTokens.every((t) => String(s.river ?? "").toLowerCase().split(/[^a-z0-9]+/).includes(t)))
        .sort((a, b) => a.km - b.km)
    : [];
  if (!named.length && onRiver.length) {
    console.log(`  ${c.green}${c.bold}→ RIVER MATCH (right river, nearest reach):${c.reset}`);
    onRiver.slice(0, 3).forEach((s) =>
      console.log(`     ${c.green}${s.id} ${s.name} - ${s.km.toFixed(1)} km, ${s["catchment-area"]} km²${c.reset}`));
  }
  if (named.length) {
    console.log(`  ${c.green}${c.bold}→ NAME MATCH (both river and place):${c.reset}`);
    named.slice(0, 3).forEach((s) =>
      console.log(`     ${c.green}${s.id} ${s.name} - ${s.km.toFixed(1)} km from anchor, ${s["catchment-area"]} km²${c.reset}`));
    nearest = named[0];
  }

  const byDist = withDist.sort((a, b) => a.km - b.km);
  console.log(`  ${c.dim}→ nearest by distance:${c.reset}`);
  byDist.slice(0, 5).forEach((s) =>
    console.log(`     ${c.dim}${s.id} ${s.name} (${s.river}) - ${s.km.toFixed(1)} km, ${s["catchment-area"]} km²${c.reset}`));
  nearest = nearest ?? onRiver[0] ?? byDist[0];
}
if (nearest) {
  const full = await get(`full record for ${nearest.id} (${nearest.name})`,
    `https://nrfaapps.ceh.ac.uk/nrfa/ws/station-info?format=json-object&station=${nearest.id}&fields=all`);
  const rec = full?.data?.[0];
  if (rec) {
    console.log(`  ${c.green}${c.bold}ALL NRFA FIELDS (${Object.keys(rec).length}):${c.reset}`);
    console.log(`     ${c.dim}${Object.keys(rec).join(", ")}${c.reset}`);
    // Only the fields that bear on sediment character. The 100+ yearly land
    // cover columns are noise; the most recent year is enough.
    const WANTED = [
      "catchment-area", "saar-1991-2020", "bfihost19", "bfihost", "propwet",
      "high-perm-bedrock", "moderate-perm-bedrock", "low-perm-bedrock", "mixed-perm-bedrock",
      "high-perm-superficial", "low-perm-superficial", "mixed-perm-superficial",
      "sprhost", "dpsbar", "draindens", "urbext-2015",
      "lcm2023-cropland", "lcm2023-grassland", "lcm2023-built-up-areas",
      "lcm2023-deciduous-woodland", "lcm2023-evergreen-woodland", "lcm2023-bare-soil-rock",
    ];
    console.log(`  ${c.green}${c.bold}Fields bearing on sediment character:${c.reset}`);
    for (const k of WANTED) {
      if (k in rec) console.log(`       ${c.green}${k.padEnd(26)} ${rec[k]}${c.reset}`);
    }
    if (rec["description-catchment"]) {
      console.log(`  ${c.green}${c.bold}NRFA catchment description:${c.reset}`);
      console.log(`       ${c.dim}${String(rec["description-catchment"]).slice(0, 600)}${c.reset}`);
    }
  }
}
console.log();

/* ---- 5. EA real-time (England only) -------------------------------- */
console.log(`${c.cyan}5. EA real-time  ${c.dim}(England only - expected empty in Scotland)${c.reset}`);
const stations = await get("river stations within 15 km",
  `https://environment.data.gov.uk/flood-monitoring/id/stations?lat=${lat}&long=${lon}&dist=15&_limit=5`);
if (stations?.items?.length) {
  const s = stations.items[0];
  console.log(`     ${c.dim}nearest: ${s.label} on ${s.riverName ?? "?"}, catchment ${s.catchmentName ?? "?"}${c.reset}`);
  console.log(`     ${c.dim}station fields: ${Object.keys(s).join(", ")}${c.reset}`);
} else {
  console.log(`     ${c.yellow}none - outside England${c.reset}`);
}
console.log();

/* ---- report -------------------------------------------------------- */
const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
await mkdir("probe-results", { recursive: true });
const out = `probe-results/${slug}-v3.json`;
await writeFile(out, JSON.stringify({
  query, probedAt: new Date().toISOString(),
  resolved: { name: resolvedName, lat, lon, bng, matchedVariant, allMatches, waterbodyPart, settlementPart },
  geology, raw,
}, null, 2));

console.log(`${c.bold}GEOLOGY EXTRACTED${c.reset}`);
if (Object.keys(geology).length) {
  for (const [layer, props] of Object.entries(geology)) {
    const desc = props.LEX_D || props.RCS_D || props.LEX_RCS_D || props.RCS_X || JSON.stringify(props).slice(0, 80);
    console.log(`  ${c.green}✓${c.reset} ${layer.padEnd(14)} ${desc}`);
  }
  console.log(`\n  ${c.green}This is enough to build the geology provider on.${c.reset}`);
} else {
  console.log(`  ${c.red}Nothing extracted. Check the raw bodies in the report.${c.reset}`);
}
console.log(`\n  Full report: ${c.bold}${out}${c.reset}\n`);
