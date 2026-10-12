import { NextResponse } from "next/server";
import { loadHydrocyclones, loadMembranes, loadTrials } from "@/lib/data";
import { assessSite } from "@/lib/assessment";
import { buildReport } from "@/lib/report";
import { psdFromFieldObservation, type FieldObservationInput } from "@/lib/field-update";

export const dynamic = "force-dynamic";

/**
 * The on-site field-update path (rebuild phase 7): a technician standing
 * at the site submits what they actually saw (grain card / settle test /
 * turbidity tube), and this recomputes the report against a REAL field
 * PSD instead of the desk-based guess - deterministically, no LLM in the
 * scoring path (see lib/field-update.ts's header for the full reasoning).
 *
 * Stateless, like /api/resolve and /api/screen: takes the structured
 * observation, returns a fresh assessment and report for THIS session.
 * Nothing is written back to data/field-observations.json automatically -
 * that stays a deliberate, human-reviewed edit, not a side effect of a web
 * request.
 */
export async function POST(request: Request) {
  let input: FieldObservationInput;
  try {
    input = (await request.json()) as FieldObservationInput;
  } catch {
    return NextResponse.json({ ok: false, stage: "input", message: "Malformed request body." }, { status: 400 });
  }

  const field = psdFromFieldObservation(input);
  if (!field) {
    return NextResponse.json(
      {
        ok: false,
        stage: "no-size-evidence",
        message: "No grain-card class was given, so there is nothing size-relevant to recompute from - a turbidity reading or a site note alone has no particle-size shape to give.",
      },
      { status: 200 },
    );
  }

  const hydrocyclones = loadHydrocyclones();
  const membranes = loadMembranes();
  const trials = loadTrials();
  const assessments = assessSite(field.psd, membranes, hydrocyclones, trials);
  const report = buildReport(field.psd, assessments, membranes);

  return NextResponse.json({
    ok: true,
    psd: field.psd,
    fieldReasoning: field.reasoning,
    additionalContext: field.additionalContext,
    assessments,
    report,
  });
}
