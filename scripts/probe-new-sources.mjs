#!/usr/bin/env node
/**
 * NEW-SOURCES PROBE (rebuild phase 0)
 * ====================================
 *
 * Five candidate sources for the rebuilt input hierarchy, probed the same
 * way every existing source in this project was: try it live on a real
 * site, keep only what actually responds with data. Nothing here is built
 * on until this script proves it live - see HANDOFF.md rule 1.
 *
 * One of these (EA Water Quality Archive) was already tried once and
 * failed - scripts/probe.mjs's header: "5 URL forms, all 404/403, API
 * moved or withdrawn". This run tries a different, more modern form of
 * that API (the environment.data.gov.uk linked-data endpoints) - it is a
 * genuine re-probe, not a retry of the same guess.
 *
 * Two sources (tide, satellite turbidity) need a real API key. Point the
 * matching env var at it and this script picks it up automatically - see
 * .env.local.example for what each one is and where to get it. Missing a
 * key is reported as SKIPPED, not FAIL: that is a different outcome from
 * "we tried and it didn't work".
 *
 *   node --env-file=.env.local scripts/probe-new-sources.mjs
 *   node --env-file=.env.local scripts/probe-new-sources.mjs 54.9783 -1.6174   # custom lat lon
 */

import { writeFile, mkdir } from "node:fs/promises";

const TIMEOUT_MS = 30000;
const UA = process.env.SITE_DATA_USER_AGENT ||
  "traces-site-suitability-probe/0.1 (research prototype; set SITE_DATA_USER_AGENT)";

// Tilford, River Wey - the project's standing reference site, already
// proven against NRFA/BGS by scripts/probe.mjs. Pass lat lon on the command
// line to probe somewhere else (an estuary, for the tide/satellite checks).
const [argLat, argLon] = process.argv.slice(2).map(Number);
const lat = Number.isFinite(argLat) ? argLat : 51.154565;
const lon = Number.isFinite(argLon) ? argLon : -0.791587;

const c = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
            green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m" };
const results = [];

async function get(name, url, { accept = "application/json", headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: accept, "User-Agent": UA, ...headers } });
    const text = await res.text();
    const ms = Date.now() - started;
    let body = text;
    if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
      try { body = JSON.parse(text); } catch { /* keep text */ }
    }
    const entry = { name, url, outcome: res.ok ? "ok" : "fail", httpStatus: res.status, ms, bytes: text.length, body };
    results.push(entry);
    console.log(`  ${res.ok ? c.green + "ok  " : c.red + "FAIL"}${c.reset} ${name} ${c.dim}${res.status}, ${ms} ms, ${text.length} b${c.reset}`);
    return res.ok ? body : null;
  } catch (err) {
    results.push({ name, url, outcome: "fail", error: err.message });
    console.log(`  ${c.red}FAIL${c.reset} ${name} ${c.dim}${err.message}${c.reset}`);
    return null;
  } finally { clearTimeout(timer); }
}

function skip(name, reason) {
  results.push({ name, outcome: "skipped", reason });
  console.log(`  ${c.yellow}skip${c.reset} ${name} ${c.dim}${reason}${c.reset}`);
}

console.log(`\n${c.bold}Probing new sources (rebuild phase 0) at:${c.reset} ${lat}, ${lon}\n`);

/* ---- 1. Soil texture: Soilscapes (Cranfield LandIS) + UKSO -------------- */
// Cranfield publish Soilscapes as a WMS (soil type / texture classes); BGS's
// UK Soil Observatory (UKSO) separately hosts soil property WMS layers.
// Exact current service paths are not verified from training knowledge -
// both are tried via WMS GetCapabilities, the same "ask the service what it
// actually serves" approach proven out for BGS in scripts/probe.mjs, rather
// than guessing a GetFeatureInfo layer name blind.
console.log(`${c.cyan}1. Soil texture (Soilscapes / UKSO)${c.reset}`);
await get("Soilscapes WMS GetCapabilities",
  "https://www.landis.org.uk/webservices/soilscapes_wms.cfm?REQUEST=GetCapabilities&SERVICE=WMS&VERSION=1.3.0",
  { accept: "text/xml" });
await get("UKSO WMS GetCapabilities",
  "https://www.ukso.org/geoserver/wms?REQUEST=GetCapabilities&SERVICE=WMS&VERSION=1.3.0",
  { accept: "text/xml" });
console.log();

/* ---- 2. EA Water Quality Archive - RE-PROBE with the modern linked-data API */
// scripts/probe.mjs already tried 5 forms of this and got 404/403 on all of
// them (see its header). This tries the current environment.data.gov.uk
// linked-data API instead, which is a different, newer surface than
// whatever the original 5 forms hit.
console.log(`${c.cyan}2. EA Water Quality Archive (re-probe, modern API)${c.reset}`);
const wqPoints = await get("sampling points near site",
  `https://environment.data.gov.uk/water-quality/id/sampling-points?lat=${lat}&long=${lon}&dist=10&_limit=5`);
if (wqPoints?.items?.length) {
  const p = wqPoints.items[0];
  console.log(`     ${c.dim}nearest: ${p.label ?? "?"} - fields: ${Object.keys(p).join(", ")}${c.reset}`);
  const notation = p.notation;
  if (notation) {
    await get("measurements at nearest point",
      `https://environment.data.gov.uk/water-quality/data/measurement?samplingPoint=${notation}&determinand=9901&_limit=5`);
  }
} else {
  console.log(`     ${c.yellow}none within 10 km, or the endpoint shape has changed${c.reset}`);
}
console.log();

/* ---- 3. UKCEH Land Cover Map - arable % --------------------------------- */
console.log(`${c.cyan}3. UKCEH Land Cover Map${c.reset}`);
await get("UKCEH LCM WMS GetCapabilities",
  "https://catalogue.ceh.ac.uk/maps/wms?REQUEST=GetCapabilities&SERVICE=WMS&VERSION=1.3.0",
  { accept: "text/xml" });
console.log();

/* ---- 4. Tide state (estuaries) - needs a real API key ------------------- */
// developer.admiralty.co.uk's "UK Tidal API" product, Azure API Management
// hosted - not the same base URL as the separate EasyTide product this
// probe originally guessed at.
console.log(`${c.cyan}4. Tide state (Admiralty UK Tidal API)${c.reset}`);
const tideKey = process.env.ADMIRALTY_TIDE_API_KEY;
if (!tideKey) {
  skip("UK Tidal API station search", "ADMIRALTY_TIDE_API_KEY not set - see .env.local.example");
} else {
  const stations = await get("nearest tide stations",
    `https://admiraltyapi.azure-api.net/uktidalapi/api/V1/Stations?lat=${lat}&long=${lon}`,
    { headers: { "Ocp-Apim-Subscription-Key": tideKey } });
  if (Array.isArray(stations) && stations.length) {
    const id = stations[0].Id ?? stations[0].id;
    console.log(`     ${c.dim}nearest: ${stations[0].Name ?? "?"} (${id})${c.reset}`);
    if (id) {
      await get("station tidal events (GetStation)",
        `https://admiraltyapi.azure-api.net/uktidalapi/api/V1/Stations/${id}/TidalEvents`,
        { headers: { "Ocp-Apim-Subscription-Key": tideKey } });
    }
  }
}
console.log();

/* ---- 5. Satellite turbidity (Sentinel-2/3) - needs real credentials ----- */
console.log(`${c.cyan}5. Satellite turbidity (Copernicus Data Space)${c.reset}`);
const chId = process.env.COPERNICUS_CLIENT_ID;
const chSecret = process.env.COPERNICUS_CLIENT_SECRET;
if (!chId || !chSecret) {
  skip("OAuth2 token request", "COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET not set - see .env.local.example");
} else {
  const tokenRes = await fetch("https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: chId, client_secret: chSecret }),
  }).catch((err) => ({ ok: false, _err: err }));
  if (tokenRes.ok) {
    console.log(`  ${c.green}ok  ${c.reset} OAuth2 token request ${c.dim}credentials accepted${c.reset}`);
    results.push({ name: "Copernicus OAuth2 token", outcome: "ok" });
  } else {
    const detail = tokenRes._err?.message ?? `HTTP ${tokenRes.status}`;
    console.log(`  ${c.red}FAIL${c.reset} OAuth2 token request ${c.dim}${detail}${c.reset}`);
    results.push({ name: "Copernicus OAuth2 token", outcome: "fail", detail });
  }
}
console.log();

/* ---- report -------------------------------------------------------- */
await mkdir("probe-results", { recursive: true });
const out = `probe-results/new-sources-${lat}-${lon}.json`.replace(/[^a-z0-9.\-/]+/gi, "");
await writeFile(out, JSON.stringify({ lat, lon, probedAt: new Date().toISOString(), results }, null, 2));

const ok = results.filter((r) => r.outcome === "ok").length;
const failed = results.filter((r) => r.outcome === "fail").length;
const skipped = results.filter((r) => r.outcome === "skipped").length;
console.log(`${c.bold}SUMMARY${c.reset}  ${c.green}${ok} ok${c.reset}, ${c.red}${failed} failed${c.reset}, ${c.yellow}${skipped} skipped (no key)${c.reset}`);
console.log(`Full report: ${c.bold}${out}${c.reset}\n`);
console.log(`Paste this output (and, for anything that returned ok, the matching`);
console.log(`probe-results/*.json) back so only what's proven gets built on.\n`);
