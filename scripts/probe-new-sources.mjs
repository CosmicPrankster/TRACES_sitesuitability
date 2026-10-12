#!/usr/bin/env node
/**
 * NEW-SOURCES PROBE (rebuild phase 0)
 * ====================================
 *
 * Candidate sources for the rebuilt input hierarchy, probed the same way
 * every existing source in this project was: try it live on a real site,
 * keep only what actually responds with data. Nothing here is built on
 * until this script proves it live - see HANDOFF.md rule 1. UKCEH Land
 * Cover was dropped as a deliberate scope cut (redundant with NRFA's own
 * arable-% field), not just a failed probe - see BUILD.md.
 *
 * EA Water Quality Archive was tried once before and failed - scripts/
 * probe.mjs's header: "5 URL forms, all 404/403, API moved or withdrawn".
 * This re-probe found a real, documented OpenAPI spec at a different path
 * and is now proven against the actual endpoint/param names from that spec.
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

// A 200 status is not proof of data - this project has been bitten by that
// exact mistake before (HANDOFF.md: "never report an empty response as a
// success"). A WMS GetCapabilities request that comes back as an HTML page
// (a soft-404, or a backend error page some servers still answer with 200)
// is a FAIL, whatever the status code says. Only reject HTML when XML was
// actually asked for - a JSON endpoint returning JSON is fine.
function looksLikeDisguisedFailure(accept, text) {
  if (accept !== "text/xml") return null;
  const head = text.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    return "server returned an HTML page, not XML - likely a soft-404 or backend error despite the 200";
  }
  return null;
}

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
    const disguised = res.ok ? looksLikeDisguisedFailure(accept, text) : null;
    const outcome = res.ok && !disguised ? "ok" : "fail";
    const entry = { name, url, outcome, httpStatus: res.status, ms, bytes: text.length, body, ...(disguised ? { disguisedFailure: disguised } : {}) };
    results.push(entry);
    const label = outcome === "ok" ? c.green + "ok  " : c.red + "FAIL";
    const suffix = disguised ? ` ${c.dim}(${disguised})${c.reset}` : "";
    console.log(`  ${label}${c.reset} ${name} ${c.dim}${res.status}, ${ms} ms, ${text.length} b${c.reset}${suffix}`);
    return outcome === "ok" ? body : null;
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

/* ---- 1. Soil texture: CLOSED, dropped as a dedicated tier -------------- */
// Soilscapes (landis.org.uk): four real, independently-failing attempts,
// the last with an explicit Cranfield server error - "No Layer or Table
// was initialized" - confirming their own data layer is broken, not a
// wrong URL on this end. The one other independently-hosted candidate,
// BGS's UKSO_BGS_NSI, came back real (160 KB, 101 layers) but turned out
// to be a geochemical survey (trace elements), not texture/grain-size -
// a different question, same as COSMOS-UK answers moisture, not texture.
// The user independently confirmed Soilscapes' real-world coverage is
// thin anyway. See BUILD.md. The hierarchy falls back to NRFA+BGS
// (reframed, demoted) for this tier instead - no probe left to run here.

/* ---- 2. EA Water Quality Archive - RE-PROBE with the modern linked-data API */
// scripts/probe.mjs already tried 5 forms of this and got 404/403 on all of
// them (see its header). This tries the current environment.data.gov.uk
// linked-data API instead, which is a different, newer surface than
// whatever the original 5 forms hit.
console.log(`${c.cyan}2. EA Water Quality Archive (re-probe, modern API)${c.reset}`);
// A real, documented api-docs page exists - found by the user, not guessed.
// Hit it directly rather than assuming the linked-data guess below is still
// the right shape; this should say what (if anything) replaced it.
await get("EA water-quality api-docs page", "https://environment.data.gov.uk/water-quality/api-docs", { accept: "text/html" });
// That page's own markup references /water-quality/api/swagger directly -
// almost certainly the real OpenAPI spec endpoint (same pattern as
// COSMOS-UK's embedded spec below), found in the page content, not guessed.
// That spec confirmed the real base + path + param names, none of which
// matched the earlier guess: base is just /water-quality (no /id/ prefix),
// the path is singular "/sampling-point" (not plural "/sampling-points"),
// and the geo filter params are latitude/longitude/radius (not lat/long/dist).
const wqSwagger = await get("EA water-quality OpenAPI spec", "https://environment.data.gov.uk/water-quality/api/swagger");
// Phase 3 needs to know what this API can actually serve BEFORE guessing a
// measurement/reading endpoint - printing the real path list directly to
// the console (not just into the probe-results file) so it's visible in
// whatever gets pasted back.
if (wqSwagger?.paths && typeof wqSwagger.paths === "object") {
  console.log(`     ${c.dim}real paths in the spec:${c.reset}`);
  for (const path of Object.keys(wqSwagger.paths)) console.log(`       ${c.dim}${path}${c.reset}`);
}
// The 400 named the exact fix: this API only serves application/ld+json or
// application/geo+json, not plain application/json.
// Widened from the original 10 km/limit 5 - that search found only
// sewage-discharge/effluent points near Tilford, not ambient river
// monitoring. A wider net is more likely to turn up the type we actually
// want, rather than concluding from one unlucky radius that it doesn't
// exist nearby.
const wqPoints = await get("sampling points near site (wider radius)",
  `https://environment.data.gov.uk/water-quality/sampling-point?latitude=${lat}&longitude=${lon}&radius=25&limit=20`,
  { accept: "application/geo+json" });
// Real response shape (confirmed from an actual body, not guessed): JSON-LD
// Hydra Collection - {"type":"hydra:Collection","member":[...]} - not the
// "items" or "features" this originally assumed.
const wqItems = wqPoints?.member ?? wqPoints?.items ?? wqPoints?.features ?? [];
if (wqItems.length) {
  console.log(`     ${c.dim}${wqItems.length} point(s) within 25 km - type breakdown:${c.reset}`);
  const byType = {};
  for (const p of wqItems) {
    const t = p.properties?.type ?? p.type ?? "?";
    byType[t] = (byType[t] ?? 0) + 1;
  }
  for (const [t, n] of Object.entries(byType)) console.log(`       ${c.dim}${n}x ${t}${c.reset}`);

  // An EARLIER RUN found the real type field is properties.type, a plain
  // label string ("FRESHWATER - UNSPECIFIED" for an ordinary river/stream
  // point, as opposed to "GROUNDWATER - ..." or "SEWAGE - ..."/"TRADE
  // DISCHARGES - ..." for the others) - not a short code, and not under
  // "@id"/"id" as first guessed. Filtering on that confirmed label here,
  // client-side, rather than chasing the sampling-point-type codelist's
  // own short notation (that broad fetch 403'd from an Azure gateway last
  // run - see below - and isn't needed: this label is already proven).
  const freshwaterPoints = wqItems.filter((p) => p.properties?.type === "FRESHWATER - UNSPECIFIED");
  console.log(`     ${c.dim}${freshwaterPoints.length} of those are ordinary freshwater (river/stream) points${c.reset}`);
  for (const p of freshwaterPoints) {
    console.log(`       ${c.dim}${p.properties?.notation} - ${p.properties?.name}${c.reset}`);
  }

  // A smaller, TARGETED codelist search instead of the broad limit=200 list
  // that 403'd last run (Azure Application Gateway rejected it outright,
  // before the request even reached the API - a WAF/infra block, not a
  // validation error). This confirms the short notation code for the
  // freshwater type, in case samplingPointType-filtered queries are wanted
  // later; it is NOT required for anything below, which uses the already-
  // proven plain-label filter above instead.
  await get("sampling-point-type codelist, filtered to freshwater",
    "https://environment.data.gov.uk/water-quality/codelist/sampling-point-type?prefLabel=freshwater&limit=10",
    { accept: "application/ld+json" });

  // The determinand codelist supports the same prefLabel contains-search -
  // confirming the real codes for suspended solids and turbidity rather
  // than guessing at a notation.
  const suspendedSolids = await get("determinand codelist, filtered to suspended solids",
    "https://environment.data.gov.uk/water-quality/codelist/determinand?prefLabel=suspended%20solids&limit=10",
    { accept: "application/ld+json" });
  const turbidity = await get("determinand codelist, filtered to turbidity",
    "https://environment.data.gov.uk/water-quality/codelist/determinand?prefLabel=turbidity&limit=10",
    { accept: "application/ld+json" });

  const determinandNotation = (body) => {
    const items = body?.member ?? body?.items ?? [];
    return items[0]?.notation ?? items[0]?.id ?? null;
  };
  const ssCode = determinandNotation(suspendedSolids);
  const turbCode = determinandNotation(turbidity);
  console.log(`     ${c.dim}suspended-solids determinand code: ${ssCode ?? "not found"}${c.reset}`);
  console.log(`     ${c.dim}turbidity determinand code: ${turbCode ?? "not found"}${c.reset}`);

  // The actual payoff of this whole tier: real readings, for a real
  // ordinary-river point, for whichever determinand code was just found -
  // closing the loop on "where do the numbers live" in one run instead of
  // a third probing round, if the codelist lookups above succeeded.
  const codes = [ssCode, turbCode].filter(Boolean).join(",");
  const targetPoint = freshwaterPoints[0]?.properties?.notation;
  if (targetPoint && codes) {
    await get("real observations for a freshwater point, filtered to those determinands",
      `https://environment.data.gov.uk/water-quality/sampling-point/${targetPoint}/observation?determinand=${codes}&limit=20`,
      { accept: "application/ld+json" });
  } else if (targetPoint) {
    // Still worth seeing the shape of a real observation, unfiltered, even
    // if the determinand lookup above didn't resolve a code.
    await get("real observations for a freshwater point (unfiltered)",
      `https://environment.data.gov.uk/water-quality/sampling-point/${targetPoint}/observation?limit=10`,
      { accept: "application/ld+json" });
  } else {
    console.log(`     ${c.yellow}no freshwater point in range to fetch real observations for${c.reset}`);
  }
} else {
  console.log(`     ${c.yellow}none within 25 km either, or the endpoint shape has changed${c.reset}`);
}
console.log();

/* ---- 3. UKCEH Land Cover Map - arable % --------------------------------- */
// UKCEH Land Cover Map (arable %) dropped per the user's "if something is
// redundant we cut it" call - NRFA already supplies an arable-land-cover
// field for gauged catchments (see BUILD.md's dropped-sources table), and
// the WMS service is broken server-side anyway. COSMOS-UK is a different
// UKCEH service kept on its own merits (real-time soil moisture sensors),
// not a land-cover substitute.
console.log(`${c.cyan}3. COSMOS-UK soil moisture sensors${c.reset}`);
await get("COSMOS-UK API docs", "https://cosmos-api.ceh.ac.uk/docs", { accept: "text/html" });
// The spec embedded in that docs page (extracted directly, not guessed)
// confirmed a real OGC EDR-style API at this base, with a /collections path.
// List what's actually monitored - keyless, per the spec's security section.
await get("COSMOS-UK collections list", "https://cosmos-api.ceh.ac.uk/collections");
// That list confirmed two real collections: "30M" (30-minute) and "1D"
// (daily) site-specific data - not guessed, read from the actual response.
// Querying the daily collection's radius search near the test site, per the
// /collections/<id>/radius path the embedded spec documented (OGC EDR-style
// coords=POINT(lon lat) WKT). The 400 named the real options: f=json isn't
// one of them - coveragejson or csv are. csv is easiest to eyeball here.
await get("COSMOS-UK daily collection, nearby sites",
  `https://cosmos-api.ceh.ac.uk/collections/1D/radius?coords=POINT(${lon} ${lat})&within=50&within-units=km&f=csv`,
  { accept: "text/csv" });
console.log();

/* ---- 4. Tide state (estuaries) - needs a real API key ------------------- */
// developer.admiralty.co.uk's "UK Tidal API" (Discovery tier), confirmed
// against its real OpenAPI spec: base https://admiraltyapi.azure-api.net/uktidalapi.
// GET /api/V1/Stations has NO lat/long filter in this tier - only an
// optional `name` query param - so the nearest station has to be found by
// fetching the full ~607-station GeoJSON FeatureCollection and computing
// distance client-side, the same pattern lib/resolve.ts already uses for
// NRFA. CORRECTED against a real response: the spec's prose claims
// "the tidal station number is used as the GeoJSON feature Id", but the
// live API actually puts it at feature.properties.Id (e.g. "0068B" for
// Bosham), not feature.id - the spec text was wrong, not the code.
console.log(`${c.cyan}4. Tide state (Admiralty UK Tidal API)${c.reset}`);
const tideKey = process.env.ADMIRALTY_TIDE_API_KEY;
if (!tideKey) {
  skip("UK Tidal API station search", "ADMIRALTY_TIDE_API_KEY not set - see .env.local.example");
} else {
  const tideBase = "https://admiraltyapi.azure-api.net/uktidalapi";
  const tideHeaders = { headers: { "Ocp-Apim-Subscription-Key": tideKey } };
  const stationsFc = await get("all tidal stations", `${tideBase}/api/V1/Stations`, tideHeaders);
  const features = stationsFc?.features;
  if (Array.isArray(features) && features.length) {
    const haversineKm = (lat1, lon1, lat2, lon2) => {
      const R = 6371, toRad = (d) => (d * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };
    let nearest = null;
    for (const f of features) {
      const [flon, flat] = f.geometry?.coordinates ?? [];
      if (!Number.isFinite(flat) || !Number.isFinite(flon)) continue;
      const d = haversineKm(lat, lon, flat, flon);
      if (!nearest || d < nearest.d) nearest = { d, f };
    }
    if (nearest) {
      const id = nearest.f.properties?.Id;
      const name = nearest.f.properties?.Name ?? "?";
      console.log(`     ${c.dim}nearest: ${name} (${id}), ${nearest.d.toFixed(1)} km${c.reset}`);
      await get("tidal events for nearest station",
        `${tideBase}/api/V1/Stations/${id}/TidalEvents?duration=7`, tideHeaders);
    } else {
      console.log(`     ${c.yellow}got a station list but no feature had usable coordinates${c.reset}`);
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
