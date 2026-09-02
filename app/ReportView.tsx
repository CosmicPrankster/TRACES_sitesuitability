"use client";

import { useState } from "react";
import type { ParticleCharacter, CharacterInference } from "@/lib/character";
import type { Resolution, StationMatch } from "@/lib/resolve";
import type { Psd } from "@/lib/psd";
import type { AssessmentCell, Verdict } from "@/lib/assessment";
import type { ScreeningReport } from "@/lib/report";

export interface CharacterData {
  psd: Psd;
  matrix: AssessmentCell[];
  report: ScreeningReport;
}

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
  byCharacter: Record<ParticleCharacter, CharacterData>;
}

interface Screened {
  /** Present for a confirmed NRFA station; absent for the geology-only fallback. */
  station?: { id: number; name: string; "catchment-area"?: number };
  /** Set when there was no NRFA gauge nearby - see lib/live-site.ts's screenPointGeology. */
  source?: "geology-only";
  /** The geocoded anchor, present for the geology-only path - it is the actual point read. */
  geocode?: { displayName: string; matchedOn: string };
  geologyStatement: string | null;
  characterInference: CharacterInference;
  psd: Psd;
  matrix: AssessmentCell[];
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
  | { phase: "confirm"; matchedOn: string; resolution: Resolution }
  | { phase: "screening"; stationName: string }
  | { phase: "screen-failed"; message: string }
  | ({ phase: "screened" } & Screened);

const CHARACTER_LABELS: Record<ParticleCharacter, string> = {
  sand: "Sand",
  mixed_mineral: "Mixed mineral",
  silt: "Silt",
  clay: "Clay",
};

const VERDICT_STYLE: Record<Verdict, { label: string; className: string }> = {
  strong: { label: "Works well", className: "cell-strong" },
  promising: { label: "Works", className: "cell-promising" },
  marginal: { label: "Marginal", className: "cell-marginal" },
  unlikely: { label: "Won't work", className: "cell-unlikely" },
  "insufficient-data": { label: "No data", className: "cell-insufficient" },
};

export default function ReportView({ hydrocyclones, membranes, byCharacter }: Props) {
  const [query, setQuery] = useState("");
  const [flow, setFlow] = useState<FlowState>({ phase: "idle" });
  const [character, setCharacter] = useState<ParticleCharacter>("sand");
  const [expanded, setExpanded] = useState(false);
  const [selectedCell, setSelectedCell] = useState<AssessmentCell | null>(null);

  const live = flow.phase === "screened" ? flow : null;
  const { matrix, report } = live ?? byCharacter[character];

  const cellFor = (hydrocycloneId: string, membraneId: string) =>
    matrix.find((c) => c.hydrocycloneId === hydrocycloneId && c.membraneId === membraneId)!;

  async function lookUp() {
    if (!query.trim()) return;
    setFlow({ phase: "matching" });
    setSelectedCell(null);
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
          characterInference: data.characterInference,
          psd: data.psd,
          matrix: data.matrix,
          report: data.report,
        });
        return;
      }
      setFlow({ phase: "confirm", matchedOn: data.geocode.matchedOn, resolution: data.resolution });
    } catch {
      setFlow({ phase: "match-failed", stage: "network", message: "Request failed - the server did not respond." });
    }
  }

  async function confirmStation(candidate: StationMatch) {
    setFlow({ phase: "screening", stationName: candidate.station.name });
    setSelectedCell(null);
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

  return (
    <main>
      <header className="page-header">
        <h1>Hydrocyclone + membrane screening</h1>
        <p className="disclaimer">
          Preliminary engineering screening only - not process design, equipment selection, or a
          guarantee of membrane performance.
        </p>
      </header>

      <section className="input-row">
        <label htmlFor="site-input">
          <strong>Site input</strong> - e.g. &quot;Tilford, River Wey&quot;, or exact coordinates
          (&quot;51.154565, -0.791587&quot;) when a name is hard to match, such as a pond or a
          small watercourse. Resolves live via Nominatim + NRFA. You confirm the match before
          anything is screened.
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
            <p>
              <strong>Screening:</strong> {live.station.name} - NRFA gauging station {live.station.id}
              {live.station["catchment-area"] ? `, catchment area ${live.station["catchment-area"]} km²` : ""}.
            </p>
          )}
          <p>
            <strong>Inferred character:</strong> {CHARACTER_LABELS[live.characterInference.character]}{" "}
            (confidence: {live.characterInference.confidence})
          </p>
          <ul>
            {live.characterInference.reasoning.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="input-row">
        <label htmlFor="character-select">
          {live ? (
            <>Or override with an assumed solids character instead of the resolved site:</>
          ) : (
            <>No site confirmed yet - screen against an assumed solids character:</>
          )}
        </label>
        <select
          id="character-select"
          value={character}
          onChange={(e) => {
            setCharacter(e.target.value as ParticleCharacter);
            setSelectedCell(null);
            setFlow({ phase: "idle" });
          }}
        >
          {(Object.keys(CHARACTER_LABELS) as ParticleCharacter[]).map((c) => (
            <option key={c} value={c}>
              {CHARACTER_LABELS[c]}
            </option>
          ))}
        </select>
      </section>

      <section className={`window-banner ${report.usefulWindow ? "window-yes" : "window-no"}`}>
        {report.usefulWindow ? (
          <>
            <strong>Worth investigating:</strong> membrane ratings from{" "}
            {report.usefulWindow.fromPoreSizeUm} to {report.usefulWindow.toPoreSizeUm} µm.
          </>
        ) : (
          <>
            <strong>Not worth investigating yet</strong> at any membrane rating tested for this
            solids character.
          </>
        )}
      </section>

      <section>
        <h2>Which configurations work</h2>
        <p className="hint">Click a cell for the full reason behind that verdict.</p>
        <table className="grid">
          <thead>
            <tr>
              <th scope="col">Hydrocyclone</th>
              {membranes.map((m) => (
                <th scope="col" key={m.id}>
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hydrocyclones.map((h) => (
              <tr key={h.id}>
                <th scope="row">{h.name}</th>
                {membranes.map((m) => {
                  const cell = cellFor(h.id, m.id);
                  const style = VERDICT_STYLE[cell.verdict];
                  const isSelected =
                    selectedCell?.hydrocycloneId === h.id && selectedCell?.membraneId === m.id;
                  return (
                    <td key={m.id}>
                      <button
                        type="button"
                        className={`cell ${style.className} ${isSelected ? "cell-selected" : ""}`}
                        onClick={() => setSelectedCell(isSelected ? null : cell)}
                      >
                        <span className="cell-verdict">{style.label}</span>
                        <span className="cell-ratio">
                          {Number.isFinite(cell.volumeRatio) ? `${cell.volumeRatio.toFixed(2)}x` : "-"}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {selectedCell && (
        <section className="cell-detail">
          <h3>
            {hydrocyclones.find((h) => h.id === selectedCell.hydrocycloneId)?.name} +{" "}
            {membranes.find((m) => m.id === selectedCell.membraneId)?.label}
          </h3>
          <p>{selectedCell.reasoning}</p>
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
          <p>{report.verdict}</p>

          <h3>Why</h3>
          <p>{report.why}</p>

          <h3>What we know</h3>
          <ul>
            {report.whatWeKnow.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>

          <h3>What we don&apos;t know</h3>
          <ul>
            {report.whatWeDontKnow.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>

          <h3>Recommended test</h3>
          <p>{report.recommendedTest}</p>

          <h3>Every configuration tested</h3>
          <table className="config-list">
            <thead>
              <tr>
                <th>Hydrocyclone</th>
                <th>Membrane</th>
                <th>Verdict</th>
                <th>Volume ratio</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {report.configurations.map((c, i) => (
                <tr key={i}>
                  <td>{hydrocyclones.find((h) => h.id === c.hydrocycloneId)?.name}</td>
                  <td>{membranes.find((m) => m.id === c.membraneId)?.label}</td>
                  <td>{VERDICT_STYLE[c.verdict].label}</td>
                  <td>{Number.isFinite(c.volumeRatio) ? `${c.volumeRatio.toFixed(2)}x` : "-"}</td>
                  <td>{c.confidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="page-footer">
        Do not enter confidential or commercially sensitive information. Runs are logged to this
        repository.
      </footer>
    </main>
  );
}
