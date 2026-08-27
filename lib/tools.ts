import type { ParticleCharacter, PSD, Scenario, ScreeningReport } from "@/types";
import {
  compareConfigurations,
  getHydrocyclones,
  getMembraneOptions,
  runScreening,
} from "./screening";
import { analysePSD, parsePSDFromText, psdFromPercentiles, psdFromTable, psdVersusSizes } from "./psd";
import { describeParticleCharacter, particleCharacterFromText } from "./site";

/**
 * The deterministic functions the AI is allowed to call.
 *
 * The AI orchestrates; it does not compute. Every number the user is shown comes
 * out of these functions, which are the same ones the non-conversational report
 * uses. The AI's job is to decide what to ask for, to update the structured
 * scenario when the user tells it something new, and to explain the results.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolkitState {
  scenario: Scenario;
  report: ScreeningReport;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_site_data",
    description:
      "Return everything currently known about the site: the resolved location, every datum " +
      "retrieved from an open-data provider with its provenance, which providers succeeded or " +
      "failed, the assumed solids character, and the list of known unknowns. Call this first " +
      "when you need to ground a statement about the site in evidence.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_hydrocyclones",
    description:
      "Return the hydrocyclone catalogue, including each unit's cut-size data and, crucially, " +
      "whether that data is verified against a source or is an unverified screening placeholder.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_membrane_options",
    description: "Return the membrane/filter pore sizes currently being screened against.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "analyse_psd",
    description:
      "Run the deterministic particle-size-distribution engine. Supply EITHER percentiles " +
      "(d50 is required) OR a full cumulative table. Returns D10/D25/D50/D75/D90, span, the " +
      "size bands, and the percentage above and below each membrane pore size being screened. " +
      "Use this to answer questions about the distribution itself; it does not change the scenario.",
    parameters: {
      type: "object",
      properties: {
        d10_um: { type: "number", description: "Size in µm below which 10 % of the mass lies." },
        d50_um: { type: "number", description: "Median size in µm. Required unless a table is given." },
        d90_um: { type: "number", description: "Size in µm below which 90 % of the mass lies." },
        table: {
          type: "array",
          description: "Cumulative distribution as {size_um, cumulative_passing_percent} points.",
          items: {
            type: "object",
            properties: {
              size_um: { type: "number" },
              cumulative_passing_percent: { type: "number" },
            },
            required: ["size_um", "cumulative_passing_percent"],
          },
        },
        label: { type: "string", description: "Short description of where this distribution came from." },
      },
    },
  },
  {
    name: "update_scenario",
    description:
      "Change the structured scenario, then re-run the whole configuration matrix against it. " +
      "This is how new information from the user enters the assessment: a PSD they measured, a " +
      "correction to the solids character, a restriction to particular equipment. Never change " +
      "the assessment by reasoning alone - always update the scenario and re-run, then report " +
      "what actually changed.",
    parameters: {
      type: "object",
      properties: {
        particle_character: {
          type: "string",
          enum: ["sand", "mixed_mineral", "silt", "clay", "organic", "unknown"],
          description:
            "The character of the suspended solids. Set this when the user tells you what the " +
            "solids are (for example 'actually it is mostly clay').",
        },
        psd_d10_um: { type: "number" },
        psd_d50_um: { type: "number" },
        psd_d90_um: { type: "number" },
        psd_label: { type: "string", description: "Where this PSD came from, e.g. 'user-supplied, site sample'." },
        psd_from_text: {
          type: "string",
          description:
            "Raw text containing a PSD, e.g. 'D10 2 um, D50 25 um, D90 150 um'. The engine parses it.",
        },
        target_filtered_volume_litres: {
          type: "number",
          description: "Volume the user needs to put through the membrane, if they state one.",
        },
        hydrocyclone_ids: {
          type: "array",
          items: { type: "string" },
          description: "Restrict the matrix to these catalogue ids. Omit to use all of them.",
        },
        membrane_ids: {
          type: "array",
          items: { type: "string" },
          description: "Restrict the matrix to these membrane ids. Omit to use all of them.",
        },
        reason: {
          type: "string",
          description: "Why the scenario is being changed. Recorded in the audit trail.",
        },
      },
    },
  },
  {
    name: "run_configuration_matrix",
    description:
      "Re-run the full hydrocyclone x membrane matrix against the current scenario and return " +
      "every cell with its classification, confidence, metrics and reasoning.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "compare_configurations",
    description:
      "Compare hydrocyclones side by side over the same site and the same membrane range - " +
      "where each looks promising, where each is uncertain, and what differentiates them. " +
      "Use this for questions like 'compare the 4 mm and the 10 mm'.",
    parameters: {
      type: "object",
      properties: {
        hydrocyclone_ids: {
          type: "array",
          items: { type: "string" },
          description: "Catalogue ids to compare. Omit to compare all of them.",
        },
      },
    },
  },
  {
    name: "summarise_results",
    description:
      "Return the headline outputs of the current assessment: overall conclusion and confidence, " +
      "the useful membrane pore-size window, best and unlikely candidates, key assumptions, " +
      "unknowns, and the recommended next tests.",
    parameters: { type: "object", properties: {} },
  },
];

/* -------------------------------------------------------------------------- */

type Args = Record<string, unknown>;

const num = (a: Args, k: string): number | undefined => {
  const v = a[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};
const str = (a: Args, k: string): string | undefined => {
  const v = a[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};
const strArr = (a: Args, k: string): string[] | undefined => {
  const v = a[k];
  return Array.isArray(v) && v.every((x) => typeof x === "string") && v.length > 0
    ? (v as string[])
    : undefined;
};

/**
 * Creates a toolkit bound to one mutable scenario. The caller owns the state and
 * reads the updated scenario and report back out when the turn finishes.
 */
export function createToolkit(initial: ToolkitState) {
  const state: ToolkitState = { ...initial };

  const rerun = () => {
    state.report = runScreening({ scenario: state.scenario });
    return state.report;
  };

  const execute = (name: string, args: Args): unknown => {
    switch (name) {
      case "get_site_data": {
        const s = state.scenario.siteData;
        return {
          query: s.query,
          resolved_name: s.resolvedName,
          coordinates: s.latitude !== undefined ? [s.latitude, s.longitude] : undefined,
          water_body: s.waterBody,
          water_body_type: s.waterBodyType,
          catchment: s.catchment,
          geology_notes: s.geologyNotes,
          solids_character: {
            value: s.particleCharacter,
            description: describeParticleCharacter(s.particleCharacter),
            provenance: s.particleCharacterProvenance,
          },
          data: s.data,
          provider_reports: s.providerReports,
          unknowns: s.unknowns,
          assumptions: s.assumptions,
          psd_on_file: s.psd ?? null,
        };
      }

      case "get_hydrocyclones": {
        return getHydrocyclones().map((h) => ({
          id: h.id,
          name: h.name,
          diameter_mm: h.diameterMm.value,
          manufacturer: h.manufacturer,
          model: h.model,
          cut_size_d50_um: h.cutSize?.d50Um?.value ?? null,
          cut_size_provenance: h.cutSize?.d50Um?.provenance ?? null,
          cut_size_verified: h.cutSize?.d50Um?.verified ?? false,
          cut_size_source: h.cutSize?.d50Um?.source ?? null,
          sharpness_m: h.cutSize?.sharpness?.value ?? null,
          water_split_rf: h.cutSize?.waterSplitRf?.value ?? null,
          grade_efficiency_curve: h.cutSize?.gradeEfficiencyCurve?.value ?? null,
          operating_envelope: h.operating ?? null,
          catalogue_confidence: h.catalogueConfidence,
          data_complete: h.dataComplete,
          notes: h.notes ?? [],
          references: h.references ?? [],
        }));
      }

      case "get_membrane_options":
        return getMembraneOptions().map((m) => ({
          id: m.id,
          pore_size_um: m.poreSizeUm,
          label: m.label,
          rating: m.rating,
          manufacturer: m.manufacturer ?? null,
          model: m.model ?? null,
        }));

      case "analyse_psd": {
        let psd: PSD | undefined;
        const label = str(args, "label") ?? "Ad-hoc distribution supplied in conversation";
        const table = args["table"];

        if (Array.isArray(table) && table.length >= 2) {
          const points = table
            .map((p) => p as Args)
            .map((p) => ({
              sizeUm: num(p, "size_um") ?? Number.NaN,
              cumulativePassingPercent: num(p, "cumulative_passing_percent") ?? Number.NaN,
            }))
            .filter((p) => Number.isFinite(p.sizeUm) && Number.isFinite(p.cumulativePassingPercent));
          if (points.length >= 2) {
            psd = psdFromTable(points, {
              label,
              provenance: "measured",
              confidence: "medium",
              source: "Supplied in conversation; not independently verified.",
              verified: false,
            });
          }
        }

        if (!psd) {
          const d50 = num(args, "d50_um");
          if (d50 === undefined) {
            return {
              error:
                "A d50_um or a table of at least two points is required. Do not invent one - " +
                "ask the user, or say that no distribution is available.",
            };
          }
          psd = psdFromPercentiles({
            d10Um: num(args, "d10_um"),
            d50Um: d50,
            d90Um: num(args, "d90_um"),
            label,
            provenance: "measured",
            confidence: "medium",
            source: "Supplied in conversation; not independently verified.",
            verified: false,
          });
        }

        const stats = analysePSD(psd);
        return {
          statistics: stats,
          versus_membrane_pore_sizes: psdVersusSizes(
            psd,
            getMembraneOptions().map((m) => m.poreSizeUm),
          ),
          note:
            "This is an analysis only. It has NOT changed the scenario. Call update_scenario " +
            "if this distribution should replace the one the assessment is using.",
        };
      }

      case "update_scenario": {
        const changes: string[] = [];

        const characterRaw = str(args, "particle_character");
        if (characterRaw) {
          const character = characterRaw as ParticleCharacter;
          state.scenario.particleCharacterOverride = character;
          changes.push(`Solids character set to "${character}" (${describeParticleCharacter(character)}).`);
        }

        const fromText = str(args, "psd_from_text");
        let psd: PSD | undefined;
        if (fromText) {
          psd = parsePSDFromText(fromText, str(args, "psd_label") ?? "User-supplied PSD");
          if (!psd) changes.push("No PSD could be parsed from the supplied text; the scenario PSD is unchanged.");
        }
        const d50 = num(args, "psd_d50_um");
        if (!psd && d50 !== undefined) {
          psd = psdFromPercentiles({
            d10Um: num(args, "psd_d10_um"),
            d50Um: d50,
            d90Um: num(args, "psd_d90_um"),
            label: str(args, "psd_label") ?? "User-supplied PSD",
            provenance: "measured",
            confidence: "medium",
            source: "Supplied by the user in conversation; not independently verified.",
            verified: false,
            notes: [
              "Confidence is capped at medium because the measurement method, sampling point " +
                "and date are unknown.",
            ],
          });
        }
        if (psd) {
          state.scenario.psdOverride = psd;
          changes.push(
            `Particle-size distribution replaced with "${psd.label}" ` +
              `(D10 ${psd.d10Um ?? "?"}, D50 ${psd.d50Um ?? "?"}, D90 ${psd.d90Um ?? "?"} µm).`,
          );
        }

        const volume = num(args, "target_filtered_volume_litres");
        if (volume !== undefined) {
          state.scenario.targetFilteredVolumeLitres = volume;
          changes.push(`Target filtered volume recorded as ${volume} litres.`);
        }

        const hIds = strArr(args, "hydrocyclone_ids");
        if (hIds) {
          state.scenario.hydrocycloneIds = hIds;
          changes.push(`Matrix restricted to hydrocyclones: ${hIds.join(", ")}.`);
        }
        const mIds = strArr(args, "membrane_ids");
        if (mIds) {
          state.scenario.membraneIds = mIds;
          changes.push(`Matrix restricted to membranes: ${mIds.join(", ")}.`);
        }

        const reason = str(args, "reason");
        if (changes.length === 0) {
          return { changed: false, note: "No recognised scenario fields were supplied; nothing changed." };
        }

        state.scenario.changeLog.push(...changes.map((c) => (reason ? `${c} Reason: ${reason}` : c)));
        const before = state.report;
        const after = rerun();

        const movedCells = after.matrix
          .map((cell) => {
            const prev = before.matrix.find(
              (p) => p.hydrocycloneId === cell.hydrocycloneId && p.membraneId === cell.membraneId,
            );
            return prev && prev.classification !== cell.classification
              ? {
                  configuration: `${cell.hydrocycloneName} + ${cell.membraneLabel}`,
                  from: prev.classification,
                  to: cell.classification,
                }
              : undefined;
          })
          .filter(Boolean);

        return {
          changed: true,
          changes,
          previous_overall: before.overall,
          new_overall: after.overall,
          previous_window: before.usefulWindow.statement,
          new_window: after.usefulWindow.statement,
          cells_that_changed: movedCells,
          note:
            movedCells.length === 0
              ? "The matrix classifications did not change. Say so plainly rather than implying movement."
              : `${movedCells.length} cell(s) changed classification.`,
        };
      }

      case "run_configuration_matrix": {
        const report = rerun();
        return {
          overall: report.overall,
          useful_window: report.usefulWindow,
          psd_used: {
            label: report.psdSource?.label,
            provenance: report.psdSource?.provenance,
            verified: report.psdSource?.verified,
            d10: report.psdStatistics?.d10Um,
            d50: report.psdStatistics?.d50Um,
            d90: report.psdStatistics?.d90Um,
          },
          matrix: report.matrix.map((c) => ({
            hydrocyclone: c.hydrocycloneName,
            hydrocyclone_id: c.hydrocycloneId,
            membrane: c.membraneLabel,
            membrane_id: c.membraneId,
            classification: c.classification,
            confidence: c.confidence,
            metrics: c.metrics,
            reasoning: c.reasoning,
            main_uncertainty: c.mainUncertainty,
          })),
          warnings: report.warnings,
        };
      }

      case "compare_configurations": {
        const ids = strArr(args, "hydrocyclone_ids");
        const report = state.report;
        return {
          comparison: compareConfigurations(report.matrix, ids),
          note:
            "Where two units differ only in an unverified placeholder cut size, the difference " +
            "between them is a property of the placeholder, not of the equipment. Say so.",
          catalogue: getHydrocyclones(ids).map((h) => ({
            id: h.id,
            name: h.name,
            cut_size_verified: h.cutSize?.d50Um?.verified ?? false,
            data_complete: h.dataComplete,
          })),
        };
      }

      case "summarise_results": {
        const r = state.report;
        return {
          overall: r.overall,
          useful_window: r.usefulWindow,
          best_candidates: r.best.map((c) => ({
            configuration: `${c.hydrocycloneName} + ${c.membraneLabel}`,
            classification: c.classification,
            confidence: c.confidence,
            fouling_relief_fraction: c.metrics.foulingReliefFraction,
          })),
          borderline_candidates: r.borderline.map((c) => `${c.hydrocycloneName} + ${c.membraneLabel}`),
          unlikely_candidates: r.unlikely.map((c) => `${c.hydrocycloneName} + ${c.membraneLabel}`),
          missing_data_candidates: r.missingData.map((c) => `${c.hydrocycloneName} + ${c.membraneLabel}`),
          narrative: r.narrative,
          unknowns: r.unknowns,
          recommended_next_tests: r.recommendedNextTests,
          decision_tree: r.decisionTree,
          warnings: r.warnings,
          scenario_change_log: state.scenario.changeLog,
        };
      }

      default:
        return { error: `Unknown tool "${name}".` };
    }
  };

  return {
    execute,
    get state() {
      return state;
    },
  };
}

export function parsePSDMention(text: string): PSD | undefined {
  return parsePSDFromText(text);
}

export function particleMention(text: string): ParticleCharacter | undefined {
  return particleCharacterFromText(text);
}
