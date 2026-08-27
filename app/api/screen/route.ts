import { NextResponse } from "next/server";
import { getSiteData } from "@/lib/site";
import { runScreening } from "@/lib/screening";
import { appendLogRow, isLoggingConfigured, reportToLogRow, type LogResult } from "@/lib/github-log";
import { isAiConfigured } from "@/lib/ai";
import type { ParticleCharacter, Scenario } from "@/types";

/**
 * POST /api/screen
 *
 * The whole product in one call: a site string in, a complete screening report
 * out. Everything else - site lookups, catalogues, the matrix - happens here.
 *
 * Runs on the server so that API keys and the GitHub token never reach the
 * browser.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ScreenRequest {
  site?: string;
  notes?: string;
  sessionId?: string;
  /** Set when the user answers the "what are the solids like?" prompt. */
  particleCharacter?: ParticleCharacter;
}

const CHARACTERS: ParticleCharacter[] = [
  "sand",
  "mixed_mineral",
  "silt",
  "clay",
  "organic",
  "unknown",
];

export async function POST(request: Request) {
  let body: ScreenRequest;
  try {
    body = (await request.json()) as ScreenRequest;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const site = body.site?.trim();
  if (!site) {
    return NextResponse.json(
      { error: "Enter a site or location to screen, for example \"Tilford, River Wey\"." },
      { status: 400 },
    );
  }
  if (site.length > 300) {
    return NextResponse.json({ error: "That site description is too long." }, { status: 400 });
  }

  const notes = body.notes?.trim().slice(0, 2000) || undefined;

  try {
    const siteData = await getSiteData(site, {
      enableRemote: process.env.ENABLE_REMOTE_SITE_DATA !== "false",
      timeoutMs: Number.parseInt(process.env.SITE_DATA_TIMEOUT_MS ?? "6000", 10) || 6000,
      userAgent: process.env.SITE_DATA_USER_AGENT || "traces-site-suitability",
      userNotes: notes,
    });

    const stated =
      body.particleCharacter && CHARACTERS.includes(body.particleCharacter)
        ? body.particleCharacter
        : undefined;

    if (stated && stated !== "unknown") {
      // The user's own answer outranks anything the application would infer.
      siteData.particleCharacter = stated;
      siteData.particleCharacterProvenance = "inferred";
      siteData.particleCharacterBasis =
        "Selected by the user when asked what the solids are like. This is their description, " +
        "not a measurement, but it outranks anything the application would otherwise infer.";
      siteData.siteSpecific = true;
    }

    const scenario: Scenario = {
      siteQuery: site,
      userNotes: notes,
      siteData,
      particleCharacterOverride: stated && stated !== "unknown" ? stated : undefined,
      changeLog: stated && stated !== "unknown" ? [`Solids character set to "${stated}" by the user.`] : [],
    };

    const report = runScreening({ scenario });

    // Logging must never break the assessment.
    let log: LogResult;
    if (!isLoggingConfigured()) {
      log = {
        ok: false,
        skipped: true,
        message: "Logging to GitHub is not configured, so this assessment was not recorded.",
      };
    } else {
      log = await appendLogRow(
        reportToLogRow(report, { sessionId: body.sessionId ?? "anonymous" }),
      );
    }

    return NextResponse.json({
      report,
      log,
      aiAvailable: isAiConfigured(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          "The screening could not be completed: " +
          (err instanceof Error ? err.message : String(err)),
      },
      { status: 500 },
    );
  }
}
