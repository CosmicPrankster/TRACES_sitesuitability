#!/usr/bin/env node
/**
 * PROBE: small/ungauged catchment sources (idea #5)
 * ===================================================
 *
 * The problem this is for: for a small or urban watercourse with no NRFA
 * gauge (Barden Lake, Alder Stream, Furnace Pond, the Tillingbourne at
 * Chilworth all did this in testing), the app now falls back to BGS geology
 * at the single geocoded point (see lib/character.ts's
 * inferCharacterFromGeologyOnly). That is honest but weak - no catchment
 * context, no land use signal, confidence permanently capped low.
 *
 * This probes candidate sources that might give a SMALL catchment's own
 * boundary and/or land cover, the way NRFA does for gauged rivers - so an
 * ungauged site could get more than a single point. NONE of these URLs are
 * confirmed to work. This project's own rule: a source that has not been
 * proven to respond is not built on (see BUILD.md's dropped-source list -
 * five candidates already failed comprehensively on real test sites before
 * anything was built against them). This script is that proving step.
 *
 * This session's sandbox blocks all outbound network entirely (org egress
 * policy, confirmed via the agent proxy status endpoint - not source
 * specific), so this cannot be run here. Run it locally, where the same
 * two-screen app already resolves real sites, and share the output back -
 * only sources that return real, usable data at a real small-catchment
 * site should get built on.
 *
 *   node scripts/probe-small-catchments.mjs "Barden Lake, Tonbridge"
 *   node scripts/probe-small-catchments.mjs "Alder Stream, Colts Hill"
 *   node scripts/probe-small-catchments.mjs "Furnace Pond, Horsmonden"
 *   node scripts/probe-small-catchments.mjs "Kinness Burn, St Andrews"
 */

import { wgs84ToBng } from "./lib/bng.mjs";

const TIMEOUT_MS = 20000;
const UA = process.env.SITE_DATA_USER_AGENT ||
  "traces-site-suitability-probe/0.1 (research prototype; set SITE_DATA_USER_AGENT)";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: node scripts/probe-small-catchments.mjs "Barden Lake, Tonbridge"');
  process.exit(1);
}

const c = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
            green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m" };

async function get(name, url, accept = "application/json") {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: accept, "User-Agent": UA } });
    const text = await res.text();
    const ms = Date.now() - started;
    console.log(`  ${res.ok ? c.green + "ok  " : c.red + "FAIL"}${c.reset} ${name} ${c.dim}${res.status}, ${ms} ms, ${text.length} b${c.reset}`);
    if (res.ok && text.length > 50) {
      console.log(`       ${c.dim}${text.replace(/\s+/g, " ").slice(0, 400)}${c.reset}`);
    }
    return res.ok ? text : null;
  } catch (err) {
    console.log(`  ${c.red}FAIL${c.reset} ${name} ${c.dim}${err.message}${c.reset}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

console.log(`\n${c.bold}Probing small-catchment sources for:${c.reset} ${query}\n`);

/* ---- geocode, same as scripts/probe.mjs -------------------------------- */
console.log(`${c.cyan}1. Geocode (reusing the already-proven Nominatim path)${c.reset}`);
const geo = await get("nominatim", `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=gb&q=${encodeURIComponent(query)}`);
const geoBody = geo ? JSON.parse(geo) : [];
if (!geoBody.length) { console.log(`${c.red}Could not geocode "${query}" - stopping.${c.reset}\n`); process.exit(1); }
const { lat, lon } = geoBody[0];
const bng = wgs84ToBng(+lat, +lon);
console.log(`  ${c.green}→ ${geoBody[0].display_name}${c.reset}`);
console.log(`  ${c.dim}→ BNG E${bng.easting} N${bng.northing}${c.reset}\n`);

/* ---- candidates ---------------------------------------------------------
 * Each is a GUESS at a real endpoint. None are confirmed. Trying several
 * plausible forms per source, same as scripts/probe.mjs did for BGS's
 * INFO_FORMAT - the goal is to find which (if any) actually carries data.
 */

console.log(`${c.cyan}2. EA WFD river water body catchments (England) - candidate ArcGIS REST forms${c.reset}`);
const half = 250;
const bbox = `${bng.easting - half},${bng.northing - half},${bng.easting + half},${bng.northing + half}`;
const eaCandidates = [
  `https://environment.data.gov.uk/arcgis/rest/services/EA/WFDRiverWaterBodyCatchments/FeatureServer/0/query?geometry=${bng.easting},${bng.northing}&geometryType=esriGeometryPoint&inSR=27700&spatialRel=esriSpatialRelIntersects&outFields=*&f=json`,
  `https://environment.data.gov.uk/arcgis/rest/services/WFD/WFD_River_Water_Body_Catchments/FeatureServer/0/query?geometry=${bng.easting},${bng.northing}&geometryType=esriGeometryPoint&inSR=27700&spatialRel=esriSpatialRelIntersects&outFields=*&f=json`,
  `https://environment.data.gov.uk/arcgis/rest/services?f=json`,
];
for (const url of eaCandidates) await get(url.includes("?f=json") && url.endsWith("services?f=json") ? "EA arcgis service catalogue" : "EA WFD catchment query", url);

console.log(`\n${c.cyan}3. MAGIC (DEFRA) WMS - land cover / agricultural land classification at the point${c.reset}`);
const magicCandidates = [
  `https://environment.data.gov.uk/arcgis/services/MAGIC/MAGIC_ExtraSectorRelevant/MapServer/WMSServer?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`,
  `https://magic.defra.gov.uk/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`,
];
for (const url of magicCandidates) await get("MAGIC WMS GetCapabilities", url, "text/xml");

console.log(`\n${c.cyan}4. SEPA open data (Scotland) - water body catchments${c.reset}`);
const sepaCandidates = [
  `https://data.sepa.org.uk/api/3/action/package_search?q=catchment`,
  `https://gis.sepa.org.uk/arcgis/rest/services?f=json`,
];
for (const url of sepaCandidates) await get("SEPA candidate", url);

console.log(`\n${c.cyan}5. NRW / DataMapWales (Wales) - water body catchments${c.reset}`);
const nrwCandidates = [
  `https://datamap.gov.wales/geoserver/ows?service=wfs&version=2.0.0&request=GetCapabilities`,
];
for (const url of nrwCandidates) await get("DataMapWales WFS GetCapabilities", url, "text/xml");

console.log(`\n${c.bold}Done. Paste this whole output back - only what actually returned real data (not a 404/empty catalogue page) is worth building on.${c.reset}\n`);
