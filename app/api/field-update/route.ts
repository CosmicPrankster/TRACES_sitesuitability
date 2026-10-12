import { NextResponse } from "next/server";
import { loadHydrocyclones, loadMembranes, loadTrials } from "@/lib/data";
import { assessSite } from "@/lib/assessment";
import { buildReport } from "@/lib/report";
import { psdFromFieldObservation, type FieldObservationInput } from "@/lib/field-update";
import { parseFreeTextObservation } from "@/lib/chat-intake";

export const dynamic = "force-dynamic";

/**
 * The on-site field-update path (rebuild phase 7): a technician standing
 * at the site submits what they actually saw (grain card / settle test /
 * turbidity tube), and this recomputes the report against a REAL field
 * PSD instead of the desk-based guess - deterministically, no LLM in the
 * scoring path (see lib/field-update.ts's header for the full reasoning).
 *
 * Two request shapes, both ending at the exact same structured fields:
 *   { grainCardClass, settleTest, turbidityTubeReadingCm, siteNote }
 *       the structured form, posted directly - unchanged since phase 7.
 *   { message: "looks like fine sand, cleared within 10 minutes" }
 *       the chat/conversational layer (rebuild phase 9, lib/chat-intake.ts):
 *       free text, PARSED into the same structured fields above - it never
 *       computes a PSD or a verdict itself, same AI-explains-never-scores
 *       rule the whole project holds to. `parsedFrom`/`warnings` are
 *       returned alongside the result so a bad or partial parse is visible,
 *       not silent.
 *
 * Stateless, like /api/resolve and /api/screen: takes the observation,
 * returns a fresh assessment and report for THIS session. Nothing is
 * written back to data/field-observations.json automatically - that stays
 * a deliberate, human-reviewed edit, not a side effect of a web request.
 */
export async function POST(request: Request) {
  let body: { message?: unknown } & Partial<FieldObservationInput>;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, stage: "input", message: "Malformed request body." }, { status: 400 });
  }

  let input: FieldObservationInput;
  let chatIntake: { parsedFrom: string[]; warnings: string[] } | null = null;
  if (typeof body.message === "string" && body.message.trim()) {
    const parsed = parseFreeTextObservation(body.message);
    input = parsed.input;
    chatIntake = { parsedFrom: parsed.parsedFrom, warnings: parsed.warnings };
  } else {
    input = body as FieldObservationInput;
  }

  const field = psdFromFieldObservation(input);
  if (!field) {
    return NextResponse.json(
      {
        ok: false,
        stage: "no-size-evidence",
        message: "No grain-card class was given, so there is nothing size-relevant to recompute from - a turbidity reading or a site note alone has no particle-size shape to give.",
        chatIntake,
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
    chatIntake,
  });
}
