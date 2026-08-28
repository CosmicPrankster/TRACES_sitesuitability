#!/usr/bin/env node
/**
 * DATA SOURCE PROBE  (v2)
 * =======================
 *
 * Calls every candidate data source and records exactly what comes back.
 * Nothing gets built on a source until this proves it returns usable data.
 *
 *   node scripts/probe.mjs "Kinness Burn, St Andrews"
 *
 * v2 changes, driven by the v1 results:
 *  - Distinguishes "responded" from "responded WITH DATA". v1 reported an empty
 *    result as ok, which hid the two most important failures.
 *  - BGS identify returned an empty result set in v1. Six variants are now
 *    tried - explicit layer ids, wider extents, bigger tolerance, and British
 *    National Grid coordinates - to find which one the service actually wants.
 *  - EA water quality and catchment 404'd. Several URL forms are tried.
 *  - Adds NRFA, which covers Scotland and Wales as well as England, and SEPA
 *    and EA Hydrology alternatives.
 *
 * No dependencies. Node 18+. Takes a few minutes: the EA endpoints are slow.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { wgs84ToBng } from "./lib/bng.mjs";

const TIMEOUT_MS = 30000;
const UA = process.env.SITE_DATA_USER_AGENT ||
  "traces-site-suitability-probe/0.3 (research prototype; set SITE_DATA_USER_AGENT)";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: node scripts/probe.mjs "Kinness Burn, St Andrews"');
  process.exit(1);
}

const results = [];
const c = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
            green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m" };

/**
 * @param countItems  given the parsed body, return how many usable records it
 *                    holds. This is what separates "responded" from "useful".
 */
async function probe(group, name, url, { accept, countItems, extract } = {}) {
  const started = Date.now();
  const entry = { group, name, url, responded: false, usable: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: accept || "application/json", "User-Agent": UA },
    });
    entry.httpStatus = res.status;
    entry.ms = Date.now() - started;
    const text = await res.text();
    entry.bytes = text.length;

    if (!res.ok) {
      entry.error = `HTTP ${res.status} ${res.statusText}`;
      entry.bodySample = text.slice(0, 300);
    } else {
      entry.responded = true;
      let body = text;
      if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
        try { body = JSON.parse(text); } catch { /* leave as text */ }
      }
      entry.count = countItems ? countItems(body) : (text.length > 0 ? 1 : 0);
      entry.usable = (entry.count ?? 0) > 0;
      if (entry.usable && extract) {
        try { entry.extracted = extract(body); } catch (e) { entry.extractError = e.message; }
      }
      if (!entry.usable) entry.bodySample = (typeof body === "string" ? body : JSON.stringify(body)).slice(0, 300);
    }
  } catch (err) {
    entry.ms = Date.now() - started;
    entry.error = err.name === "AbortError" ? `timed out after ${TIMEOUT_MS} ms`
      : `${err.message}${err.cause ? ` (${err.cause.code || err.cause.message})` : ""}`;
  } finally {
    clearTimeout(timer);
  }

  results.push(entry);
  const mark = entry.usable ? `${c.green}DATA${c.reset}`
    : entry.responded ? `${c.yellow}empty${c.reset}`
    : `${c.red}FAIL${c.reset}`;
  const detail = entry.responded
    ? `${entry.ms} ms, ${entry.bytes} b${entry.count !== undefined ? `, ${entry.count} items` : ""}`
    : entry.error;
  console.log(`  ${mark.padEnd(16)} ${name}  ${c.dim}${detail}${c.reset}`);
  return entry;
}

const len = (x) => (Array.isArray(x) ? x.length : 0);
console.log(`\n${c.bold}Probing data sources for:${c.reset} ${query}`);
console.log(`${c.dim}${UA}${c.reset}\n`);

/* ================================================================== */
/* 1. GEOCODING                                                        */
/* ================================================================== */
console.log(`${c.cyan}1. Geocoding${c.reset}`);
const variants = [...new Set([query, ...query.split(",").map((p) => p.trim()).filter(Boolean).reverse()])];
let lat = null, lon = null, resolvedName = null, resolvedVia = null, matchedVariant = null;

for (const v of variants) {
  if (lat !== null) break;
  const om = await probe("geocode", `Open-Meteo "${v}"`,
    `https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=${encodeURIComponent(v)}`,
    { countItems: (b) => len(b?.results), extract: (b) => b.results.map((r) => `${r.name} (${r.admin1}, ${r.country})`) });
  if (om.usable) {
    const raw = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(v)}`,
      { headers: { "User-Agent": UA } }).then((r) => r.json()).catch(() => null);
    const hit = raw?.results?.[0];
    if (hit?.latitude != null) {
      lat = hit.latitude; lon = hit.longitude; matchedVariant = v; resolvedVia = "Open-Meteo";
      resolvedName = [hit.name, hit.admin2, hit.admin1, hit.country].filter(Boolean).join(", ");
      break;
    }
  }

  const nom = await probe("geocode", `Nominatim "${v}"`,
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&q=${encodeURIComponent(v)}`,
    { countItems: (b) => len(b), extract: (b) => b.map((r) => r.display_name) });
  if (nom.usable) {
    const raw = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(v)}`,
      { headers: { "User-Agent": UA } }).then((r) => r.json()).catch(() => null);
    const hit = Array.isArray(raw) ? raw[0] : null;
    if (hit?.lat) {
      lat = parseFloat(hit.lat); lon = parseFloat(hit.lon); matchedVariant = v; resolvedVia = "Nominatim";
      resolvedName = hit.display_name;
      break;
    }
  }
}

if (lat === null) {
  console.log(`\n${c.red}${c.bold}Geocoding failed. Nothing downstream can run.${c.reset}\n`);
  process.exit(1);
}

const bng = wgs84ToBng(lat, lon);
console.log(`  ${c.dim}→ ${resolvedName}${c.reset}`);
console.log(`  ${c.dim}→ WGS84 ${lat}, ${lon}   BNG E${bng.easting} N${bng.northing}${c.reset}`);
if (matchedVariant !== query) {
  console.log(`  ${c.yellow}→ NOTE: the full query did not match. This is "${matchedVariant}", which may be`);
  console.log(`     a different place from what you meant. Site disambiguation must handle this.${c.reset}`);
}
console.log();

/* ================================================================== */
/* 2. BGS GEOLOGY - the critical one. v1 returned an empty result set. */
/* ================================================================== */
console.log(`${c.cyan}2. BGS geology  ${c.dim}(v1 responded but returned nothing - finding out why)${c.reset}`);

const BGS = "https://map.bgs.ac.uk/arcgis/rest/services";
const countIdentify = (b) => len(b?.results);
const extractIdentify = (b) => ({
  layers: [...new Set(b.results.map((r) => r.layerName))],
  ATTRIBUTE_KEYS: Object.keys(b.results[0].attributes || {}),
  firstAttributes: b.results[0].attributes,
  allValues: b.results.map((r) => ({ layer: r.layerName, value: r.value })),
});

const pt4326 = encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }));
const pt27700 = encodeURIComponent(JSON.stringify({ x: bng.easting, y: bng.northing, spatialReference: { wkid: 27700 } }));

const bgsVariants = [
  { label: "layers=all, small extent (v1 - the one that failed)",
    q: `geometry=${pt4326}&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=5&mapExtent=${lon - 0.002},${lat - 0.002},${lon + 0.002},${lat + 0.002}&imageDisplay=400,400,96` },
  { label: "layers=all:0,1,2,3,4 explicit (bypasses scale visibility)",
    q: `geometry=${pt4326}&geometryType=esriGeometryPoint&sr=4326&layers=all:0,1,2,3,4&tolerance=10&mapExtent=${lon - 0.01},${lat - 0.01},${lon + 0.01},${lat + 0.01}&imageDisplay=800,800,96` },
  { label: "layers=all:3,4 superficial+bedrock only",
    q: `geometry=${pt4326}&geometryType=esriGeometryPoint&sr=4326&layers=all:3,4&tolerance=10&mapExtent=${lon - 0.02},${lat - 0.02},${lon + 0.02},${lat + 0.02}&imageDisplay=800,800,96` },
  { label: "British National Grid coordinates (sr=27700)",
    q: `geometry=${pt27700}&geometryType=esriGeometryPoint&sr=27700&layers=all:0,1,2,3,4&tolerance=10&mapExtent=${bng.easting - 1000},${bng.northing - 1000},${bng.easting + 1000},${bng.northing + 1000}&imageDisplay=800,800,96` },
  { label: "BNG, wide extent, big tolerance",
    q: `geometry=${pt27700}&geometryType=esriGeometryPoint&sr=27700&layers=all:3,4&tolerance=20&mapExtent=${bng.easting - 5000},${bng.northing - 5000},${bng.easting + 5000},${bng.northing + 5000}&imageDisplay=600,600,96` },
];

let bgsWorking = null;
for (const v of bgsVariants) {
  const r = await probe("bgs-identify", v.label,
    `${BGS}/BGS_Detailed_Geology/MapServer/identify?f=json&returnGeometry=false&${v.q}`,
    { countItems: countIdentify, extract: extractIdentify });
  if (r.usable) {
    bgsWorking = { variant: v.label, url: r.url, keys: r.extracted.ATTRIBUTE_KEYS };
    console.log(`  ${c.green}${c.bold}→ THIS ONE WORKS. Attribute keys: ${r.extracted.ATTRIBUTE_KEYS.join(", ")}${c.reset}`);
    console.log(`  ${c.green}→ ${JSON.stringify(r.extracted.allValues)}${c.reset}`);
    break;
  }
}

// Alternative BGS services, in case the Detailed_Geology one is not the right home.
for (const folder of ["GeologyOfBritain", "GeoIndex_Onshore"]) {
  await probe("bgs-discovery", `Services in folder ${folder}`,
    `${BGS}/${folder}?f=json`,
    { countItems: (b) => len(b?.services), extract: (b) => b.services.map((s) => `${s.name} (${s.type})`) });
}

// WMS GetFeatureInfo - a different protocol entirely, in case REST is the problem.
const wmsBbox = `${bng.easting - 500},${bng.northing - 500},${bng.easting + 500},${bng.northing + 500}`;
await probe("bgs-wms", "WMS GetFeatureInfo (bedrock)",
  `https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo` +
  `&LAYERS=BGS.50k.Bedrock&QUERY_LAYERS=BGS.50k.Bedrock&CRS=EPSG:27700&BBOX=${wmsBbox}` +
  `&WIDTH=101&HEIGHT=101&I=50&J=50&INFO_FORMAT=application/json&FORMAT=image/png`,
  { accept: "application/json", countItems: (b) => (typeof b === "string" ? (b.length > 50 ? 1 : 0) : len(b?.features)) });
console.log();

/* ================================================================== */
/* 3. NRFA - National River Flow Archive. UK-WIDE, including Scotland. */
/* ================================================================== */
console.log(`${c.cyan}3. NRFA catchment data  ${c.dim}(new - covers Scotland and Wales too)${c.reset}`);
const NRFA = "https://nrfaapps.ceh.ac.uk/nrfa/ws";

const near = await probe("nrfa", "Stations near this point",
  `${NRFA}/station-info?format=json-object&station=*&fields=id,name,easting,northing,catchment-area,river`,
  { countItems: (b) => len(b?.data),
    extract: (b) => {
      const withDist = b.data
        .filter((s) => typeof s.easting === "number" && typeof s.northing === "number")
        .map((s) => ({ ...s, km: Math.hypot(s.easting - bng.easting, s.northing - bng.northing) / 1000 }))
        .sort((a, b2) => a.km - b2.km)
        .slice(0, 5);
      return { nearest: withDist.map((s) => `${s.id} ${s.name} (${s.river}) ${s.km.toFixed(1)} km, area ${s['catchment-area']} km2`) };
    } });

if (near.usable && near.extracted?.nearest?.length) {
  console.log(`  ${c.dim}→ nearest: ${near.extracted.nearest[0]}${c.reset}`);
  const id = near.extracted.nearest[0].split(" ")[0];
  await probe("nrfa", `Full catchment properties for station ${id}`,
    `${NRFA}/station-info?format=json-object&station=${id}&fields=all`,
    { countItems: (b) => len(b?.data),
      extract: (b) => ({ ALL_FIELDS: Object.keys(b.data[0] || {}), record: b.data[0] }) });
}
console.log();

/* ================================================================== */
/* 4. EA REAL-TIME (England only)                                     */
/* ================================================================== */
console.log(`${c.cyan}4. EA real-time river level and rainfall  ${c.dim}(England only)${c.reset}`);
const st = await probe("ea-flood", "River stations within 15 km",
  `https://environment.data.gov.uk/flood-monitoring/id/stations?lat=${lat}&long=${lon}&dist=15&_limit=10`,
  { countItems: (b) => len(b?.items),
    extract: (b) => ({ count: b.items.length, first: b.items[0], KEYS: Object.keys(b.items[0] || {}) }) });

if (st.usable) {
  const s0 = st.extracted.first;
  const ref = s0.stationReference || s0.notation;
  await probe("ea-flood", `Readings for ${ref}`,
    `https://environment.data.gov.uk/flood-monitoring/id/stations/${encodeURIComponent(ref)}/readings?_sorted&_limit=5`,
    { countItems: (b) => len(b?.items), extract: (b) => ({ sample: b.items.slice(0, 3) }) });
}

const rg = await probe("ea-flood", "Rainfall gauges within 15 km",
  `https://environment.data.gov.uk/flood-monitoring/id/stations?parameter=rainfall&lat=${lat}&long=${lon}&dist=15&_limit=5`,
  { countItems: (b) => len(b?.items), extract: (b) => ({ first: b.items[0]?.label, ref: b.items[0]?.stationReference }) });
if (rg.usable && rg.extracted.ref) {
  const since = new Date(Date.now() - 72 * 3600e3).toISOString();
  await probe("ea-flood", "Rainfall total, last 72 h",
    `https://environment.data.gov.uk/flood-monitoring/id/stations/${encodeURIComponent(rg.extracted.ref)}/readings?since=${encodeURIComponent(since)}&_limit=500`,
    { countItems: (b) => len(b?.items),
      extract: (b) => ({ readings: b.items.length,
        totalMm: +b.items.map((i) => i.value).filter((v) => typeof v === "number").reduce((a, x) => a + x, 0).toFixed(1) }) });
}
console.log();

/* ================================================================== */
/* 5. EA WATER QUALITY - 404'd in v1. Trying other URL forms.          */
/* ================================================================== */
console.log(`${c.cyan}5. EA Water Quality Archive  ${c.dim}(404'd in v1)${c.reset}`);
const WQ = "https://environment.data.gov.uk/water-quality";
for (const [label, url] of [
  [".json extension", `${WQ}/id/sampling-point.json?lat=${lat}&long=${lon}&dist=8&_limit=10`],
  ["/data/sampling-point.json", `${WQ}/data/sampling-point.json?lat=${lat}&long=${lon}&dist=8&_limit=10`],
  ["easting/northing", `${WQ}/id/sampling-point.json?easting=${bng.easting}&northing=${bng.northing}&dist=8&_limit=10`],
  ["API root (discovery)", `${WQ}/api/resource.json?_limit=5`],
  ["batch measurement index", `${WQ}/batch/measurement.json?_limit=5`],
]) {
  await probe("ea-wq", label, url, {
    countItems: (b) => len(b?.items) || len(b?.result) || 0,
    extract: (b) => ({ KEYS: Object.keys(b.items?.[0] || {}), first: b.items?.[0] }),
  });
}
console.log();

/* ================================================================== */
/* 6. EA CATCHMENT DATA EXPLORER - 404'd in v1.                        */
/* ================================================================== */
console.log(`${c.cyan}6. EA Catchment Data Explorer  ${c.dim}(404'd in v1)${c.reset}`);
const CP = "https://environment.data.gov.uk/catchment-planning";
for (const [label, url] of [
  ["so/WaterBody index", `${CP}/so/WaterBody.json?_limit=3`],
  ["WaterBody by search", `${CP}/WaterBody.json?_search=${encodeURIComponent(matchedVariant)}&_limit=5`],
  ["OperationalCatchment index", `${CP}/OperationalCatchment.json?_limit=3`],
  ["root discovery", `${CP}/data.json?_limit=3`],
  ["ReasonsForNotAchievingGood", `${CP}/ReasonForNotAchievingGood.json?_limit=3`],
]) {
  await probe("ea-catchment", label, url, {
    countItems: (b) => len(b?.items) || len(b?.result?.items) || 0,
    extract: (b) => ({ KEYS: Object.keys((b.items || b.result?.items || [])[0] || {}) }),
  });
}
console.log();

/* ================================================================== */
/* 7. SEPA (Scotland) - "fetch failed" in v1.                          */
/* ================================================================== */
console.log(`${c.cyan}7. SEPA, Scotland  ${c.dim}(fetch failed in v1)${c.reset}`);
for (const [label, url, accept] of [
  ["www2 rainfall station list", "https://www2.sepa.org.uk/rainfall/api/Stations?format=json", "application/json"],
  ["river levels CSV (v1 host)", "https://apps.sepa.org.uk/database/riverlevels/SEPA_River_Levels_Web.csv", "text/csv"],
  ["water classification hub", "https://www.sepa.org.uk/data-visualisation/water-classification-hub/", "text/html"],
]) {
  await probe("sepa", label, url, { accept, countItems: (b) => (typeof b === "string" ? (b.length > 200 ? 1 : 0) : len(b)) });
}
console.log();

/* ================================================================== */
/* SUMMARY                                                             */
/* ================================================================== */
const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
await mkdir("probe-results", { recursive: true });
const outPath = `probe-results/${slug}.json`;
await writeFile(outPath, JSON.stringify({
  query, probedAt: new Date().toISOString(),
  resolved: { name: resolvedName, lat, lon, bng, via: resolvedVia, matchedVariant },
  bgsWorking, results,
}, null, 2));

console.log(`${c.bold}SUMMARY${c.reset}  ${c.dim}(DATA = returned usable records; empty = responded with nothing)${c.reset}`);
const byGroup = {};
for (const r of results) (byGroup[r.group] ||= []).push(r);
for (const [g, rs] of Object.entries(byGroup)) {
  const usable = rs.filter((r) => r.usable).length;
  const mark = usable > 0 ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
  console.log(`  ${mark} ${g.padEnd(16)} ${usable}/${rs.length} returned data`);
}

console.log(`\n${c.bold}KEY QUESTION - did BGS geology work?${c.reset}`);
if (bgsWorking) {
  console.log(`  ${c.green}YES${c.reset} - via: ${bgsWorking.variant}`);
  console.log(`  Attribute keys: ${bgsWorking.keys.join(", ")}`);
} else {
  console.log(`  ${c.red}NO${c.reset} - every identify variant came back empty. The full report has`);
  console.log(`  each URL and response so the next attempt is not another guess.`);
}
console.log(`\n  Full report: ${c.bold}${outPath}${c.reset}\n`);
