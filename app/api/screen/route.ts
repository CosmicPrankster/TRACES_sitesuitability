import { NextResponse } from "next/server";
import { loadHydrocyclones, loadMembranes } from "@/lib/data";
import { psdForCharacter } from "@/lib/psd";
import { assessMatrix } from "@/lib/assessment";
import { buildReport } from "@/lib/report";
import { screenStation, screenPointGeology } from "@/lib/live-site";
import type { NrfaStation } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Step 2 of the site input flow: screen a match the user has already
 * CONFIRMED (via /api/resolve's candidates). Never called with an
 * unconfirmed match - see lib/live-site.ts.
 *
 * Two modes, both requiring explicit user confirmation first:
 *   (default)          a specific NRFA station, chosen from the candidate list.
 *   mode=geology-only  none of the candidates were the intended site (or
 *                       there were none within range) - user opted to read
 *                       geology straight from the point already geocoded.
 *                       This is decideResolution's "none" message ("or say
 *                       so and the geology will be read straight from the
 *                       map") made reachable when there WAS a candidate
 *                       list to reject, not just when there was none.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const easting = Number(params.get("easting"));
  const northing = Number(params.get("northing"));

  if (params.get("mode") === "geology-only") {
    if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
      return NextResponse.json(
        { ok: false, stage: "input", message: "Missing or invalid coordinates for the geology-only fallback." },
        { status: 400 },
      );
    }

    const pointGeology = await screenPointGeology(easting, northing);
    if (!pointGeology.ok) {
      return NextResponse.json(pointGeology, { status: 200 });
    }

    const hydrocyclones = loadHydrocyclones();
    const membranes = loadMembranes();
    const psd = psdForCharacter(pointGeology.characterInference.character);
    const matrix = assessMatrix(psd, hydrocyclones, membranes);
    const report = buildReport(psd, matrix, hydrocyclones, membranes);

    return NextResponse.json({
      ok: true,
      source: "geology-only",
      geocode: {
        displayName: params.get("displayName") ?? `${easting}E ${northing}N`,
        matchedOn: params.get("matchedOn") ?? "",
      },
      geologyStatement: pointGeology.geologyStatement,
      characterInference: pointGeology.characterInference,
      psd,
      matrix,
      report,
    });
  }

  const id = Number(params.get("id"));
  const name = params.get("name");
  const river = params.get("river") ?? "";
  const catchmentArea = params.get("catchmentArea");

  if (!id || !name || !Number.isFinite(easting) || !Number.isFinite(northing)) {
    return NextResponse.json(
      { ok: false, stage: "input", message: "Missing or invalid confirmed station details." },
      { status: 400 },
    );
  }

  const station: NrfaStation = {
    id,
    name,
    river,
    easting,
    northing,
    "catchment-area": catchmentArea ? Number(catchmentArea) : undefined,
  };

  const screened = await screenStation(station);
  if (!screened.ok) {
    return NextResponse.json(screened, { status: 200 });
  }

  const hydrocyclones = loadHydrocyclones();
  const membranes = loadMembranes();
  const psd = psdForCharacter(screened.characterInference.character);
  const matrix = assessMatrix(psd, hydrocyclones, membranes);
  const report = buildReport(psd, matrix, hydrocyclones, membranes);

  return NextResponse.json({
    ok: true,
    station: screened.station,
    geologyStatement: screened.geologyStatement,
    characterInference: screened.characterInference,
    psd,
    matrix,
    report,
  });
}
