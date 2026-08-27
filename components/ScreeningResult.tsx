"use client";

import type { LogResult } from "@/lib/github-log";
import type { ScreeningClass, ScreeningReport } from "@/types";
import { ConfigurationMatrix } from "./ConfigurationMatrix";

const TONE: Record<ScreeningClass, string> = {
  promising: "positive",
  potentially_suitable: "positive",
  marginal: "caution",
  unlikely: "negative",
  insufficient_data: "neutral",
};

export function ScreeningResult({ report, log }: { report: ScreeningReport; log?: LogResult }) {
  const site = report.siteData;

  return (
    <>
      <section className="card" aria-labelledby="verdict-heading">
        <div className="section-label">Site screening</div>
        <h2 id="verdict-heading" style={{ marginBottom: "0.35rem" }}>
          {site.resolvedName ?? report.siteQuery}
        </h2>
        {site.resolvedName && site.resolvedName !== report.siteQuery ? (
          <p className="hint">Entered as “{report.siteQuery}”</p>
        ) : null}

        {!site.siteSpecific ? (
          <div className="banner banner--warn" role="alert">
            <strong>Not a site-specific result. </strong>
            No provider returned any measured or published datum for this location, and nothing
            was supplied about its solids, so what follows is the application’s default — it
            would come back identical for any other site. It shows how the method behaves, not
            what this site is like. Describe the water in the notes box, or paste a
            particle-size distribution, to get an assessment that is actually about this site.
          </div>
        ) : null}

        <div className="verdict">
          <span className="verdict-label">{report.overall.userLabel}</span>
          <span className={`pill pill--${TONE[report.overall.classification]}`}>
            {report.overall.classification.replace(/_/g, " ")}
          </span>
          <span className="pill pill--neutral">Confidence: {report.overall.confidence}</span>
        </div>

        <p>{report.overall.summary}</p>

        <details>
          <summary>What the solids were taken to be, and why</summary>
          <p className="row" style={{ marginBottom: "0.4rem" }}>
            <span className={`prov prov--${site.particleCharacterProvenance}`}>
              {site.particleCharacterProvenance}
            </span>
            <span className="pill pill--neutral">{site.particleCharacter}</span>
          </p>
          <p>{site.particleCharacterBasis}</p>
          <p className="hint" style={{ marginBottom: 0 }}>
            This is the single biggest lever in the whole assessment. If it is wrong, say so in
            the chat and the matrix will be re-run.
          </p>
        </details>

        {report.warnings.length > 0 ? (
          <div role="status">
            {report.warnings.map((w, i) => (
              <div className="banner banner--warn" key={i}>
                <strong>Read this before using the result: </strong>
                {w}
              </div>
            ))}
          </div>
        ) : null}

        {log && !log.ok ? (
          <div className="banner banner--info">
            <strong>Logging note (does not affect the assessment): </strong>
            {log.message}
          </div>
        ) : null}
      </section>

      <section className="card" aria-labelledby="window-heading">
        <div className="section-label">Useful membrane window</div>
        <h2 id="window-heading" style={{ marginBottom: "0.5rem" }}>
          {report.usefulWindow.lowerUm !== undefined
            ? `${report.usefulWindow.lowerUm} – ${report.usefulWindow.upperUm} µm`
            : "No useful window identified"}
        </h2>
        <p>{report.usefulWindow.statement}</p>
        <p className="hint" style={{ marginBottom: 0 }}>
          A coarser rating is not automatically a better one. This screening asks only whether
          pre-treatment helps at a given rating — it does not check that the rating meets the
          filtration duty your process actually requires.
        </p>
      </section>

      <ConfigurationMatrix report={report} />

      <section className="card" aria-labelledby="candidates-heading">
        <h2 id="candidates-heading">Candidates</h2>

        <CandidateList
          title="Best current options"
          empty="None of the screened combinations reached this level."
          items={report.best.map(
            (c) =>
              `${c.hydrocycloneName} + ${c.membraneLabel} — ${c.userLabel} (confidence ${c.confidence})`,
          )}
        />
        <CandidateList
          title="Borderline — worth testing if you have an operational reason"
          empty="None."
          items={report.borderline.map((c) => `${c.hydrocycloneName} + ${c.membraneLabel}`)}
        />
        <CandidateList
          title="Unlikely to provide useful benefit"
          empty="None."
          items={report.unlikely.map((c) => `${c.hydrocycloneName} + ${c.membraneLabel}`)}
        />
        <CandidateList
          title="Cannot be assessed — missing equipment data"
          empty="None; every catalogued unit had enough data to assess."
          items={report.missingData.map((c) => `${c.hydrocycloneName} + ${c.membraneLabel}`)}
        />
      </section>

      <section className="card" aria-labelledby="evidence-heading">
        <h2 id="evidence-heading">What this rests on</h2>
        <p className="hint">
          Everything the assessment used, separated by how it is known. Read the assumptions
          before you read the conclusions.
        </p>

        <Narrative title="Known" items={report.narrative.known} />
        <Narrative title="Published / sourced" items={report.narrative.published} />
        <Narrative title="Calculated" items={report.narrative.calculated} />
        <Narrative title="Inferred" items={report.narrative.inferred} />
        <Narrative title="Assumed" items={report.narrative.assumed} defaultOpen />

        <details open>
          <summary>What we don’t know</summary>
          <ul className="tight">
            {report.unknowns.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </details>

        <details>
          <summary>Particle-size distribution used</summary>
          {report.psdStatistics ? (
            <>
              <p className="row">
                <span className={`prov prov--${report.psdStatistics.provenance}`}>
                  {report.psdStatistics.provenance}
                </span>
                <span className="pill pill--neutral">
                  {report.psdStatistics.verified ? "verified" : "not verified"}
                </span>
              </p>
              <p>{report.psdStatistics.label}</p>
              <table className="data">
                <tbody>
                  <tr>
                    <th scope="row">D10 / D50 / D90</th>
                    <td>
                      {report.psdStatistics.d10Um} / {report.psdStatistics.d50Um} /{" "}
                      {report.psdStatistics.d90Um} µm
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Span</th>
                    <td>{report.psdStatistics.span}</td>
                  </tr>
                  <tr>
                    <th scope="row">Geometric std. dev.</th>
                    <td>{report.psdStatistics.geometricStdDev}</td>
                  </tr>
                </tbody>
              </table>
              <div className="section-label" style={{ marginTop: "0.9rem" }}>
                Size bands (% of mass)
              </div>
              <table className="data">
                <tbody>
                  {report.psdStatistics.bands
                    .filter((b) => b.massPercent > 0.05)
                    .map((b) => (
                      <tr key={b.label}>
                        <th scope="row">{b.label}</th>
                        <td>{b.massPercent} %</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <ul className="tight" style={{ marginTop: "0.9rem" }}>
                {report.psdStatistics.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>No distribution was available.</p>
          )}
        </details>

        <details>
          <summary>Sources and provenance ({report.sources.length})</summary>
          <div className="matrix-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Value</th>
                  <th>How known</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {report.sources.map((s, i) => (
                  <tr key={i}>
                    <th scope="row">{s.parameter}</th>
                    <td>
                      {String(s.value)}
                      {s.unit ? ` ${s.unit}` : ""}
                    </td>
                    <td>
                      <span className={`prov prov--${s.provenance}`}>{s.provenance}</span>
                    </td>
                    <td>
                      {s.sourceUrl ? (
                        <a href={s.sourceUrl} target="_blank" rel="noreferrer noopener">
                          {s.source ?? s.sourceUrl}
                        </a>
                      ) : (
                        (s.source ?? "—")
                      )}
                      {s.date ? ` (${s.date})` : ""}
                      {s.notes ? <div className="hint">{s.notes}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        <details>
          <summary>Data lookups performed ({site.providerReports.length})</summary>
          <table className="data">
            <tbody>
              {site.providerReports.map((p, i) => (
                <tr key={i}>
                  <th scope="row">{p.providerName}</th>
                  <td>
                    <span className="pill pill--neutral">{p.status}</span>
                  </td>
                  <td>
                    {p.message}
                    {p.sourceUrl ? (
                      <div className="hint">
                        <a href={p.sourceUrl} target="_blank" rel="noreferrer noopener">
                          {p.sourceUrl}
                        </a>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <section className="card" aria-labelledby="tree-heading">
        <h2 id="tree-heading">How the conclusion was reached</h2>
        <table className="data">
          <tbody>
            {report.decisionTree.map((s, i) => (
              <tr key={i}>
                <th scope="row" style={{ width: "34%" }}>
                  {s.question}
                </th>
                <td>
                  <div>{s.answer}</div>
                  <div className="hint" style={{ marginTop: "0.2rem" }}>
                    <span className={`prov prov--${s.provenance}`}>{s.provenance}</span> →{" "}
                    {s.consequence}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card" aria-labelledby="next-heading">
        <h2 id="next-heading">Recommended next steps</h2>
        <ol className="tight">
          {report.recommendedNextTests.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      </section>
    </>
  );
}

function CandidateList({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty: string;
}) {
  return (
    <>
      <div className="section-label" style={{ marginTop: "1rem" }}>
        {title}
      </div>
      {items.length ? (
        <ul className="tight">
          {items.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      ) : (
        <p className="hint">{empty}</p>
      )}
    </>
  );
}

function Narrative({
  title,
  items,
  defaultOpen,
}: {
  title: string;
  items: string[];
  defaultOpen?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <details open={defaultOpen}>
      <summary>
        {title} ({items.length})
      </summary>
      <ul className="tight">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </details>
  );
}
