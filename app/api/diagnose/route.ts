import { NextResponse } from "next/server";
import { getSiteData } from "@/lib/site";
import { runScreening } from "@/lib/screening";
import { isAiConfigured } from "@/lib/ai";
import { isLoggingConfigured } from "@/lib/github-log";
import type { Scenario } from "@/types";

/**
 * POST /api/diagnose
 *
 * A plain-language answer to "why is it giving me the same thing every time?".
 *
 * Runs the real lookup and reports, for every provider: whether it worked, what
 * it said, the exact URL it called, and - the part that actually matters -
 * whether it influenced the answer. Most providers cannot; only the ones that
 * determine the particle population can move a single cell.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Providers whose output can actually change the matrix. */
const CAN_INFLUENCE = new Set(["field-observations", "local-knowledge", "bgs-geology", "ea-water-quality"]);

export async function POST(request: Request) {
  let body: { site?: string };
  try {
    body = (await request.json()) as { site?: string };
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const site = body.site?.trim();
  if (!site) return NextResponse.json({ error: "Enter a site to diagnose." }, { status: 400 });

  const remoteEnabled = process.env.ENABLE_REMOTE_SITE_DATA !== "false";
  const started = Date.now();

  const siteData = await getSiteData(site, {
    enableRemote: remoteEnabled,
    timeoutMs: Number.parseInt(process.env.SITE_DATA_TIMEOUT_MS ?? "6000", 10) || 6000,
    userAgent: process.env.SITE_DATA_USER_AGENT || "traces-site-suitability",
  });

  const scenario: Scenario = { siteQuery: site, siteData, changeLog: [] };
  const report = runScreening({ scenario });

  const providers = siteData.providerReports.map((r) => ({
    id: r.providerId,
    name: r.providerName,
    status: r.status,
    message: r.message,
    url: r.sourceUrl,
    durationMs: r.durationMs,
    canInfluenceAnswer: CAN_INFLUENCE.has(r.providerId),
  }));

  /* ---- Work out the single reason, in plain language ----------------- */
  const geocode = siteData.providerReports.find((r) => r.providerId === "geocode");
  const geocodeFailed = geocode && geocode.status !== "ok";
  const influencing = providers.filter((p) => p.canInfluenceAnswer && p.status === "ok");

  let verdict: string;
  let fix: string[];

  if (!remoteEnabled) {
    verdict =
      "Remote lookups are switched OFF, so nothing was fetched. Every site will return the default.";
    fix = ["Remove ENABLE_REMOTE_SITE_DATA=false from .env.local, or set it to true, and restart."];
  } else if (geocodeFailed) {
    verdict =
      "Geocoding failed, and that is the root cause. Every other lookup needs coordinates, so " +
      "river gauges, water quality and geology were all skipped. With nothing known about the " +
      "solids, every site returns the same default matrix.";
    fix = [
      "Check this machine can reach the internet from Node (a corporate proxy or VPN will block it).",
      "Set SITE_DATA_USER_AGENT in .env.local to something identifiable with a contact address - " +
        "Nominatim rejects generic ones with HTTP 403.",
      "Try a simpler place name: a town usually resolves where a river reach does not.",
      "See the exact URL tried below - paste it into a browser. If it works there but not here, " +
        "it is a network or User-Agent problem, not a code problem.",
    ];
  } else if (influencing.length === 0) {
    verdict =
      "Geocoding worked, but no provider returned anything that determines what the suspended " +
      "solids are, which is the only thing that moves the matrix. So you get the default.";
    fix = [
      "Fastest: click one of the buttons on the report ('gritty', 'clay', and so on). One click " +
        "re-runs the whole assessment.",
      "Check the BGS geology row below. If it says the attributes were not recognised, its " +
        "message lists the keys the service actually returned - copy them into ATTRIBUTE_KEYS in " +
        "lib/providers/bgs-geology.ts.",
      "Outside England, the two Environment Agency lookups will never return anything - they are " +
        "England-only. Geology is the one that should still work.",
      "Add the site to data/sites.ts with particleCharacter set, or record a field observation " +
        "in data/field-observations.ts.",
    ];
  } else {
    verdict =
      `Working as intended. ${influencing.length} provider(s) returned data that influenced the ` +
      `assessment, and the solids character was determined as "${siteData.particleCharacter}".`;
    fix = [
      "If the result still looks wrong, the numbers to check are the placeholder cut sizes in " +
        "data/hydrocyclones.ts and the assumed distributions in lib/site.ts.",
    ];
  }

  return NextResponse.json({
    site,
    verdict,
    fix,
    rootCause: geocodeFailed ? "geocoding" : influencing.length === 0 ? "no_character_source" : "none",
    environment: {
      remoteLookupsEnabled: remoteEnabled,
      userAgent: process.env.SITE_DATA_USER_AGENT || "(not set - using the default)",
      userAgentIsDefault: !process.env.SITE_DATA_USER_AGENT,
      aiConfigured: isAiConfigured(),
      loggingConfigured: isLoggingConfigured(),
      bgsEndpoint: process.env.BGS_MAPSERVER_URL || "(default)",
    },
    resolved: {
      name: siteData.resolvedName ?? null,
      latitude: siteData.latitude ?? null,
      longitude: siteData.longitude ?? null,
    },
    outcome: {
      siteSpecific: siteData.siteSpecific,
      particleCharacter: siteData.particleCharacter,
      particleCharacterProvenance: siteData.particleCharacterProvenance,
      particleCharacterBasis: siteData.particleCharacterBasis,
      psdD50Um: report.psdStatistics?.d50Um ?? null,
      psdProvenance: report.psdStatistics?.provenance ?? null,
      matrixSignature: report.matrix.map((c) => c.symbol).join(""),
      overall: report.overall.userLabel,
      confidence: report.overall.confidence,
    },
    providers,
    totalMs: Date.now() - started,
  });
}
