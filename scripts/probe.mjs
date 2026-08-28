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

/* ---- 1. Geocoding: Nominatim only ---------------------------------- */
console.log(`${c.cyan}1. Geocoding (Nominatim)${c.reset}`);
const variants = [...new Set([query, ...query.split(",").map((p) => p.trim()).filter(Boolean).reverse()])];
let lat = null, lon = null, resolvedName = null, matchedVariant = null, allMatches = [];

for (const v of variants) {
  const body = await get(`search "${v}"`,
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&q=${encodeURIComponent(v)}`);
  if (Array.isArray(body) && body.length) {
    allMatches = body.map((r) => ({ name: r.display_name, type: r.type, class: r.class, lat: +r.lat, lon: +r.lon }));
    lat = +body[0].lat; lon = +body[0].lon; resolvedName = body[0].display_name; matchedVariant = v;
    break;
  }
}
if (lat === null) { console.log(`\n${c.red}Geocoding failed entirely.${c.reset}\n`); process.exit(1); }

const bng = wgs84ToBng(lat, lon);
console.log(`  ${c.dim}→ ${resolvedName}${c.reset}`);
console.log(`  ${c.dim}→ BNG E${bng.easting} N${bng.northing}${c.reset}`);
if (allMatches.length > 1) {
  console.log(`  ${c.yellow}→ ${allMatches.length} candidate places. Disambiguation must choose:${c.reset}`);
  allMatches.forEach((m, i) => console.log(`     ${c.dim}${i + 1}. ${m.name} [${m.class}/${m.type}]${c.reset}`));
}
if (matchedVariant !== query) console.log(`  ${c.yellow}→ matched on "${matchedVariant}", NOT the full query${c.reset}`);
console.log();

/* ---- 2. BGS geology via WMS - THE FOUNDATION ----------------------- */
console.log(`${c.cyan}2. BGS geology via WMS GetFeatureInfo  ${c.dim}(this is what works)${c.reset}`);

const LAYERS = [
  ["BGS.50k.Bedrock", "bedrock"],
  ["BGS.50k.Superficial.deposits", "superficial"],
  ["BGS.50k.Artificial.ground", "artificial"],
  ["BGS.50k.Mass.movement", "mass movement"],
];
const geology = {};

for (const [layer, label] of LAYERS) {
  const half = 500;
  const bbox = `${bng.easting - half},${bng.northing - half},${bng.easting + half},${bng.northing + half}`;
  const body = await get(`${label} (${layer})`,
    `https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer?SERVICE=WMS&VERSION=1.3.0` +
    `&REQUEST=GetFeatureInfo&LAYERS=${layer}&QUERY_LAYERS=${layer}&CRS=EPSG:27700&BBOX=${bbox}` +
    `&WIDTH=101&HEIGHT=101&I=50&J=50&INFO_FORMAT=application/json&FORMAT=image/png`);

  const f = body?.features?.[0];
  if (f) {
    geology[label] = f.properties || {};
    console.log(`     ${c.green}${c.bold}FIELDS: ${Object.keys(f.properties || {}).join(", ")}${c.reset}`);
    for (const [k, v] of Object.entries(f.properties || {})) {
      if (v !== null && v !== "" && String(v) !== "Null") console.log(`       ${c.green}${k} = ${v}${c.reset}`);
    }
  } else if (body) {
    console.log(`     ${c.yellow}no feature at this point (may genuinely be absent - e.g. no artificial ground)${c.reset}`);
  }
}

// A second info format, in case JSON ever drops fields the others keep.
await get("bedrock as text/xml (fallback format check)",
  `https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer?SERVICE=WMS&VERSION=1.3.0` +
  `&REQUEST=GetFeatureInfo&LAYERS=BGS.50k.Bedrock&QUERY_LAYERS=BGS.50k.Bedrock&CRS=EPSG:27700` +
  `&BBOX=${bng.easting - 500},${bng.northing - 500},${bng.easting + 500},${bng.northing + 500}` +
  `&WIDTH=101&HEIGHT=101&I=50&J=50&INFO_FORMAT=text/xml&FORMAT=image/png`, "text/xml");
console.log();

/* ---- 3. What else is in GeoIndex_Onshore? -------------------------- */
console.log(`${c.cyan}3. BGS GeoIndex_Onshore services  ${c.dim}(21 found - what are they?)${c.reset}`);
const gi = await get("folder listing", "https://map.bgs.ac.uk/arcgis/rest/services/GeoIndex_Onshore?f=json");
if (gi?.services) gi.services.forEach((s) => console.log(`     ${c.dim}${s.name} (${s.type})${c.reset}`));
console.log();

/* ---- 4. NRFA catchment properties ---------------------------------- */
console.log(`${c.cyan}4. NRFA catchment properties  ${c.dim}(UK-wide)${c.reset}`);
const list = await get("all stations",
  "https://nrfaapps.ceh.ac.uk/nrfa/ws/station-info?format=json-object&station=*&fields=id,name,river,easting,northing,catchment-area");
let nearest = null;
if (list?.data) {
  const withDist = list.data
    .filter((s) => typeof s.easting === "number")
    .map((s) => ({ ...s, km: Math.hypot(s.easting - bng.easting, s.northing - bng.northing) / 1000 }))
    .sort((a, b) => a.km - b.km);
  nearest = withDist[0];
  console.log(`  ${c.dim}→ five nearest gauged catchments:${c.reset}`);
  withDist.slice(0, 5).forEach((s) =>
    console.log(`     ${c.dim}${s.id} ${s.name} (${s.river}) - ${s.km.toFixed(1)} km, ${s["catchment-area"]} km²${c.reset}`));
}
if (nearest) {
  const full = await get(`full record for ${nearest.id}`,
    `https://nrfaapps.ceh.ac.uk/nrfa/ws/station-info?format=json-object&station=${nearest.id}&fields=all`);
  const rec = full?.data?.[0];
  if (rec) {
    console.log(`  ${c.green}${c.bold}ALL NRFA FIELDS (${Object.keys(rec).length}):${c.reset}`);
    console.log(`     ${c.dim}${Object.keys(rec).join(", ")}${c.reset}`);
    // The fields that bear on sediment character.
    const interesting = Object.entries(rec).filter(([k]) =>
      /geolog|aquifer|bfi|perm|soil|urban|land|lcm|saar|propwet|area|elev|slope|sediment/i.test(k));
    if (interesting.length) {
      console.log(`  ${c.green}${c.bold}Fields bearing on sediment character:${c.reset}`);
      interesting.forEach(([k, v]) =>
        console.log(`       ${c.green}${k} = ${typeof v === "object" ? JSON.stringify(v).slice(0, 160) : v}${c.reset}`));
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
  resolved: { name: resolvedName, lat, lon, bng, matchedVariant, allMatches },
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
