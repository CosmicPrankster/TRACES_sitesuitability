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

/**
 * A controlled, animated expand/collapse card - used for the title page's
 * three info boxes and the content page's three finding boxes (Notion card
 * 11). Animates open/close via the CSS grid-rows 0fr->1fr technique, which
 * transitions smoothly to the content's natural height with no JS
 * measurement and no animation library.
 */
function Expandable({
  title,
  subtitle,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`expandable ${open ? "expandable-open" : ""}`}>
      <button type="button" className="expandable-trigger" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="expandable-trigger-text">
          <span className="expandable-title">{title}</span>
          {subtitle && <span className="expandable-subtitle">{subtitle}</span>}
        </span>
        {badge}
        <span className="expandable-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      <div className="expandable-panel">
        <div className="expandable-panel-inner">
          <div>{children}</div>
        </div>
      </div>
    </div>
  );
}

export default function ReportView({ hydrocyclones, membranes }: Props) {
  const [query, setQuery] = useState("");
  const [flow, setFlow] = useState<FlowState>({ phase: "idle" });
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
  /**
   * The report currently on screen - a field reading if one was applied,
   * otherwise the live screening, otherwise nothing (there is no
   * assumed-character fallback). A field reading stands on its own: it must
   * NOT require `live` - it is the highest-confidence tier precisely
   * because it works even when geocoding/NRFA matching has failed or was
   * never attempted (see HANDOFF.md's 2026-10-13 field-update-gating note).
   */
  const current = fieldResult ?? live;

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

  /** What the printable report's header calls the site - the best name available for whichever tier produced `current`. */
  function siteLabel(): string {
    if (live?.station) return live.station.name;
    if (live?.geocode) return live.geocode.displayName;
    return "Field-observed site (no site resolved)";
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
        <section className="live-status live-error enter-animate">
          <strong>Could not resolve that site ({flow.stage}):</strong> {flow.message}
        </section>
      )}

      {flow.phase === "confirm" && (
        <section className="live-status live-confirm enter-animate">
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
        <section className="live-status live-pending enter-animate">Screening {flow.stationName}...</section>
      )}

      {flow.phase === "screen-failed" && (
        <section className="live-status live-error enter-animate">
          <strong>Matched, but could not screen it:</strong> {flow.message}
        </section>
      )}

      {/* ---------- TITLE PAGE: shown until something is resolved (Notion card 11, section 1) ---------- */}
      {!current && (
        <section className="homepage-placeholder enter-animate">
          <Expandable title="What it is" defaultOpen>
            <p>
              A screening tool for UK river, stream or other waterbody sites: how much water a
              membrane filter is likely to pass before it blinds, with and without hydrocyclone
              pre-treatment, before any equipment is bought or a bench trial is run.
            </p>
            <p>
              It combines live geology, measured water-quality, tide and satellite readings for
              the site you enter with real site trial data where it exists - and says plainly
              when it doesn&apos;t have enough to give a confident answer, rather than guessing.
            </p>
          </Expandable>
          <Expandable title="How it works">
            <p>
              Evidence is read in priority order, strongest first: a real on-site reading, then
              measured water quality nearby, then satellite turbidity on larger rivers, then
              catchment geology from the nearest river gauge, then bedrock geology at the point
              alone if nothing else is nearby. The first tier with usable data wins.
            </p>
            <p>
              Every number is a range with a named confidence level, never a single falsely
              precise figure - and the scoring itself is plain deterministic physics, not a
              model&apos;s guess. The only place AI is involved is turning a free-text field note
              into structured data; it never decides a verdict.
            </p>
          </Expandable>
          <Expandable title="How to contribute data">
            <p>
              Standing at a real site? Use the on-site field update tool at the bottom of this
              page - a grain card, settle test or turbidity tube reading (or just describe what
              you saw) replaces the desk-based estimate for that site immediately,
              deterministically, no rebuild required.
            </p>
            <p className="hint">
              It works even before a site has been looked up above - a real field reading is the
              strongest evidence this tool can use.
            </p>
          </Expandable>
        </section>
      )}

      {/* ---------- CONTENT PAGE: shown once a reading exists, from a confirmed site or a field reading (Notion card 11, section 2) ---------- */}
      {current && (
        <>
          {/* b) minimal status bar */}
          <section className="status-bar enter-animate">
            {live?.station && (
              <>
                <strong>{live.station.name}</strong>
                <span className="mono">NRFA {live.station.id}</span>
                {live.station["catchment-area"] && <span>{live.station["catchment-area"]} km² catchment</span>}
              </>
            )}
            {live?.source === "geology-only" && (
              <>
                <strong>No NRFA gauge nearby</strong>
                <span>
                  reading mapped geology at{" "}
                  {live.geocode?.matchedOn === "coordinates" ? live.geocode.displayName : `"${live.geocode?.matchedOn}"`}
                </span>
              </>
            )}
            {!live && fieldResult && <strong>Field reading applied - no site resolved</strong>}
          </section>

          <section className={`window-banner ${current.report.usefulWindow ? "window-yes" : "window-no"} enter-animate`}>
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

          {/* c) split row: findings (left) / download report (right) */}
          <section className="content-split enter-animate">
            <div className="content-split-left">
              {live && (
                <div className="stat-strip">
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
              )}

              <Expandable
                title="Found character"
                subtitle={live ? undefined : "from field reading"}
                defaultOpen
                badge={
                  live && (
                    <span className="pill">
                      {CHARACTER_LABELS[live.characterInference.character]} · {live.characterInference.confidence}
                    </span>
                  )
                }
              >
                {live ? (
                  <ul>
                    {live.characterInference.reasoning.map((line, i) => (
                      <li key={`char-${i}`}>{line}</li>
                    ))}
                    {live.siteConcentration && <li>EA water quality: {live.siteConcentration.source}</li>}
                    {live.tideState && (
                      <li>
                        Tide: {live.tideState.station.name} tide station,{" "}
                        {live.tideState.station.distanceKm.toFixed(1)} km away. {live.tideState.reasoning}
                      </li>
                    )}
                    {live.satelliteTurbidity && (
                      <li>
                        Satellite turbidity (context only, not scored): {live.satelliteTurbidity.sampleCount} of{" "}
                        {live.satelliteTurbidity.sampleCount + live.satelliteTurbidity.noDataCount} pixels cloud-free.{" "}
                        {live.satelliteTurbidity.reasoning}
                      </li>
                    )}
                    {live.source === "geology-only" && live.geocode && live.geocode.matchedOn !== "coordinates" && (
                      <li>
                        Anchor point: &quot;{live.geocode.matchedOn}&quot; ({live.geocode.displayName}). For a small
                        watercourse this is often the nearest settlement, not the water itself - treat this as a
                        rough starting point.
                      </li>
                    )}
                  </ul>
                ) : (
                  <p>{fieldResult?.fieldReasoning.join(" ")}</p>
                )}
              </Expandable>

              {live && (
                <Expandable title="Algae risk" badge={<span className={`pill ${FLAG_RISK_STYLE[live.flags.algae.risk].className}`}>{FLAG_RISK_STYLE[live.flags.algae.risk].label}</span>}>
                  <p>{live.flags.algae.reasoning}</p>
                </Expandable>
              )}
              {live && (
                <Expandable
                  title="Inhibition risk"
                  badge={<span className={`pill ${FLAG_RISK_STYLE[live.flags.inhibition.risk].className}`}>{FLAG_RISK_STYLE[live.flags.inhibition.risk].label}</span>}
                >
                  <p>{live.flags.inhibition.reasoning}</p>
                </Expandable>
              )}
              {fieldResult && fieldResult.additionalContext.length > 0 && (
                <Expandable title="Additional field context" subtitle="not scored">
                  <ul>
                    {fieldResult.additionalContext.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </Expandable>
              )}
            </div>

            <div className="content-split-right">
              <span className="eyebrow">Full report</span>
              <button type="button" className="btn" onClick={() => window.print()}>
                Download full report
              </button>
              <p className="hint">
                Click the link above to download the full report, which details the verdict, why,
                what we know, what we don&apos;t know, the recommended test, and the table of
                configurations.
              </p>
            </div>
          </section>

          {/* d) estimations - the table of configurations, its own full-width row */}
          <section className="enter-animate">
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

          {selectedUplift && (
            <section className="cell-detail enter-animate">
              <h3>
                {membranes.find((m) => m.id === selected?.membraneId)?.label} +{" "}
                {hydrocyclones.find((h) => h.id === selected?.methodId)?.name}
              </h3>
              <p>{selectedUplift.reasoning}</p>
            </section>
          )}
          {!selectedUplift && selectedAssessment && selected && !selected.methodId && (
            <section className="cell-detail enter-animate">
              <h3>{membranes.find((m) => m.id === selected.membraneId)?.label} - baseline</h3>
              <p>{selectedAssessment.baselineReasoning}</p>
            </section>
          )}

          {/* f) placeholder for a future chat-about-this-result feature */}
          <section className="chat-placeholder enter-animate">
            <h2>
              Chat about this result <span className="badge-soon">Coming soon</span>
            </h2>
            <p className="hint">Ask questions about this report in plain language - not built yet.</p>
            <div className="chat-placeholder-box">
              <input type="text" disabled placeholder="Ask about this result..." />
              <button type="button" className="btn" disabled>
                Send
              </button>
            </div>
          </section>

          {/* Hidden on screen, shown only when printing - what "Download full report" produces. */}
          <div className="printable-report">
            <div className="printable-header">
              <div>
                <strong>Site Suitability Tool</strong> - full report
                <div>{siteLabel()}</div>
              </div>
              <div>{new Date().toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" })}</div>
            </div>

            <div className="full-report">
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
            </div>

            <div className="printable-footer">
              Preliminary engineering screening only - not process design, equipment selection, or
              a guarantee of membrane performance.
            </div>
          </div>
        </>
      )}

      {/* e) on-site field data - deliberately NOT gated to the content page: a real field reading
          must work standalone, even with no site resolved above (see current's doc comment). */}
      <details className="field-update-section" open={Boolean(fieldResult)}>
        <summary>On-site field update</summary>
        <p className="field-update-sub">
          Standing at the site right now? A real field reading produces this report directly, with
          or without a site resolved above - deterministically, no site visit needed to rebuild
          anything. This is the highest-confidence tier: it works even when a site can't be found
          or matched.
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
                {live ? "Clear field reading, use the desk estimate again" : "Clear field reading"}
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
          </div>
        )}
      </details>

      <footer className="page-footer">
        Do not enter confidential or commercially sensitive information. Runs are logged to this
        repository.
      </footer>
    </main>
  );
}
