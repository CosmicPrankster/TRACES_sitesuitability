import type { ScreeningReport } from "@/types";
import { TOOL_DEFINITIONS, createToolkit, type ToolkitState } from "./tools";

/**
 * The conversational layer.
 *
 * The AI orchestrates and explains; it never computes. It is given the
 * deterministic tools in `lib/tools.ts` and told, firmly, that any number it
 * states must have come out of one of them.
 *
 * Two providers are supported and called over plain `fetch`, so no vendor SDK
 * is a dependency. If neither key is set the application still works: the
 * deterministic report is produced and the chat panel explains that it is
 * unconfigured.
 *
 * SECURITY: server-only. API keys are read from the environment inside the
 * Next.js server runtime and never reach the browser.
 */

export type AiProvider = "anthropic" | "openai";

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  model: string;
}

export function getAiConfig(): AiConfig | undefined {
  const forced = process.env.AI_PROVIDER?.trim().toLowerCase();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();

  const wantAnthropic = forced === "anthropic" || (!forced && !!anthropicKey);
  const wantOpenai = forced === "openai" || (!forced && !anthropicKey && !!openaiKey);

  if (wantAnthropic && anthropicKey) {
    return {
      provider: "anthropic",
      apiKey: anthropicKey,
      model: process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-5",
    };
  }
  if (wantOpenai && openaiKey) {
    return {
      provider: "openai",
      apiKey: openaiKey,
      model: process.env.OPENAI_MODEL?.trim() || "gpt-4o",
    };
  }
  return undefined;
}

export function isAiConfigured(): boolean {
  return getAiConfig() !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Transcript                                                                  */
/* -------------------------------------------------------------------------- */

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
}

export interface AgentTurn {
  role: "user" | "assistant";
  text?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

/** What the UI keeps between requests. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/* -------------------------------------------------------------------------- */
/* System prompt                                                               */
/* -------------------------------------------------------------------------- */

export function buildSystemPrompt(report: ScreeningReport): string {
  return `You are the reasoning layer of an engineering screening tool that decides whether
hydrocyclone pre-treatment upstream of a membrane is worth investigating at a given site.

The user is not a process engineer. They gave you a place name and little else. Your job is
to do the heavy lifting and explain the result in plain language, without asking them to
supply engineering parameters.

## The one rule that matters most

You do not calculate. The application does. Every number you state must have come out of a
tool call in this conversation. If you want to know what happens under a different
assumption, call update_scenario and re-run the matrix - do not reason your way to a new
answer. If a tool has not given you a number, you do not have it.

Never fabricate: hydrocyclone performance, site measurements, efficiencies, throughput
gains, or sources. Never say something like "94 % probability of success" or "+43 %
filterable volume" unless a tool returned a measured figure. Say "Promising, confidence
medium" and explain why instead.

## Never conflate these two things

  - A membrane pore size is a RETENTION rating: what the membrane holds back.
  - A hydrocyclone cut size (d50) is a SEPARATION characteristic: the size at which half the
    mass reports to the underflow, with a gradual curve either side.

A 5 µm membrane does not imply the cyclone removes everything above 5 µm. Keep these
separate in every explanation.

## Label your epistemic status

Distinguish, explicitly, in this order:
  Known -> Published/sourced -> Calculated -> Inference -> Assumption -> Conclusion.
When you state an assumption, say it is one. When the assessment rests on a placeholder,
say so plainly rather than burying it.

## Be proactive, not interrogative

Do not ask the user a list of questions before helping them. Give the best assessment the
current evidence supports, then name the ONE unknown that would most improve confidence and
invite them to supply it conversationally. If they give you a PSD, a solids description, or
a required volume, call update_scenario and re-run, then explain what actually changed -
including "nothing changed", if the tool says the cells did not move.

## Style

Plain language, short paragraphs, no bullet-point soup. Explain WHY a configuration is or
is not attractive - "no" on its own is never an acceptable answer. Be direct about weak
evidence; the user is better served by an honest low-confidence answer than a confident
invented one.

## Current assessment state

Site: ${report.siteQuery}${report.siteData.resolvedName ? ` (resolved: ${report.siteData.resolvedName})` : ""}
Overall: ${report.overall.userLabel} - confidence ${report.overall.confidence}
Useful window: ${report.usefulWindow.statement}
Hydrocyclones in catalogue: ${report.hydrocyclones.map((h) => h.name).join(", ") || "none"}
Membrane ratings screened: ${report.membranes.map((m) => m.label).join(", ")}
PSD in use: ${report.psdSource?.label ?? "none"} (${report.psdSource?.provenance ?? "n/a"}${
    report.psdSource?.verified ? ", verified" : ", NOT verified"
  })
Active warnings: ${report.warnings.length ? report.warnings.join(" | ") : "none"}

Call the tools to get detail. Do not restate this block back to the user verbatim.`;
}

/* -------------------------------------------------------------------------- */
/* Provider adapters                                                           */
/* -------------------------------------------------------------------------- */

const MAX_TOOL_ROUNDS = 6;

interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
}

async function callAnthropic(
  cfg: AiConfig,
  system: string,
  turns: AgentTurn[],
): Promise<ProviderResponse> {
  const messages = turns.map((t) => {
    if (t.toolResults?.length) {
      return {
        role: "user" as const,
        content: t.toolResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.output,
        })),
      };
    }
    if (t.toolCalls?.length) {
      return {
        role: "assistant" as const,
        content: [
          ...(t.text ? [{ type: "text" as const, text: t.text }] : []),
          ...t.toolCalls.map((c) => ({
            type: "tool_use" as const,
            id: c.id,
            name: c.name,
            input: c.input,
          })),
        ],
      };
    }
    return { role: t.role, content: t.text ?? "" };
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 2000,
      system,
      messages,
      tools: TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as {
    content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
  };

  const text = (body.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();

  const toolCalls = (body.content ?? [])
    .filter((c) => c.type === "tool_use")
    .map((c) => ({ id: c.id ?? "", name: c.name ?? "", input: c.input ?? {} }));

  return { text, toolCalls };
}

async function callOpenAi(
  cfg: AiConfig,
  system: string,
  turns: AgentTurn[],
): Promise<ProviderResponse> {
  const messages: Record<string, unknown>[] = [{ role: "system", content: system }];

  for (const t of turns) {
    if (t.toolResults?.length) {
      for (const r of t.toolResults) {
        messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
      }
      continue;
    }
    if (t.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: t.text || null,
        tool_calls: t.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      });
      continue;
    }
    messages.push({ role: t.role, content: t.text ?? "" });
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      tools: TOOL_DEFINITIONS.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: "auto",
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
    }[];
  };

  const msg = body.choices?.[0]?.message;
  const toolCalls = (msg?.tool_calls ?? []).map((c) => {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      input = {};
    }
    return { id: c.id, name: c.function.name, input };
  });

  return { text: (msg?.content ?? "").trim(), toolCalls };
}

/* -------------------------------------------------------------------------- */
/* Agent loop                                                                  */
/* -------------------------------------------------------------------------- */

export interface RunAgentOptions {
  history: ChatMessage[];
  userMessage: string;
  state: ToolkitState;
  /** Injectable for tests, so no real API is needed. */
  callProvider?: (cfg: AiConfig, system: string, turns: AgentTurn[]) => Promise<ProviderResponse>;
  config?: AiConfig;
}

export interface RunAgentResult {
  reply: string;
  state: ToolkitState;
  toolsUsed: string[];
  error?: string;
}

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const cfg = options.config ?? getAiConfig();
  if (!cfg) {
    return {
      reply:
        "The conversational layer is not configured, so I cannot answer follow-up questions " +
        "here. The screening report above was produced entirely by the deterministic engine " +
        "and is complete on its own. To enable chat, set ANTHROPIC_API_KEY or OPENAI_API_KEY " +
        "in the server environment (see .env.example) and restart.",
      state: options.state,
      toolsUsed: [],
      error: "ai_not_configured",
    };
  }

  const toolkit = createToolkit(options.state);
  const system = buildSystemPrompt(options.state.report);
  const call =
    options.callProvider ?? (cfg.provider === "anthropic" ? callAnthropic : callOpenAi);

  const turns: AgentTurn[] = [
    ...options.history.map((m) => ({ role: m.role, text: m.content })),
    { role: "user" as const, text: options.userMessage },
  ];

  const toolsUsed: string[] = [];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await call(cfg, system, turns);

      if (response.toolCalls.length === 0) {
        return {
          reply:
            response.text ||
            "I did not produce an answer for that. Try rephrasing, or ask about a specific " +
              "hydrocyclone or membrane rating.",
          state: toolkit.state,
          toolsUsed,
        };
      }

      turns.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls });

      const results: ToolResult[] = response.toolCalls.map((c) => {
        toolsUsed.push(c.name);
        let output: string;
        try {
          output = JSON.stringify(toolkit.execute(c.name, c.input));
        } catch (err) {
          output = JSON.stringify({
            error: `Tool "${c.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return { id: c.id, name: c.name, output };
      });

      turns.push({ role: "user", toolResults: results });
    }

    return {
      reply:
        "I ran out of tool-calling rounds before reaching an answer. Please ask a narrower " +
        "question - for example about one hydrocyclone, or one membrane rating.",
      state: toolkit.state,
      toolsUsed,
      error: "max_rounds",
    };
  } catch (err) {
    return {
      reply:
        "The AI provider could not be reached, so I cannot answer that right now. The " +
        "screening report itself is unaffected - it is produced by the deterministic engine " +
        "and does not depend on the AI.",
      state: toolkit.state,
      toolsUsed,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
