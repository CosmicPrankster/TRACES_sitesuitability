import { NextResponse } from "next/server";
import { loadHydrocyclones, loadMembranes } from "@/lib/data";
import { psdForCharacter } from "@/lib/psd";
import { assessMatrix } from "@/lib/assessment";
import { buildReport } from "@/lib/report";
import { resolveSite } from "@/lib/live-site";

export const dynamic = "force-dynamic";

/**
 * Runs the live site pipeline (Nominatim -> NRFA -> BGS -> character
 * inference) and, if it succeeds, the deterministic screening (psd ->
 * assessment -> report) on top. A failure at any stage is returned as a
 * distinct reason, never silently swapped for a default character - see
 * HANDOFF.md's rule 2: "never report an empty response as a success."
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim();
  if (!query) {
    return NextResponse.json({ ok: false, stage: "input", message: "Enter a site and waterbody." }, { status: 400 });
  }

  const resolved = await resolveSite(query);
  if (!resolved.ok) {
    return NextResponse.json(resolved, { status: 200 });
  }

  const hydrocyclones = loadHydrocyclones();
  const membranes = loadMembranes();
  const psd = psdForCharacter(resolved.characterInference.character);
  const matrix = assessMatrix(psd, hydrocyclones, membranes);
  const report = buildReport(psd, matrix, hydrocyclones, membranes);

  return NextResponse.json({
    ok: true,
    geocode: resolved.geocode,
    resolution: resolved.resolution,
    station: resolved.station,
    geologyStatement: resolved.geologyStatement,
    characterInference: resolved.characterInference,
    psd,
    matrix,
    report,
  });
}
