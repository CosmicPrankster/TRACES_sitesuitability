import { NextResponse } from "next/server";
import { matchSite, screenPointGeology } from "@/lib/live-site";
import { loadHydrocyclones, loadMembranes, loadTrials } from "@/lib/data";
import { psdForCharacter } from "@/lib/psd";
import { assessSite } from "@/lib/assessment";
import { buildReport } from "@/lib/report";

export const dynamic = "force-dynamic";

/**
 * Step 1 of the site input flow: propose a match, commit to nothing - UNLESS
 * there is no NRFA gauge to choose between at all (resolution.confidence
 * "none"). That case needs no confirmation, per decideResolution's own
 * needsConfirmation: false: there is no candidate to pick, only whether BGS
 * has geology mapped at the point already geocoded. So it is screened right
 * here, returning a self-contained result the client can render directly -
 * this is the fallback resolve.ts's own message promises and that was
 * missing until now.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim();
  if (!query) {
    return NextResponse.json({ ok: false, stage: "input", message: "Enter a site and waterbody." }, { status: 400 });
  }

  const matched = await matchSite(query);
  if (!matched.ok) {
    return NextResponse.json(matched);
  }

  if (matched.resolution.confidence !== "none") {
    return NextResponse.json(matched);
  }

  const pointGeology = await screenPointGeology(matched.bng.easting, matched.bng.northing);
  if (!pointGeology.ok) {
    return NextResponse.json({
      ok: false,
      stage: "no-match",
      message: `${matched.resolution.statement} ${pointGeology.message}`,
    });
  }

  const hydrocyclones = loadHydrocyclones();
  const membranes = loadMembranes();
  const trials = loadTrials();
  const psd = psdForCharacter(pointGeology.characterInference.character);
  const assessments = assessSite(psd, membranes, hydrocyclones, trials, pointGeology.siteConcentration);
  const report = buildReport(psd, assessments, membranes);

  return NextResponse.json({
    ok: true,
    source: "geology-only",
    geocode: matched.geocode,
    geologyStatement: pointGeology.geologyStatement,
    siteConcentration: pointGeology.siteConcentration ?? null,
    flags: pointGeology.flags,
    characterInference: pointGeology.characterInference,
    psd,
    assessments,
    report,
  });
}
