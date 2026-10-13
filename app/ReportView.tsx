"use client";

import { useState } from "react";
import type { ParticleCharacter, CharacterInference } from "@/lib/character";
import type { Resolution, StationMatch } from "@/lib/resolve";
import type { Psd } from "@/lib/psd";
import type { Category, MembraneAssessment, UpliftResult } from "@/lib/assessment";
import type { ScreeningReport } from "@/lib/report";
import type { SiteFlags } from "@/lib/flags";

interface HydrocycloneRef {
  id: string;
  name: string;
}

interface MembraneRef {
  id: string;
  label: string;
  poreSizeUm: number;
}

interface Props {
  hydrocyclones: HydrocycloneRef[];
  membranes: MembraneRef[];
}

interface Screened {
  /** Present for a confirmed NRFA station; absent for the geology-only fallback. */
  station?: { id: number; name: string; "catchment-area"?: number };
  /** Set when there was no NRFA gauge nearby - see lib/live-site.ts's screenPointGeology. */
  source?: "geology-only";
  /** The geocoded anchor, present for the geology-only path - it is the actual point read. */
  geocode?: { displayName: string; matchedOn: string };
  geologyStatement: string | null;
  /** Absent for the geology-only path, where point geology is the only tier there is. */
  geologyConsulted?: boolean;
  /** A real measured solids concentration near the site (EA Water Quality Archive), if one was found - see lib/live-site.ts's fetchSiteConcentration. */
  siteConcentration?: { mgL: number; source: string } | null;
  /** Algae/inhibition risk flags (lib/flags.ts) - independent of characterInference, shown alongside it, never blended into it. */
  flags: SiteFlags;
  /** Tide state (lib/sources/tide.ts) - null for an ordinary inland site or when no API key is set, not an error. */
  tideState?: {
    station: { id: string; name: string; distanceKm: number };
    phase: "flooding" | "ebbing" | "unknown";
    springNeap: "closer-to-spring" | "closer-to-neap" | "mid-cycle" | "unknown";
    reasoning: string;
  } | null;
  /** Satellite turbidity (lib/sources/satellite-turbidity.ts) - null for an inland site, or when no Copernicus credentials are set. Context only, never scored. */
  satelliteTurbidity?: {
    ndtiMean: number;
    sampleCount: number;
    noDataCount: number;
    reasoning: string;
  } | null;
  characterInference: CharacterInference;
  psd: Psd;
  assessments: MembraneAssessment[];
  report: ScreeningReport;
}

/**
 * The site-input flow is two confirmed steps, never one silent one.
 * HANDOFF.md: "the wrong reach is the worst silent failure available" - so
 * a match is proposed and shown, never auto-accepted, before any screening
 * runs on it.
 */
type FlowState =
  | { phase: "idle" }
  | { phase: "matching" }
  | { phase: "match-failed"; stage: string; message: string }
  | {
      phase: "confirm";
      matchedOn: string;
      resolution: Resolution;
      /** The point already geocoded - what "None of these" needs to fall back to geology alone. */
      bng: { easting: number; northing: number };
      displayName: string;
    }
  | { phase: "screening"; stationName: string }
  | { phase: "screen-failed"; message: string }
  | ({ phase: "screened" } & Screened);

const CHARACTER_LABELS: Record<ParticleCharacter, string> = {
  sand: "Sand",
  mixed_mineral: "Mixed mineral",
  silt: "Silt",
  clay: "Clay",
};

const CATEGORY_STYLE: Record<Category | "insufficient-data", { label: string; className: string }> = {
  likely: { label: "Likely", className: "cell-strong" },
  marginal: { label: "Marginal", className: "cell-marginal" },
  unlikely: { label: "Unlikely", className: "cell-unlikely" },
  "insufficient-data": { label: "No data", className: "cell-insufficient" },
};

const FLAG_RISK_STYLE: Record<SiteFlags["algae"]["risk"], { label: string; className: string }> = {
  elevated: { label: "Elevated", className: "stat-marginal" },
  low: { label: "Low", className: "stat-strong" },
  "insufficient-data": { label: "No data", className: "stat-insufficient" },
};

const RECOMMENDATION_LABEL: Record<string, string> = {
  "filter-alone": "Filter alone",
  "more-replicates": "Run more replicates",
  pretreatment: "Use pretreatment",
  "sample-sediment": "Sample sediment first",
};

interface SelectedDetail {
  membraneId: string;
  /** undefined selects the baseline; set selects one method's uplift. */
  methodId?: string;
}

const GRAIN_CARD_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Not observed" },
  { value: "clay", label: "Clay (under 4 µm)" },
  { value: "silt", label: "Silt (4-63 µm)" },
  { value: "fine_sand", label: "Fine sand (63-200 µm)" },
  { value: "medium_sand", label: "Medium sand (200-630 µm)" },
  { value: "coarse_sand", label: "Coarse sand (630 µm-2 mm)" },
  { value: "gravel", label: "Gravel (over 2 mm)" },
];

interface FieldUpdateResult {
  psd: Psd;
  fieldReasoning: string[];
  additionalContext: string[];
  assessments: MembraneAssessment[];
  report: ScreeningReport;
}

type FieldUpdateState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "done"; result: FieldUpdateResult }
  | { phase: "no-evidence"; message: string }
  | { phase: "failed"; message: string };

export default function ReportView({ hydrocyclones, membranes }: Props) {
  const [query, setQuery] = useState("");
  const [flow, setFlow] = useState<FlowState>({ phase: "idle" });
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<SelectedDetail | null>(null);

  const [fieldUpdate, setFieldUpdate] = useState<FieldUpdateState>({ phase: "idle" });
  const [grainCardClass, setGrainCardClass] = useState("");
  const [settleCleared, setSettleCleared] = useState("");
  const [settleHazyHours, setSettleHazyHours] = useState("");
  const [turbidityTube, setTurbidityTube] = useState("");
  const [siteNote, setSiteNote] = useState("");
  const [chatMessage, setChatMessage] = useState("");
  const [chatIntake, setChatIntake] = useState<{ parsedFrom: string[]; warnings: string[] } | null>(null);

  const live = flow.phase === "screened" ? flow : null;
  const fieldResult = fieldUpdate.phase === "done" ? fieldUpdate.result : null;
  /** The report currently on screen - a field reading if one was applied, otherwise the live screening. Null until a site is confirmed; there is no assumed-character fallback. */
  const current = live ? (fieldResult ?? live) : null;

  async function submitFieldUpdate() {
    setFieldUpdate({ phase: "submitting" });
    try {
      const body: Record<string, unknown> = {};
      if (grainCardClass) body.grainCardClass = grainCardClass;
      if (settleCleared.trim() || settleHazyHours.trim()) {
        body.settleTest = {
          clearedWithinMinutes: settleCleared.trim() ? Number(settleCleared) : null,
          observedForHours: settleHazyHours.trim() ? Number(settleHazyHours) : null,
        };
      }
      if (turbidityTube.trim()) body.turbidityTubeReadingCm = Number(turbidityTube);
      if (siteNote.trim()) body.siteNote = siteNote.trim();

      const res = await fetch("/api/field-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        setFieldUpdate({ phase: "no-evidence", message: data.message });
        return;
      }
      setFieldUpdate({
        phase: "done",
        result: {
          psd: data.psd,
          fieldReasoning: data.fieldReasoning,
          additionalContext: data.additionalContext,
          assessments: data.assessments,
          report: data.report,
        },
      });
      setSelected(null);
    } catch {
      setFieldUpdate({ phase: "failed", message: "Request failed - the server did not respond." });
    }
  }

  /**
   * The chat/conversational layer (rebuild phase 9) on top of the same
   * /api/field-update endpoint the structured form above posts to - free
   * text, PARSED server-side (lib/chat-intake.ts) into the exact same
   * structured fields, never scored itself. `chatIntake` shows what was
   * and wasn't understood, so a partial or failed parse is visible, not
   * silently dropped.
   */
  async function submitChatMessage() {
    if (!chatMessage.trim()) return;
    setFieldUpdate({ phase: "submitting" });
    setChatIntake(null);
    try {
      const res = await fetch("/api/field-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: chatMessage.trim() }),
      });
      const data = await res.json();
      setChatIntake(data.chatIntake ?? null);
      if (!data.ok) {
        setFieldUpdate({ phase: "no-evidence", message: data.message });
        return;
      }
      setFieldUpdate({
        phase: "done",
        result: {
          psd: data.psd,
          fieldReasoning: data.fieldReasoning,
          additionalContext: data.additionalContext,
          assessments: data.assessments,
          report: data.report,
        },
      });
      setSelected(null);
    } catch {
      setFieldUpdate({ phase: "failed", message: "Request failed - the server did not respond." });
    }
  }

  function clearFieldUpdate() {
    setFieldUpdate({ phase: "idle" });
    setChatIntake(null);
  }

  const assessmentFor = (membraneId: string) => current!.assessments.find((a) => a.membraneId === membraneId)!;
  const selectedAssessment = selected && current ? assessmentFor(selected.membraneId) : null;
  const selectedUplift: UpliftResult | null =
    selected?.methodId && selectedAssessment
      ? selectedAssessment.uplifts.find((u) => u.methodId === selected.methodId) ?? null
      : null;

  async function lookUp() {
    if (!query.trim()) return;
    setFlow({ phase: "matching" });
    setSelected(null);
    try {
      const res = await fetch(`/api/resolve?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!data.ok) {
        setFlow({ phase: "match-failed", stage: data.stage, message: data.message });
        return;
      }
      if (data.source === "geology-only") {
        setFlow({
          phase: "screened",
          source: "geology-only",
          geocode: data.geocode,
          geologyStatement: data.geologyStatement,
          siteConcentration: data.siteConcentration,
          flags: data.flags,
          tideState: data.tideState,
          satelliteTurbidity: data.satelliteTurbidity,
          characterInference: data.characterInference,
          psd: data.psd,
          assessments: data.assessments,
          report: data.report,
        });
        return;
      }
      setFlow({
        phase: "confirm",
        matchedOn: data.geocode.matchedOn,
        resolution: data.resolution,
        bng: data.bng,
        displayName: data.geocode.displayName,
      });
    } catch {
      setFlow({ phase: "match-failed", stage: "network", message: "Request failed - the server did not respond." });
    }
  }

  async function confirmStation(candidate: StationMatch) {
    setFlow({ phase: "screening", stationName: candidate.station.name });
    setSelected(null);
    try {
      const s = candidate.station;
      const qs = new URLSearchParams({
        id: String(s.id),
        name: s.name,
        river: s.river ?? "",
        easting: String(s.easting),
        northing: String(s.northing),
        catchmentArea: s["catchment-area"] != null ? String(s["catchment-area"]) : "",
      });
      const res = await fetch(`/api/screen?${qs}`);
      const data = await res.json();
      if (!data.ok) {
        setFlow({ phase: "screen-failed", message: data.message });
        return;
      }
      setFlow({ phase: "screened", ...data });
    } catch {
      setFlow({ phase: "screen-failed", message: "Request failed - the server did not respond." });
    }
  }

  /**
   * The opt-out decideResolution's own message promises ("or say so and the
   * geology will be read straight from the map") but that, until now, had no
   * button behind it - see BUILD.md. Used both when none of the candidates
   * are the intended site, and when there were no candidates to begin with.
   */
  async function confirmGeologyOnly(bng: { easting: number; northing: number }, matchedOn: string, displayName: string) {
    setFlow({ phase: "screening", stationName: "the mapped point" });
    setSelected(null);
    try {
      const qs = new URLSearchParams({
        mode: "geology-only",
        easting: String(bng.easting),
        northing: String(bng.northing),
        matchedOn,
        displayName,
      });
      const res = await fetch(`/api/screen?${qs}`);
      const data = await res.json();
      if (!data.ok) {
        setFlow({ phase: "screen-failed", message: data.message });
        return;
      }
      setFlow({ phase: "screened", ...data });
    } catch {
      setFlow({ phase: "screen-failed", message: "Request failed - the server did not respond." });
    }
  }

  return (
    <main>
      <header className="page-header">
        <h1>Site Suitability Tool</h1>
      </header>

      <section className="input-row">
        <label htmlFor="site-input">
          <strong>Site input</strong> - e.g. &quot;Tilford, River Wey&quot;, or exact coordinates
          (&quot;51.154565, -0.791587&quot;). Confirm the match before anything is screened, or
          choose to sample at your given coordinates.
        </label>
        <div className="site-input-row">
          <input
            id="site-input"
            type="text"
            value={query}
            placeholder="Settlement, waterbody - or lat, lon"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && lookUp()}
          />
          <button type="button" onClick={lookUp} disabled={flow.phase === "matching"}>
            {flow.phase === "matching" ? "Looking up..." : "Look up"}
          </button>
        </div>
      </section>

      {flow.phase === "match-failed" && (
        <section className="live-status live-error">
          <strong>Could not resolve that site ({flow.stage}):</strong> {flow.message}
        </section>
      )}

      {flow.phase === "confirm" && (
        <section className="live-status live-confirm">
          <p>{flow.resolution.statement}</p>
          <ul className="candidate-list">
            {flow.resolution.candidates.map((c) => (
              <li key={c.station.id}>
                <button type="button" className="candidate-button" onClick={() => confirmStation(c)}>
                  Confirm: {c.station.name}
                  {c.station["catchment-area"] ? ` (${c.station["catchment-area"]} km²)` : ""}
                  {c.distanceKm !== undefined ? ` - ${c.distanceKm.toFixed(1)} km from "${flow.matchedOn}"` : ""}
                </button>
                <span className="candidate-reason">{c.reason}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="candidate-button candidate-none"
            onClick={() => confirmGeologyOnly(flow.bng, flow.matchedOn, flow.displayName)}
          >
            None of these - read geology at this point instead
          </button>
        </section>
      )}

      {flow.phase === "screening" && (
        <section className="live-status live-pending">Screening {flow.stationName}...</section>
      )}

      {flow.phase === "screen-failed" && (
        <section className="live-status live-error">
          <strong>Matched, but could not screen it:</strong> {flow.message}
        </section>
      )}

      {live && live.source === "geology-only" && (
        <section className="live-status live-geology-only">
          <p>
            <strong>No NRFA gauge nearby</strong> - normal for a small or urban watercourse. Reading
            from the mapped geology at this point only, not a catchment-wide inference.
          </p>
          {live.geocode && live.geocode.matchedOn === "coordinates" ? (
            <p>
              <strong>Anchor point:</strong> the exact coordinates given ({live.geocode.displayName}) -
              no settlement name involved, so no anchor-precision caveat applies here.
            </p>
          ) : (
            live.geocode && (
              <p>
                <strong>Anchor point:</strong> &quot;{live.geocode.matchedOn}&quot; ({live.geocode.displayName}).
                For a small watercourse this is often the nearest settlement, not the water itself -
                if it runs some distance from that point, the geology there may differ from what is
                mapped here. Treat this reading as a rough starting point, not the site itself confirmed.
              </p>
            )
          )}
        </section>
      )}

      {live && (
        <section className="live-status live-ok">
          {live.station && (
            <p className="station-line">
              {live.station.name} <span className="mono">· NRFA {live.station.id}</span>
              {live.station["catchment-area"] ? ` · ${live.station["catchment-area"]} km² catchment` : ""}
            </p>
          )}

          <div className="stat-strip">
            <div className="stat-chip">
              <span className="eyebrow">Character</span>
              <span className="stat-value">
                {CHARACTER_LABELS[live.characterInference.character]} ({live.characterInference.confidence})
              </span>
            </div>
            <div className={`stat-chip ${FLAG_RISK_STYLE[live.flags.algae.risk].className}`}>
              <span className="eyebrow">Algae risk</span>
              <span className="stat-value">{FLAG_RISK_STYLE[live.flags.algae.risk].label}</span>
            </div>
            <div className={`stat-chip ${FLAG_RISK_STYLE[live.flags.inhibition.risk].className}`}>
              <span className="eyebrow">Inhibition risk</span>
              <span className="stat-value">{FLAG_RISK_STYLE[live.flags.inhibition.risk].label}</span>
            </div>
            {live.siteConcentration && (
              <div className="stat-chip">
                <span className="eyebrow">EA water quality</span>
                <span className="stat-value">{live.siteConcentration.mgL.toFixed(1)} mg/L</span>
              </div>
            )}
            {live.tideState && (
              <div className="stat-chip">
                <span className="eyebrow">Tide state</span>
                <span className="stat-value">
                  {live.tideState.phase}, {live.tideState.springNeap}
                </span>
              </div>
            )}
            {live.satelliteTurbidity && (
              <div className="stat-chip">
                <span className="eyebrow">Satellite turbidity</span>
                <span className="stat-value">NDTI {live.satelliteTurbidity.ndtiMean.toFixed(3)}</span>
              </div>
            )}
          </div>

          <details className="disclosure">
            <summary>Reasoning behind these readings</summary>
            <div className="disclosure-body">
              <ul>
                {live.characterInference.reasoning.map((line, i) => (
                  <li key={`char-${i}`}>{line}</li>
                ))}
                <li>Algae risk: {live.flags.algae.reasoning}</li>
                <li>Inhibition risk: {live.flags.inhibition.reasoning}</li>
                {live.siteConcentration && <li>EA water quality: {live.siteConcentration.source}</li>}
                {live.tideState && (
                  <li>
                    Tide: {live.tideState.station.name} tide station, {live.tideState.station.distanceKm.toFixed(1)} km
                    away. {live.tideState.reasoning}
                  </li>
                )}
                {live.satelliteTurbidity && (
                  <li>
                    Satellite turbidity (context only, not scored): {live.satelliteTurbidity.sampleCount} of{" "}
                    {live.satelliteTurbidity.sampleCount + live.satelliteTurbidity.noDataCount} pixels cloud-free.{" "}
                    {live.satelliteTurbidity.reasoning}
                  </li>
                )}
              </ul>
            </div>
          </details>
        </section>
      )}

      {!live && (
        <section className="input-row homepage-placeholder">
          <p>
            This tool screens a UK river, stream or other waterbody site for hydrocyclone
            pre-treatment and membrane filtration suitability - combining live geology,
            water-quality, tide and satellite readings for the site you enter with real site trial
            data where it exists. Enter a site above to get started.
          </p>
          <p className="hint">More about the method will go here.</p>
        </section>
      )}

      {current && (
        <>
          <section className={`window-banner ${current.report.usefulWindow ? "window-yes" : "window-no"}`}>
            {current.report.usefulWindow ? (
              <>
                <strong>Worth investigating:</strong> membrane ratings from{" "}
                {current.report.usefulWindow.fromPoreSizeUm} to {current.report.usefulWindow.toPoreSizeUm} µm.
              </>
            ) : (
              <>
                <strong>Not worth investigating yet</strong> at any membrane rating tested for this
                solids character.
              </>
            )}
          </section>

          <section>
            <h2>Per membrane: baseline, uplift, recommendation</h2>
            <p className="hint">Click a volume or uplift cell for the full reasoning behind it.</p>
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col">Membrane</th>
                  <th scope="col">Baseline volume (filter alone)</th>
                  {hydrocyclones.map((h) => (
                    <th scope="col" key={h.id}>
                      {h.name} uplift
                    </th>
                  ))}
                  <th scope="col">Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {membranes.map((m) => {
                  const a = assessmentFor(m.id);
                  const baselineSelected = selected?.membraneId === m.id && !selected.methodId;
                  return (
                    <tr key={m.id}>
                      <th scope="row">{m.label}</th>
                      <td>
                        <button
                          type="button"
                          className={`cell ${a.baselineVolume ? "cell-strong" : "cell-insufficient"} ${baselineSelected ? "cell-selected" : ""}`}
                          onClick={() => setSelected(baselineSelected ? null : { membraneId: m.id })}
                        >
                          {a.baselineVolume ? (
                            <>
                              <span className="cell-verdict">
                                {a.baselineVolume.lowMl.toFixed(0)}-{a.baselineVolume.highMl.toFixed(0)} mL
                              </span>
                              <span className="cell-ratio">
                                {a.baselineConfidence}
                                {a.baselineSource === "estimated" ? " (estimated)" : ""}
                              </span>
                            </>
                          ) : (
                            <span className="cell-verdict">No data</span>
                          )}
                        </button>
                      </td>
                      {hydrocyclones.map((h) => {
                        const u = a.uplifts.find((x) => x.methodId === h.id)!;
                        const style = CATEGORY_STYLE[u.category];
                        const isSelected = selected?.membraneId === m.id && selected?.methodId === h.id;
                        return (
                          <td key={h.id}>
                            <button
                              type="button"
                              className={`cell ${style.className} ${isSelected ? "cell-selected" : ""}`}
                              onClick={() => setSelected(isSelected ? null : { membraneId: m.id, methodId: h.id })}
                            >
                              <span className="cell-verdict">{style.label}</span>
                              <span className="cell-ratio">
                                {Number.isFinite(u.multiplier.mid) ? `${u.multiplier.mid.toFixed(2)}x` : "-"}
                              </span>
                            </button>
                          </td>
                        );
                      })}
                      <td>{RECOMMENDATION_LABEL[a.recommendation.kind]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <details className="field-update-section" open={Boolean(fieldResult)}>
            <summary>On-site field update</summary>
            <p className="field-update-sub">
              Standing at the site right now? A real field reading replaces the desk-based guess
              for this report, deterministically - no site visit needed to rebuild anything.
            </p>
            <div className="field-update-chat">
              <label htmlFor="field-chat">
                Or describe what you saw, in your own words
                <textarea
                  id="field-chat"
                  value={chatMessage}
                  onChange={(e) => setChatMessage(e.target.value)}
                  placeholder={'e.g. "looks like fine sand, cleared within 10 minutes"'}
                  rows={2}
                />
              </label>
              <button type="button" onClick={submitChatMessage} disabled={!chatMessage.trim() || fieldUpdate.phase === "submitting"}>
                {fieldUpdate.phase === "submitting" ? "Parsing..." : "Parse & apply"}
              </button>
              <p className="hint">
                Parsed into the same fields as the form below, never scored directly - AI (here, a
                deterministic parser) only ever reads words into structured fields; see HANDOFF.md.
              </p>
              {chatIntake && (
                <div className="hint">
                  {chatIntake.parsedFrom.map((line, i) => (
                    <p key={`parsed-${i}`}>Understood: {line}</p>
                  ))}
                  {chatIntake.warnings.map((line, i) => (
                    <p key={`warn-${i}`}>Not understood: {line}</p>
                  ))}
                </div>
              )}
            </div>
            <div className="field-update-form">
              <label htmlFor="grain-card">
                Grain card match
                <select id="grain-card" value={grainCardClass} onChange={(e) => setGrainCardClass(e.target.value)}>
                  {GRAIN_CARD_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="settle-cleared">
                Settle test - cleared within (minutes)
                <input
                  id="settle-cleared"
                  type="number"
                  min="0"
                  value={settleCleared}
                  onChange={(e) => setSettleCleared(e.target.value)}
                  placeholder="e.g. 5"
                />
              </label>
              <label htmlFor="settle-hazy">
                ...or still hazy after (hours)
                <input
                  id="settle-hazy"
                  type="number"
                  min="0"
                  value={settleHazyHours}
                  onChange={(e) => setSettleHazyHours(e.target.value)}
                  placeholder="e.g. 6"
                />
              </label>
              <label htmlFor="turbidity-tube">
                Turbidity tube reading (cm)
                <input
                  id="turbidity-tube"
                  type="number"
                  min="0"
                  value={turbidityTube}
                  onChange={(e) => setTurbidityTube(e.target.value)}
                  placeholder="context only - not scored"
                />
              </label>
              <label htmlFor="site-note">
                Site note
                <input id="site-note" type="text" value={siteNote} onChange={(e) => setSiteNote(e.target.value)} placeholder="anything else worth recording" />
              </label>
              <div className="field-update-actions">
                <button type="button" onClick={submitFieldUpdate} disabled={!grainCardClass || fieldUpdate.phase === "submitting"}>
                  {fieldUpdate.phase === "submitting" ? "Recomputing..." : "Apply field reading"}
                </button>
                {fieldResult && (
                  <button type="button" onClick={clearFieldUpdate}>
                    Clear field reading, use the desk estimate again
                  </button>
                )}
              </div>
            </div>
            {fieldUpdate.phase === "no-evidence" && <p className="hint">{fieldUpdate.message}</p>}
            {fieldUpdate.phase === "failed" && <p className="hint">{fieldUpdate.message}</p>}
            {fieldResult && (
              <div className="live-status live-ok">
                <p>
                  <strong>Field reading applied:</strong> {fieldResult.psd.label} (status: {fieldResult.psd.status})
                </p>
                <ul>
                  {fieldResult.fieldReasoning.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                {fieldResult.additionalContext.length > 0 && (
                  <>
                    <p className="hint">Additional context (not scored):</p>
                    <ul>
                      {fieldResult.additionalContext.map((line, i) => (
                        <li key={i} className="hint">
                          {line}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </details>

          {selectedUplift && (
            <section className="cell-detail">
              <h3>
                {membranes.find((m) => m.id === selected?.membraneId)?.label} +{" "}
                {hydrocyclones.find((h) => h.id === selected?.methodId)?.name}
              </h3>
              <p>{selectedUplift.reasoning}</p>
            </section>
          )}
          {!selectedUplift && selectedAssessment && selected && !selected.methodId && (
            <section className="cell-detail">
              <h3>{membranes.find((m) => m.id === selected.membraneId)?.label} - baseline</h3>
              <p>{selectedAssessment.baselineReasoning}</p>
            </section>
          )}

          <section>
            <button type="button" className="expand-toggle" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Hide full report ▲" : "Show full report ▼"}
            </button>
          </section>

          {expanded && (
            <section className="full-report">
              <h2>Full report</h2>

              <h3>Verdict</h3>
              <p>{current.report.verdict}</p>

              <h3>Why</h3>
              <p>{current.report.why}</p>

              <h3>What we know</h3>
              <ul>
                {current.report.whatWeKnow.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>

              <h3>What we don&apos;t know</h3>
              <ul>
                {current.report.whatWeDontKnow.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>

              <h3>Recommended test</h3>
              <p>{current.report.recommendedTest}</p>

              <h3>Every configuration tested</h3>
              <table className="config-list">
                <thead>
                  <tr>
                    <th>Membrane</th>
                    <th>Method</th>
                    <th>Category</th>
                    <th>Uplift</th>
                    <th>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {current.assessments.flatMap((a) =>
                    a.uplifts.map((u, i) => (
                      <tr key={`${a.membraneId}-${u.methodId}-${i}`}>
                        <td>{membranes.find((m) => m.id === a.membraneId)?.label}</td>
                        <td>{u.methodLabel}</td>
                        <td>{CATEGORY_STYLE[u.category].label}</td>
                        <td>{Number.isFinite(u.multiplier.mid) ? `${u.multiplier.mid.toFixed(2)}x` : "-"}</td>
                        <td>{u.confidence}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      <footer className="page-footer">
        Do not enter confidential or commercially sensitive information. Runs are logged to this
        repository.
      </footer>
    </main>
  );
}
