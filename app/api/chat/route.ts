import { NextResponse } from "next/server";
import { runAgent, isAiConfigured, type ChatMessage } from "@/lib/ai";
import { runScreening } from "@/lib/screening";
import { appendLogRow, isLoggingConfigured, reportToLogRow } from "@/lib/github-log";
import type { Scenario, ScreeningReport } from "@/types";

/**
 * POST /api/chat
 *
 * Continues the conversation about an existing scenario. The client holds the
 * scenario and the chat history and sends both back; the server re-runs the
 * deterministic engine over the scenario, lets the AI call the deterministic
 * tools, and returns the reply along with the possibly-updated scenario and
 * report.
 *
 * Keeping the scenario on the client is what makes this stateless - no database.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatRequest {
  message?: string;
  history?: ChatMessage[];
  scenario?: Scenario;
  sessionId?: string;
}

export async function POST(request: Request) {
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "Type a question first." }, { status: 400 });
  }
  if (!body.scenario?.siteData) {
    return NextResponse.json(
      { error: "Screen a site before asking questions about it." },
      { status: 400 },
    );
  }

  if (!isAiConfigured()) {
    return NextResponse.json({
      reply:
        "The conversational layer is not configured on this server, so I cannot answer " +
        "follow-up questions. The screening report is unaffected - it is produced entirely by " +
        "the deterministic engine. To enable chat, set ANTHROPIC_API_KEY or OPENAI_API_KEY " +
        "(see .env.example) and restart the server.",
      scenario: body.scenario,
      aiAvailable: false,
    });
  }

  try {
    const scenario: Scenario = { ...body.scenario, changeLog: [...(body.scenario.changeLog ?? [])] };
    const report: ScreeningReport = runScreening({ scenario });

    const result = await runAgent({
      history: (body.history ?? []).slice(-20),
      userMessage: message,
      state: { scenario, report },
    });

    // Non-blocking, non-fatal.
    if (isLoggingConfigured()) {
      void appendLogRow(
        reportToLogRow(result.state.report, {
          sessionId: body.sessionId ?? "anonymous",
          userQuestion: message,
          aiResponse: result.reply,
        }),
      ).catch(() => undefined);
    }

    return NextResponse.json({
      reply: result.reply,
      scenario: result.state.scenario,
      report: result.state.report,
      toolsUsed: result.toolsUsed,
      aiAvailable: true,
      error: result.error,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Chat failed: " + (err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
