import { describe, expect, it } from "vitest";
import { buildSystemPrompt, runAgent, type AgentTurn, type AiConfig } from "@/lib/ai";
import { createToolkit, TOOL_DEFINITIONS } from "@/lib/tools";
import { runScreening } from "@/lib/screening";
import { getSiteData } from "@/lib/site";
import type { Scenario, ScreeningReport } from "@/types";

const SITE = "Tilford, River Wey";
const CFG: AiConfig = { provider: "anthropic", apiKey: "test", model: "test-model" };

async function makeState(): Promise<{ scenario: Scenario; report: ScreeningReport }> {
  const siteData = await getSiteData(SITE, { enableRemote: false });
  const scenario: Scenario = { siteQuery: SITE, siteData, changeLog: [] };
  return { scenario, report: runScreening({ scenario }) };
}

/** A scripted provider: no network, no API key, fully deterministic. */
function scriptedProvider(script: { text: string; toolCalls: { id: string; name: string; input: Record<string, unknown> }[] }[]) {
  let i = 0;
  const seen: AgentTurn[][] = [];
  const fn = async (_cfg: AiConfig, _system: string, turns: AgentTurn[]) => {
    seen.push([...turns]);
    return script[Math.min(i++, script.length - 1)];
  };
  return { fn, seen, get calls() { return i; } };
}

describe("tool definitions", () => {
  it("exposes the deterministic functions the specification names", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_site_data",
        "get_hydrocyclones",
        "get_membrane_options",
        "analyse_psd",
        "run_configuration_matrix",
        "compare_configurations",
        "summarise_results",
        "update_scenario",
      ]),
    );
    for (const t of TOOL_DEFINITIONS) {
      expect(t.parameters.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(40);
    }
  });
});

describe("toolkit executes deterministically", () => {
  it("returns the catalogue with its verification status exposed", async () => {
    const toolkit = createToolkit(await makeState());
    const units = toolkit.execute("get_hydrocyclones", {}) as Record<string, unknown>[];
    expect(units.length).toBeGreaterThanOrEqual(2);
    for (const u of units) {
      expect(u.cut_size_verified).toBe(false);
      expect(u.data_complete).toBe(false);
    }
  });

  it("refuses to analyse a PSD it was not given", async () => {
    const toolkit = createToolkit(await makeState());
    const res = toolkit.execute("analyse_psd", {}) as { error?: string };
    expect(res.error).toMatch(/required/i);
    expect(res.error).toMatch(/Do not invent/i);
  });

  it("analyses a supplied PSD without changing the scenario", async () => {
    const state = await makeState();
    const toolkit = createToolkit(state);
    const before = state.report.psdSource?.provenance;
    const res = toolkit.execute("analyse_psd", { d10_um: 2, d50_um: 25, d90_um: 150 }) as {
      statistics: { d50Um: number };
      note: string;
    };
    expect(res.statistics.d50Um).toBeCloseTo(25, 3);
    expect(res.note).toMatch(/NOT changed the scenario/i);
    expect(toolkit.state.report.psdSource?.provenance).toBe(before);
  });

  it("update_scenario re-runs the matrix and reports what actually moved", async () => {
    const toolkit = createToolkit(await makeState());
    const res = toolkit.execute("update_scenario", {
      psd_from_text: "D10 2 um, D50 25 um, D90 150 um",
      reason: "user supplied a site PSD",
    }) as { changed: boolean; cells_that_changed: unknown[]; new_overall: { confidence: string } };

    expect(res.changed).toBe(true);
    expect(toolkit.state.report.psdSource?.provenance).toBe("measured");
    expect(toolkit.state.scenario.changeLog.join(" ")).toMatch(/user supplied a site PSD/);
    expect(Array.isArray(res.cells_that_changed)).toBe(true);
  });

  it("update_scenario is honest when nothing moved", async () => {
    const toolkit = createToolkit(await makeState());
    const res = toolkit.execute("update_scenario", {}) as { changed: boolean; note: string };
    expect(res.changed).toBe(false);
    expect(res.note).toMatch(/nothing changed/i);
  });

  it("changing the solids character to clay re-runs and worsens the outlook", async () => {
    const toolkit = createToolkit(await makeState());
    const before = toolkit.state.report.matrix.find(
      (c) => c.hydrocycloneId === "10mm" && c.membraneId === "10um",
    )!.metrics.foulingReliefFraction!;

    toolkit.execute("update_scenario", { particle_character: "clay", reason: "user says clay" });

    const after = toolkit.state.report.matrix.find(
      (c) => c.hydrocycloneId === "10mm" && c.membraneId === "10um",
    )!.metrics.foulingReliefFraction!;
    expect(after).toBeLessThan(before);
  });

  it("compare_configurations flags when a difference is only a placeholder artefact", async () => {
    const toolkit = createToolkit(await makeState());
    const res = toolkit.execute("compare_configurations", { hydrocyclone_ids: ["4mm", "10mm"] }) as {
      comparison: { hydrocycloneId: string }[];
      note: string;
    };
    expect(res.comparison.map((c) => c.hydrocycloneId)).toEqual(["4mm", "10mm"]);
    expect(res.note).toMatch(/placeholder/i);
  });

  it("rejects an unknown tool instead of silently doing nothing", async () => {
    const toolkit = createToolkit(await makeState());
    expect((toolkit.execute("does_not_exist", {}) as { error: string }).error).toMatch(/Unknown tool/);
  });
});

describe("agent loop", () => {
  it("runs tools, then answers, without touching a real API", async () => {
    const provider = scriptedProvider([
      { text: "", toolCalls: [{ id: "t1", name: "summarise_results", input: {} }] },
      { text: "The 10 mm looks strongest above 20 µm, at low confidence.", toolCalls: [] },
    ]);

    const result = await runAgent({
      history: [],
      userMessage: "Which configuration would you test first?",
      state: await makeState(),
      config: CFG,
      callProvider: provider.fn,
    });

    expect(result.toolsUsed).toEqual(["summarise_results"]);
    expect(result.reply).toContain("10 mm");
    expect(result.error).toBeUndefined();
    // The tool result was fed back to the model.
    const lastTurns = provider.seen[provider.seen.length - 1];
    expect(lastTurns.some((t) => t.toolResults?.length)).toBe(true);
  });

  it("carries scenario changes made by tools back out to the caller", async () => {
    const provider = scriptedProvider([
      {
        text: "",
        toolCalls: [
          {
            id: "t1",
            name: "update_scenario",
            input: { psd_d10_um: 2, psd_d50_um: 25, psd_d90_um: 150, reason: "user PSD" },
          },
        ],
      },
      { text: "Re-ran with your distribution.", toolCalls: [] },
    ]);

    const result = await runAgent({
      history: [],
      userMessage: "I have a PSD: D10 2 µm, D50 25 µm, D90 150 µm",
      state: await makeState(),
      config: CFG,
      callProvider: provider.fn,
    });

    expect(result.state.scenario.psdOverride?.d50Um).toBe(25);
    expect(result.state.report.psdSource?.provenance).toBe("measured");
  });

  it("stops after the round limit instead of looping forever", async () => {
    const provider = scriptedProvider([
      { text: "", toolCalls: [{ id: "t", name: "get_site_data", input: {} }] },
    ]);
    const result = await runAgent({
      history: [],
      userMessage: "loop please",
      state: await makeState(),
      config: CFG,
      callProvider: provider.fn,
    });
    expect(result.error).toBe("max_rounds");
    expect(provider.calls).toBeLessThanOrEqual(6);
  });

  it("degrades to a clear message when the provider fails, leaving the report intact", async () => {
    const state = await makeState();
    const result = await runAgent({
      history: [],
      userMessage: "why?",
      state,
      config: CFG,
      callProvider: async () => {
        throw new Error("upstream 503");
      },
    });
    expect(result.error).toContain("503");
    expect(result.reply).toMatch(/deterministic engine/i);
    expect(result.state.report).toBe(state.report);
  });

  it("says so plainly when no AI provider is configured", async () => {
    const result = await runAgent({
      history: [],
      userMessage: "why?",
      state: await makeState(),
      config: undefined,
      callProvider: async () => {
        throw new Error("should not be called");
      },
    });
    // No key is set in the test environment.
    expect(result.error).toBe("ai_not_configured");
    expect(result.reply).toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  });
});

describe("system prompt", () => {
  it("states the rules that keep the model honest", async () => {
    const { report } = await makeState();
    const prompt = buildSystemPrompt(report);
    expect(prompt).toMatch(/You do not calculate/i);
    expect(prompt).toMatch(/Never fabricate/i);
    expect(prompt).toMatch(/RETENTION rating/);
    expect(prompt).toMatch(/SEPARATION characteristic/);
    expect(prompt).toMatch(/Assumption/);
    expect(prompt).toMatch(/Do not ask the user a list of questions/i);
    // It grounds the model in the current state.
    expect(prompt).toContain(report.overall.userLabel);
  });
});
