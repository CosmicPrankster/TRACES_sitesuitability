#!/usr/bin/env node
/**
 * DATA SOURCE PROBE
 * =================
 *
 * Calls every candidate data source for a site and records exactly what comes
 * back. Nothing is built on a source until this has proven it responds.
 *
 * The development sandbox for this project has no outbound network, so this
 * MUST be run on a machine that does. Its output decides what gets built next.
 *
 *   node scripts/probe.mjs "Kinness Burn, St Andrews"
 *   node scripts/probe.mjs "Tilford, River Wey"
 *
 * Writes a full report to probe-results/<slug>.json and prints a summary.
 * No dependencies. Node 18+.
 */

import { writeFile, mkdir } from "node:fs/promises";

const TIMEOUT_MS = 20000;
const UA = process.env.SITE_DATA_USER_AGENT ||
  "traces-site-suitability-probe/0.2 (research prototype; set SITE_DATA_USER_AGENT)";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: node scripts/probe.mjs "Kinness Burn, St Andrews"');
  process.exit(1);
}

const results = [];
const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

/** Calls a URL and records everything about what happened. */
async function probe(group, name, url, opts = {}) {
  const started = Date.now();
  const entry = { group, name, url, ok: false };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: opts.accept || "application/json", "User-Agent": UA },
    });
    entry.httpStatus = res.status;
    entry.ms = Date.now() - started;
    entry.contentType = res.headers.get("content-type") || null;

    const text = await res.text();
    entry.bytes = text.length;

    if (!res.ok) {
      entry.error = `HTTP ${res.status} ${res.statusText}`;
      entry.bodySample = text.slice(0, 400);
    } else if ((entry.contentType || "").includes("json") || text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
      try {
        entry.json = JSON.parse(text);
        entry.ok = true;
      } catch (e) {
        entry.error = `Body was not valid JSON: ${e.message}`;
        entry.bodySample = text.slice(0, 400);
      }
    } else {
      entry.ok = true;
      entry.bodySample = text.slice(0, 800);
    }
  } catch (err) {
    entry.ms = Date.now() - started;
    entry.error = err.name === "AbortError" ? `timed out after ${TIMEOUT_MS} ms` : err.message;
  } finally {
    clearTimeout(timer);
  }

  results.push(entry);
  const mark = entry.ok ? `${c.green}ok${c.reset}` : `${c.red}FAIL${c.reset}`;
  const detail = entry.ok ? `${entry.ms} ms, ${entry.bytes} bytes` : entry.error;
  console.log(`  ${mark}  ${name}  ${c.dim}${detail}${c.reset}`);
  return entry;
}

/** Shows the shape of a response without dumping the whole thing. */
function shapeOf(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.length} x ${shapeOf(value[0], depth + 1)}]`;
  }
  if (typeof value === "object") {
    if (depth > 2) return "{...}";
    const keys = Object.keys(value).slice(0, 14);
    return `{${keys.join(", ")}${Object.keys(value).length > 14 ? ", ..." : ""}}`;
  }
  return typeof value;
}

console.log(`\n${c.bold}Probing data sources for:${c.reset} ${query}`);
console.log(`${c.dim}User-Agent: ${UA}${c.reset}\n`);

/* ------------------------------------------------------------------ */
/* 1. GEOCODING - everything else needs the coordinates this returns   */
/* ------------------------------------------------------------------ */
console.log(`${c.cyan}1. Geocoding${c.reset}`);

const variants = [...new Set([
  query,
  ...query.split(",").map((p) => p.trim()).filter(Boolean).reverse(),
])];

let lat = null, lon = null, resolvedName = null, resolvedVia = null;

for (const v of variants) {
  if (lat !== null) break;

  const om = await probe("geocode", `Open-Meteo "${v}"`,
    `https://geocoding-api.open-meteo.com/v1/search?count=3&language=en&format=json&name=${encodeURIComponent(v)}`);
  const omHit = om.json?.results?.[0];
  if (omHit?.latitude != null) {
    lat = omHit.latitude; lon = omHit.longitude;
    resolvedName = [omHit.name, omHit.admin2, omHit.admin1, omHit.country].filter(Boolean).join(", ");
    resolvedVia = "Open-Meteo";
    om.extracted = { lat, lon, name: resolvedName, alternatives: (om.json.results || []).map(r => r.name) };
    break;
  }

  const nom = await probe("geocode", `Nominatim "${v}"`,
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&addressdetails=1&q=${encodeURIComponent(v)}`);
  const nomHit = Array.isArray(nom.json) ? nom.json[0] : undefined;
  if (nomHit?.lat) {
    lat = parseFloat(nomHit.lat); lon = parseFloat(nomHit.lon);
    resolvedName = nomHit.display_name;
    resolvedVia = "Nominatim";
    nom.extracted = { lat, lon, name: resolvedName, alternatives: nom.json.map(r => r.display_name) };
    break;
  }
}

if (lat === null) {
  console.log(`\n${c.red}${c.bold}Geocoding failed for every variant.${c.reset}`);
  console.log("Nothing downstream can run without coordinates. Fix this first.\n");
} else {
  console.log(`  ${c.dim}→ ${resolvedName} (${lat}, ${lon}) via ${resolvedVia}${c.reset}\n`);
}

/* ------------------------------------------------------------------ */
/* 2. EA REAL-TIME RIVER LEVEL + RAINFALL (England only)              */
/* ------------------------------------------------------------------ */
if (lat !== null) {
  console.log(`${c.cyan}2. Environment Agency real-time (England only)${c.reset}`);

  const stations = await probe("ea-flood", "Nearby river stations",
    `https://environment.data.gov.uk/flood-monitoring/id/stations?lat=${lat}&long=${lon}&dist=15&_limit=10`);
  const st = stations.json?.items?.[0];
  if (st) {
    stations.extracted = {
      count: stations.json.items.length,
      first: { label: st.label, riverName: st.riverName, catchmentName: st.catchmentName,
               stationReference: st.stationReference, lat: st.lat, long: st.long },
      allKeys: Object.keys(st),
    };
    const ref = st.stationReference || st.notation;
    if (ref) {
      const rd = await probe("ea-flood", `Readings for station ${ref}`,
        `https://environment.data.gov.uk/flood-monitoring/id/stations/${encodeURIComponent(ref)}/readings?_sorted&_limit=5`);
      if (rd.json?.items?.[0]) rd.extracted = { sample: rd.json.items.slice(0, 3) };
    }
  }

  const rain = await probe("ea-flood", "Nearby rainfall gauges",
    `https://environment.data.gov.uk/flood-monitoring/id/stations?parameter=rainfall&lat=${lat}&long=${lon}&dist=15&_limit=5`);
  const rs = rain.json?.items?.[0];
  if (rs) {
    const ref = rs.stationReference || rs.notation;
    rain.extracted = { count: rain.json.items.length, first: rs.label, ref };
    if (ref) {
      const since = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
      const rr = await probe("ea-flood", "Rainfall, last 72 h",
        `https://environment.data.gov.uk/flood-monitoring/id/stations/${encodeURIComponent(ref)}/readings?since=${encodeURIComponent(since)}&_limit=500`);
      const vals = (rr.json?.items || []).map(i => i.value).filter(v => typeof v === "number");
      if (vals.length) {
        rr.extracted = { readings: vals.length, totalMm: +vals.reduce((a, b) => a + b, 0).toFixed(1) };
        console.log(`  ${c.dim}→ ${rr.extracted.totalMm} mm over ${vals.length} readings${c.reset}`);
      }
    }
  }
  console.log();

  /* ---------------------------------------------------------------- */
  /* 3. EA WATER QUALITY ARCHIVE                                       */
  /* ---------------------------------------------------------------- */
  console.log(`${c.cyan}3. EA Water Quality Archive (England only)${c.reset}`);
  const sp = await probe("ea-wq", "Nearby sampling points",
    `https://environment.data.gov.uk/water-quality/id/sampling-point?lat=${lat}&long=${lon}&dist=8&_limit=10`);
  const point = sp.json?.items?.[0];
  if (point) {
    sp.extracted = { count: sp.json.items.length, first: { notation: point.notation, label: point.label }, allKeys: Object.keys(point) };
    for (const [code, what] of [["0135", "suspended solids"], ["0076", "turbidity"]]) {
      const m = await probe("ea-wq", `Measurements: ${what} (determinand ${code})`,
        `https://environment.data.gov.uk/water-quality/data/measurement.json?samplingPoint=${encodeURIComponent(point.notation)}&determinand=${code}&_limit=10`);
      const items = m.json?.items || [];
      if (items.length) {
        m.extracted = { count: items.length, sample: items.slice(0, 2), allKeys: Object.keys(items[0]) };
        console.log(`  ${c.dim}→ ${items.length} ${what} results found${c.reset}`);
      }
    }
  }
  console.log();

  /* ---------------------------------------------------------------- */
  /* 4. EA CATCHMENT DATA EXPLORER                                     */
  /* ---------------------------------------------------------------- */
  console.log(`${c.cyan}4. EA Catchment Data Explorer${c.reset}`);
  await probe("ea-catchment", "Waterbody search by name",
    `https://environment.data.gov.uk/catchment-planning/WaterBody.json?search=${encodeURIComponent(variants[variants.length - 1])}&_limit=5`);
  await probe("ea-catchment", "So/Search index",
    `https://environment.data.gov.uk/catchment-planning/so/WaterBody.json?_limit=3`);
  console.log();

  /* ---------------------------------------------------------------- */
  /* 5. BGS GEOLOGY - exploratory: find what exists before guessing    */
  /* ---------------------------------------------------------------- */
  console.log(`${c.cyan}5. BGS geology${c.reset}`);
  const svc = await probe("bgs", "List ArcGIS services (discovery)",
    "https://map.bgs.ac.uk/arcgis/rest/services?f=json");
  if (svc.json) {
    svc.extracted = {
      folders: svc.json.folders,
      services: (svc.json.services || []).map((s) => `${s.name} (${s.type})`),
    };
    console.log(`  ${c.dim}→ folders: ${(svc.json.folders || []).join(", ") || "none"}${c.reset}`);
    console.log(`  ${c.dim}→ services: ${((svc.json.services || []).map(s => s.name).slice(0, 12)).join(", ") || "none"}${c.reset}`);
  }

  for (const candidate of ["BGS_Detailed_Geology", "GeoIndex/BGS_Geology", "BGS_Geology_625k"]) {
    const meta = await probe("bgs", `MapServer metadata: ${candidate}`,
      `https://map.bgs.ac.uk/arcgis/rest/services/${candidate}/MapServer?f=json`);
    if (meta.json?.layers) {
      meta.extracted = { layers: meta.json.layers.map((l) => `${l.id}: ${l.name}`) };
      console.log(`  ${c.dim}→ layers: ${meta.extracted.layers.slice(0, 8).join(" | ")}${c.reset}`);

      const d = 0.002;
      const idf = await probe("bgs", `Identify at point: ${candidate}`,
        `https://map.bgs.ac.uk/arcgis/rest/services/${candidate}/MapServer/identify?f=json` +
        `&geometry=${encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }))}` +
        `&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=5&returnGeometry=false` +
        `&mapExtent=${lon - d},${lat - d},${lon + d},${lat + d}&imageDisplay=400,400,96`);
      const r0 = idf.json?.results?.[0];
      if (r0) {
        idf.extracted = {
          resultCount: idf.json.results.length,
          layerNames: [...new Set(idf.json.results.map((r) => r.layerName))],
          ATTRIBUTE_KEYS_SEEN: Object.keys(r0.attributes || {}),
          firstAttributes: r0.attributes,
        };
        console.log(`  ${c.green}→ GEOLOGY FOUND. Attribute keys: ${idf.extracted.ATTRIBUTE_KEYS_SEEN.join(", ")}${c.reset}`);
      }
      break;
    }
  }
  console.log();

  /* ---------------------------------------------------------------- */
  /* 6. SCOTLAND - SEPA, since EA covers England only                  */
  /* ---------------------------------------------------------------- */
  console.log(`${c.cyan}6. SEPA (Scotland)${c.reset}`);
  await probe("sepa", "SEPA river levels (all stations)",
    "https://apps.sepa.org.uk/database/riverlevels/SEPA_River_Levels_Web.csv", { accept: "text/csv" });
  console.log();
}

/* ------------------------------------------------------------------ */
/* SUMMARY                                                             */
/* ------------------------------------------------------------------ */
const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
await mkdir("probe-results", { recursive: true });
const outPath = `probe-results/${slug}.json`;

await writeFile(outPath, JSON.stringify({
  query, probedAt: new Date().toISOString(), userAgent: UA,
  resolved: { name: resolvedName, lat, lon, via: resolvedVia },
  results: results.map((r) => ({
    ...r,
    // Keep the shape and any extraction, drop the full payload to stay readable.
    jsonShape: r.json ? shapeOf(r.json) : undefined,
    json: undefined,
  })),
}, null, 2));

console.log(`${c.bold}SUMMARY${c.reset}`);
const byGroup = {};
for (const r of results) (byGroup[r.group] ||= []).push(r);
for (const [group, rs] of Object.entries(byGroup)) {
  const ok = rs.filter((r) => r.ok).length;
  const mark = ok > 0 ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
  console.log(`  ${mark} ${group.padEnd(14)} ${ok}/${rs.length} calls succeeded`);
}

console.log(`\n${c.bold}What to do next${c.reset}`);
if (lat === null) {
  console.log("  Geocoding failed, so nothing else could run. Check this machine's");
  console.log("  internet access from Node (proxy/VPN/firewall), then re-run.");
} else {
  const worked = Object.entries(byGroup).filter(([g, rs]) => g !== "geocode" && rs.some((r) => r.ok)).map(([g]) => g);
  console.log(`  Sources that returned data: ${worked.join(", ") || "none"}`);
  console.log("  Only these will be built on. Anything that failed gets dropped or fixed.");
}
console.log(`\n  Full report written to ${c.bold}${outPath}${c.reset}`);
console.log("  Send that file back, and the providers get written against what");
console.log("  actually came back rather than what ought to.\n");
