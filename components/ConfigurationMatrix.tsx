"use client";

import { useState } from "react";
import type { ConfigurationAssessment, ScreeningClass, ScreeningReport } from "@/types";

const TONE: Record<ScreeningClass, string> = {
  promising: "positive",
  potentially_suitable: "positive",
  marginal: "caution",
  unlikely: "negative",
  insufficient_data: "neutral",
};

/** Short text shown in the cell so the matrix never relies on colour alone. */
const SHORT: Record<ScreeningClass, string> = {
  promising: "Promising",
  potentially_suitable: "Worth a look",
  marginal: "Marginal",
  unlikely: "Unlikely",
  insufficient_data: "No data",
};

function pct(v: number | undefined): string {
  return v === undefined ? "—" : `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)} %`;
}

/**
 * The key UI component. Rows are hydrocyclones, columns are membrane ratings,
 * and every cell opens the full engineering reasoning for that combination.
 */
export function ConfigurationMatrix({ report }: { report: ScreeningReport }) {
  const [selected, setSelected] = useState<ConfigurationAssessment | null>(null);

  const cellFor = (hId: string, mId: string) =>
    report.matrix.find((c) => c.hydrocycloneId === hId && c.membraneId === mId);

  return (
    <section className="card" aria-labelledby="matrix-heading">
      <h2 id="matrix-heading">Configuration screen</h2>

      <div className="matrix-scroll">
        <table className="matrix">
          <caption>
            Every hydrocyclone against every membrane rating. Select any cell for the reasoning
            behind it.
          </caption>
          <thead>
            <tr>
              <th className="rowhead" scope="col">
                Hydrocyclone
              </th>
              {report.membranes.map((m) => (
                <th key={m.id} scope="col">
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.hydrocyclones.map((h) => (
              <tr key={h.id}>
                <th className="rowhead" scope="row">
                  {h.name}
                </th>
                {report.membranes.map((m) => {
                  const cell = cellFor(h.id, m.id);
                  if (!cell) return <td key={m.id} />;
                  const isSel =
                    selected?.hydrocycloneId === h.id && selected?.membraneId === m.id;
                  return (
                    <td key={m.id}>
                      <button
                        type="button"
                        className={`cell-btn cell--${TONE[cell.classification]}`}
                        aria-pressed={isSel}
                        onClick={() => setSelected(isSel ? null : cell)}
                      >
                        <span className="cell-symbol" aria-hidden="true">
                          {cell.symbol}
                        </span>
                        <span className="cell-text">{SHORT[cell.classification]}</span>
                        <span className="sr-only">
                          {h.name} with a {m.label} membrane: {cell.userLabel}, confidence{" "}
                          {cell.confidence}. Select for detail.
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="legend">
        <span>✓ Promising / worth investigating</span>
        <span>? Marginal</span>
        <span>— Unlikely to help</span>
        <span>· Not enough data</span>
      </p>

      {selected ? <CellDetail cell={selected} /> : null}
    </section>
  );
}

function CellDetail({ cell }: { cell: ConfigurationAssessment }) {
  return (
    <div className="detail">
      <h3>
        {cell.hydrocycloneName} + {cell.membraneLabel} membrane
      </h3>
      <p className="row" style={{ marginBottom: "0.5rem" }}>
        <span className={`pill pill--${TONE[cell.classification]}`}>{cell.userLabel}</span>
        <span className="pill pill--neutral">Confidence: {cell.confidence}</span>
        {cell.metrics.cutSizeUm !== undefined ? (
          <span className={`prov prov--${cell.metrics.cutSizeProvenance}`}>
            cut size {cell.metrics.cutSizeUm} µm · {cell.metrics.cutSizeProvenance}
          </span>
        ) : null}
      </p>

      <div className="metrics">
        <div className="metric">
          <div className="metric-value">{pct(cell.metrics.membraneLoadFraction)}</div>
          <div className="metric-label">
            of feed solids mass the membrane would have to retain, untreated
          </div>
        </div>
        <div className="metric">
          <div className="metric-value">{pct(cell.metrics.cycloneRemovalOfLoad)}</div>
          <div className="metric-label">of that retained mass the cyclone could remove first</div>
        </div>
        <div className="metric">
          <div className="metric-value">{pct(cell.metrics.foulingReliefFraction)}</div>
          <div className="metric-label">
            of the resistance-weighted fouling load removed — the figure that decides this cell
          </div>
        </div>
        <div className="metric">
          <div className="metric-value">{pct(cell.metrics.overallSolidsRemoval)}</div>
          <div className="metric-label">of total feed solids removed by the cyclone</div>
        </div>
      </div>

      <div className="section-label">Why</div>
      <ul className="tight">
        {cell.reasoning.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>

      <div className="section-label">Main uncertainty</div>
      <p>{cell.mainUncertainty}</p>

      <details>
        <summary>Assumptions this cell rests on</summary>
        <ul className="tight">
          {cell.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </details>

      <details>
        <summary>Hydraulic compatibility</summary>
        <p>
          <span className="pill pill--neutral">{cell.hydraulic.status}</span>
        </p>
        <p>{cell.hydraulic.note}</p>
      </details>

      <details>
        <summary>Limitations of this result</summary>
        <ul className="tight">
          {cell.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
